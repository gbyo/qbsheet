/**
 * Idempotent mirror publication (#1004): a retry of one logical publication carries one key,
 * so the relay can tell "the same request twice" from "a conflicting publication".
 *
 * One publication, one key, minted by the Director that built it. A retry that lost its receipt
 * replays the stored position without touching rooms; a different key at the same position is
 * a conflict; and a control transfer clears the key so a stale controller's replay can never be
 * mistaken for the new epoch's publication.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const base = 'https://relay.example/qbtcp/v1';
const TOURNAMENT_ALPHABET = '0123456789bcdfghjklmnpqrstvwxyz';

let tournamentCounter = 900_000;
function freshTournamentId(): string {
  tournamentCounter += 1;
  let id = '';
  let n = tournamentCounter * 7919 + 13;
  for (let index = 0; index < 24; index += 1) {
    n = (n * 31 + 7) % 9973;
    id += TOURNAMENT_ALPHABET[n % TOURNAMENT_ALPHABET.length];
  }
  return id;
}

function manageBase(tournamentId: string): string {
  return `${base}/manage/tournaments/${tournamentId}`;
}

function manageHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function claimTournament(tournamentId: string): Promise<string> {
  const claim = (await (
    await SELF.fetch(`${base}/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'test-setup-token', tournamentId }),
    })
  ).json()) as { managementToken: string };
  return claim.managementToken;
}

async function mirrorBody(matchId: string, extra: Record<string, unknown> = {}) {
  return {
    director_epoch: 1,
    revision: 1,
    rooms: [
      {
        room_id: 'idem-room',
        name: 'Idem Room',
        pairing_code_hash: await sha256Hex('12345678'),
        assignment_qbj: { type: 'Match', id: matchId },
        match_id: matchId,
        assignment_revision: 1,
      },
    ],
    sessions: [],
    ...extra,
  };
}

async function putMirror(tournamentId: string, token: string, body: unknown) {
  const response = await SELF.fetch(`${manageBase(tournamentId)}/mirror`, {
    method: 'PUT',
    headers: manageHeaders(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function mirrorHealth(tournamentId: string, token: string) {
  const response = await SELF.fetch(`${manageBase(tournamentId)}/health`, {
    headers: manageHeaders(token),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    mirror: { director_epoch: number; revision: number; last_mirror_key: string | null };
  };
}

async function assignmentEventCount(tournamentId: string, token: string): Promise<number> {
  const response = await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=128`, {
    headers: manageHeaders(token),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { events: { kind: string }[] };
  return body.events.filter((event) => event.kind === 'assignment').length;
}

describe('idempotent mirror publication', () => {
  it('replays a same-key retry from the stored position without touching rooms', async () => {
    const tournamentId = freshTournamentId();
    const management = await claimTournament(tournamentId);

    const first = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 'key-one',
      }),
    );
    expect(first.status).toBe(200);
    expect(first.json.duplicate).not.toBe(true);
    const eventsAfterFirst = await assignmentEventCount(tournamentId, management);
    expect(eventsAfterFirst).toBeGreaterThan(0);

    // The receipt was lost, so the Director retries — and the retry even carries different
    // room content, proving the stored position wins over the repeated bytes.
    const retry = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-two', {
        idempotency_key: 'key-one',
      }),
    );
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ revision: 1, duplicate: true });

    // Nothing moved: same revision, same key, no new assignment events.
    const health = await mirrorHealth(tournamentId, management);
    expect(health.mirror).toMatchObject({ director_epoch: 1, revision: 1, last_mirror_key: 'key-one' });
    expect(await assignmentEventCount(tournamentId, management)).toBe(eventsAfterFirst);
  });

  it('refuses a different key at the same position as a conflict', async () => {
    const tournamentId = freshTournamentId();
    const management = await claimTournament(tournamentId);

    const first = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 'key-one',
      }),
    );
    expect(first.status).toBe(200);

    const conflict = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 'key-two',
      }),
    );
    expect(conflict.status).toBe(409);
  });

  it('accepts keyless publications from older Directors and stores no key', async () => {
    const tournamentId = freshTournamentId();
    const management = await claimTournament(tournamentId);

    const first = await putMirror(tournamentId, management, await mirrorBody('match-one'));
    expect(first.status).toBe(200);

    const health = await mirrorHealth(tournamentId, management);
    expect(health.mirror).toMatchObject({ revision: 1, last_mirror_key: null });
  });

  it('rejects a malformed key before anything is written', async () => {
    const tournamentId = freshTournamentId();
    const management = await claimTournament(tournamentId);

    const rejected = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 123,
      }),
    );
    expect(rejected.status).toBe(400);

    const health = await mirrorHealth(tournamentId, management);
    expect(health.mirror.revision).toBe(0);
  });

  it('clears the key on takeover so a stale publication cannot replay', async () => {
    const tournamentId = freshTournamentId();
    const management = await claimTournament(tournamentId);

    const first = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 'key-one',
      }),
    );
    expect(first.status).toBe(200);

    const provisioned = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/backup/provision`, {
        method: 'POST',
        headers: manageHeaders(management),
        body: JSON.stringify({ label: 'backup laptop' }),
      })
    ).json()) as { backupToken: string };
    const takeover = await SELF.fetch(`${manageBase(tournamentId)}/takeover`, {
      method: 'POST',
      headers: manageHeaders(provisioned.backupToken),
      body: JSON.stringify({ takeover_id: 'takeover-one' }),
    });
    expect(takeover.status).toBe(200);

    // The new epoch starts with no key: the old controller's replay is stale, never a duplicate.
    const health = await mirrorHealth(tournamentId, management);
    expect(health.mirror).toMatchObject({
      director_epoch: 2,
      revision: 0,
      last_mirror_key: null,
    });
    const replay = await putMirror(
      tournamentId,
      management,
      await mirrorBody('match-one', {
        idempotency_key: 'key-one',
      }),
    );
    expect(replay.status).toBe(409);
  });
});
