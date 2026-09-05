import { afterEach, describe, expect, test } from 'vitest';
import {
  claimDirectorWriter,
  directorWriterChannelName,
  type DirectorWriterClaim,
} from './DirectorWriterClaim';

const claims: DirectorWriterClaim[] = [];

afterEach(() => {
  for (const claim of claims.splice(0)) claim.release();
});

const claim = (tournamentId: string, documentId: string, tabId: string) =>
  claimDirectorWriter({
    tournamentId,
    documentId,
    tabId,
    locks: null,
    responseTimeoutMs: 15,
    heartbeatMs: 30,
  }).then((value) => {
    claims.push(value);
    return value;
  });

describe('Director writer claims', () => {
  test('uses Web Locks when available and releases for a later writer', async () => {
    const holders = new Set<string>();
    const locks = {
      request: async (
        name: string,
        _options: { ifAvailable: true },
        callback: (lock: { name: string } | null) => Promise<void> | void,
      ) => {
        if (holders.has(name)) {
          await callback(null);
          return;
        }
        holders.add(name);
        await callback({ name });
        holders.delete(name);
      },
    };

    const first = await claimDirectorWriter({
      tournamentId: 'tournament-a',
      documentId: 'document-a',
      tabId: 'first',
      locks,
      channel: null,
    });
    claims.push(first);
    const second = await claimDirectorWriter({
      tournamentId: 'tournament-a',
      documentId: 'document-a',
      tabId: 'second',
      locks,
      channel: null,
    });
    expect(first).toMatchObject({ held: true, mode: 'web-lock' });
    expect(second).toMatchObject({ held: false, mode: 'web-lock' });

    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterRelease = await claimDirectorWriter({
      tournamentId: 'tournament-a',
      documentId: 'document-a',
      tabId: 'second',
      locks,
      channel: null,
    });
    claims.push(afterRelease);
    expect(afterRelease).toMatchObject({ held: true, mode: 'web-lock' });
  });

  test('holds one fallback claim and makes a live secondary read-only', async () => {
    const first = await claim('tournament-a', 'document-a', 'first');
    const second = await claim('tournament-a', 'document-a', 'second');
    expect(first).toMatchObject({ held: true, mode: 'broadcast-channel' });
    expect(second).toMatchObject({ held: false, mode: 'broadcast-channel' });
    expect(first.lost.aborted).toBe(false);
  });

  test('reclaims a fallback claim after the holder stops responding', async () => {
    const holderChannel = new BroadcastChannel(directorWriterChannelName('tournament-a', 'document-a'));
    const first = await claimDirectorWriter({
      tournamentId: 'tournament-a',
      documentId: 'document-a',
      tabId: 'first',
      locks: null,
      channel: holderChannel,
      responseTimeoutMs: 15,
      heartbeatMs: 30,
    });
    claims.push(first);
    expect(first.held).toBe(true);
    // A crashed tab does not run release; closing its channel models the holder disappearing.
    holderChannel.close();
    const replacement = await claim('tournament-a', 'document-a', 'replacement');
    expect(replacement).toMatchObject({ held: true, mode: 'broadcast-channel' });
  });

  test('simultaneous contenders converge on one deterministic fallback holder', async () => {
    const [higher, lower] = await Promise.all([
      claim('tournament-a', 'document-a', 'zeta'),
      claim('tournament-a', 'document-a', 'alpha'),
    ]);
    expect(lower.held).toBe(true);
    expect(higher.held).toBe(false);
  });

  test('unrelated tournament/document scopes do not conflict', async () => {
    const first = await claim('tournament-a', 'document-a', 'first');
    const differentTournament = await claim('tournament-b', 'document-a', 'second');
    const differentDocument = await claim('tournament-a', 'document-b', 'third');
    expect(first.held).toBe(true);
    expect(differentTournament.held).toBe(true);
    expect(differentDocument.held).toBe(true);
  });

  test('fails closed when browser coordination is unavailable', async () => {
    const result = await claimDirectorWriter({
      tournamentId: 'tournament-a',
      documentId: 'document-a',
      locks: null,
      channel: null,
    });
    expect(result).toMatchObject({ held: false, mode: 'unavailable' });
  });
});
