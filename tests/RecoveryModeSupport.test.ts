import { describe, expect, test } from 'vitest';
import { memoryGameStore } from '../src/game/GameStore';
import { createQbsheetBackup, serializeQbsheetBackup } from '../src/scorer/QBSheetBackup';
import { gameSessionVersion, loadGame } from '../src/scorer/GameSession';
import {
  buildRecoveryGames,
  chooseSafestRecoveryCandidate,
  inspectJournal,
  loadRecoverySources,
  parseRecoveryFileText,
  restoreBackupAsSeparateAttempt,
} from '../src/app/RecoveryModeSupport';
import { inspectJournals, summarizeJournalRecovery } from '../src/app/RecoveryJournal';
import { makeRecoveryCheckpoint } from '../src/recovery/RecoveryCheckpoints';
import { MemoryRecoveryStore, recoverySettings } from '../src/recovery/RecoveryStore';
import type { IRecoveryDirectoryHandle, IRecoveryFileHandle } from '../src/recovery/RecoveryTypes';
import { validPackage } from './packages';

const now = new Date('2026-08-20T14:00:00.000Z');
const gamePackage = validPackage();
const setup = {
  left: { name: gamePackage.left.name, players: gamePackage.left.players.map((player) => player.name) },
  right: { name: gamePackage.right.name, players: gamePackage.right.players.map((player) => player.name) },
};
const events = [{ id: 'dead-17', type: 'tossup-dead' as const, questionNumber: 17 }];

function journal(gameKey = 'session-a', updatedAt = now.toISOString()): string {
  return JSON.stringify({ version: gameSessionVersion, gameKey, setup, events, updatedAt });
}

describe('Recovery Mode journal inspection', () => {
  test('distinguishes valid, stale, unsupported, and malformed raw entries', () => {
    expect(inspectJournal('valid', journal('valid'), now).status).toBe('valid');
    expect(
      inspectJournal(
        'stale',
        journal('stale', new Date(now.getTime() - 36 * 60 * 60 * 1000 - 1).toISOString()),
        now,
      ).status,
    ).toBe('stale');
    expect(
      inspectJournal(
        'future',
        JSON.stringify({ ...JSON.parse(journal('future')), version: gameSessionVersion + 1 }),
        now,
      ).status,
    ).toBe('unsupported');
    expect(inspectJournal('broken', '{not json', now).status).toBe('malformed');
  });

  test('summarizes the newest valid journal without hiding raw unverified entries', () => {
    const entries = inspectJournals(
      {
        old: journal('old', new Date(now.getTime() - 10_000).toISOString()),
        newest: journal('newest', now.toISOString()),
        broken: '{not json',
      },
      now,
    );

    const summary = summarizeJournalRecovery(entries);
    expect(summary).toMatchObject({ kind: 'valid', questionNumber: 17 });
    if (summary.kind === 'valid') expect(summary.latest.gameKey).toBe('newest');
  });
});

describe('Recovery Mode source comparison', () => {
  test('keeps a valid instant journal ahead of a newer durable timestamp', () => {
    const chosen = chooseSafestRecoveryCandidate([
      { kind: 'durable', status: 'valid', exact: true, updatedAt: now.toISOString() },
      {
        kind: 'journal',
        status: 'valid',
        exact: true,
        updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      },
    ]);
    expect(chosen?.kind).toBe('journal');
  });

  test('uses the newest exact local mirror when no journal is usable', () => {
    const chosen = chooseSafestRecoveryCandidate([
      { kind: 'journal', status: 'malformed', exact: false, updatedAt: now.toISOString() },
      {
        kind: 'durable',
        status: 'valid',
        exact: true,
        updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      },
      { kind: 'durable', status: 'valid', exact: true, updatedAt: now.toISOString() },
    ]);
    expect(chosen?.updatedAt).toBe(now.toISOString());
  });

  test('does not expose a raw game key as the human-readable unmatched label', () => {
    const games = buildRecoveryGames(inspectJournals({ 'secretish-key': journal('secretish-key') }, now), []);
    expect(games[0].label).toBe('Saved game on this device');
    expect(games[0].matchup).not.toContain('secretish-key');
  });

  test('shows a missing journal beside a durable game copy', () => {
    const record = {
      version: 1,
      id: 'record-1',
      identity: 'match:sched-101',
      attempt: 1,
      gameKey: 'session-a',
      package: gamePackage,
      setup,
      events,
      connected: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      serverDelivery: 'none' as const,
    };
    const game = buildRecoveryGames([], [record])[0];
    expect(game.sources).toEqual([
      expect.objectContaining({ kind: 'journal', status: 'missing' }),
      expect.objectContaining({ kind: 'durable', status: 'valid' }),
    ]);
    expect(game.resumeSource).toBe('durable');
  });

  test('inspects checkpoints and an external backup without creating or requesting access', async () => {
    const store = memoryGameStore();
    await store.create({ package: gamePackage, setup, connected: false, gameKey: 'session-a', now });
    const recoveryStore = new MemoryRecoveryStore();
    await recoveryStore.saveCheckpoint(
      makeRecoveryCheckpoint({
        id: 'checkpoint-old',
        gameKey: 'session-a',
        capturedAt: new Date(now.getTime() - 42_000).toISOString(),
        backup: createQbsheetBackup({ gamePackage, setup, events }),
        progressLabel: 'Tossup 17',
      }),
    );
    const externalText = serializeQbsheetBackup(createQbsheetBackup({ gamePackage, setup, events }));
    let requestedCreate: boolean | undefined;
    const file: IRecoveryFileHandle = {
      name: 'external.qbsheet',
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
      getFile: async () => ({
        size: externalText.length,
        lastModified: now.getTime() - 9_000,
        text: async () => externalText,
      }),
    };
    const directory: IRecoveryDirectoryHandle = {
      name: 'Backups',
      queryPermission: async () => 'granted',
      getFileHandle: async (_name, options) => {
        requestedCreate = options?.create;
        return file;
      },
    };
    await recoveryStore.putSettings(recoverySettings(directory, now));
    await recoveryStore.putFilenameMapping({
      id: 'session-a',
      gameKey: 'session-a',
      fileName: 'external.qbsheet',
      baseFileName: 'external.qbsheet',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const snapshot = await loadRecoverySources({
      now,
      readJournals: () => ({ 'session-a': '{broken' }),
      openStore: async () => store,
      openRecoveryStore: async () => recoveryStore,
      externalEnvironment: { showDirectoryPicker: async () => directory },
    });
    const sources = snapshot.games[0]?.sources ?? [];
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'journal', status: 'malformed' }),
        expect.objectContaining({ kind: 'durable', status: 'valid' }),
        expect.objectContaining({ kind: 'checkpoint', status: 'valid', progressLabel: 'Tossup 17' }),
        expect.objectContaining({ kind: 'external', status: 'valid', backup: expect.any(Object) }),
      ]),
    );
    expect(snapshot.externalBackup?.state).toBe('ready');
    expect(requestedCreate).toBe(false);
  });
});

describe('Recovery Mode backup restore', () => {
  test('parses the existing exact QBSheet backup envelope', () => {
    const serialized = serializeQbsheetBackup(createQbsheetBackup({ gamePackage, setup, events: [] }));
    expect(parseRecoveryFileText(serialized)).toMatchObject({ ok: true, backup: { events: [] } });
    expect(parseRecoveryFileText('{not json')).toEqual({
      ok: false,
      errors: ['That file is not readable as JSON.'],
    });
  });

  test('restores as a new attempt and leaves an active local attempt untouched', async () => {
    const store = memoryGameStore();
    await store.create({ package: gamePackage, setup, connected: false, now });
    const backup = createQbsheetBackup({ gamePackage, setup, events });

    const result = await restoreBackupAsSeparateAttempt(backup, store, now);

    expect(result).toMatchObject({ ok: true, restoringAlongsideActive: true, journalSaved: true });
    if (!result.ok) return;
    expect(result.record.attempt).toBe(2);
    expect((await store.findByIdentity('match:sched-101')).map((item) => item.attempt)).toEqual([2, 1]);
    expect(loadGame(result.record.gameKey, now)?.events).toEqual(events);
  });
});
