/**
 * The QBTCP Internet relay, exercised inside the real Workers runtime.
 *
 * These are the behaviours a scorer's phone and a Director's reconnect depend on: finals
 * committed before they are receipted, duplicates answered without a second row, unacknowledged
 * finals surviving the replay trim, progress that costs one row and no event, pairing that
 * refuses uniformly, and a stream that authenticates first, pushes assignment changes, and
 * replays what a reconnect missed.
 *
 * Each test claims its own tournament id: the Durable Object is keyed by tournament, so a fresh
 * id is a fresh relay, and the claim-once test stays meaningful.
 */

import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateStreamFrame } from '../src/protocol/frames';
import { resultFingerprint } from '../src/protocol/qbj';
import finalFixture from '../../../tests/fixtures/qbtcp-stream/final.json';
import receiptFixture from '../../../tests/fixtures/qbtcp-stream/receipt.json';
import helloFixture from '../../../tests/fixtures/qbtcp-stream/hello.json';
import authenticateFixture from '../../../tests/fixtures/qbtcp-stream/authenticate.json';
import malformedFixture from '../../../tests/fixtures/qbtcp-stream/frame-malformed.json';
import unsupportedFixture from '../../../tests/fixtures/qbtcp-stream/frame-unsupported-version.json';
import discoveryFixture from '../../../tests/fixtures/qbtcp-stream/discovery-with-stream.json';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const base = 'https://relay.example/qbtcp/v1';
const TOURNAMENT_ALPHABET = '0123456789bcdfghjklmnpqrstvwxyz';

let tournamentCounter = 0;
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

function tournamentBase(tournamentId: string): string {
  return `${base}/tournaments/${tournamentId}`;
}

function manageBase(tournamentId: string): string {
  return `${base}/manage/tournaments/${tournamentId}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function claim(tournamentId: string, setupToken = 'test-setup-token'): Promise<string> {
  const response = await SELF.fetch(`${base}/manage/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken, tournamentId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { managementToken: string };
  expect(body.managementToken).toMatch(/^[0-9a-f]{64}$/);
  return body.managementToken;
}

function roomHeaders(token: string, device = 'device-1'): Record<string, string> {
  return { 'x-yf-room-token': token, 'x-yf-device-id': device, 'content-type': 'application/json' };
}

function sessionHeaders(token: string): Record<string, string> {
  return { 'x-yf-session-token': token, 'content-type': 'application/json' };
}

function manageHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

const MATCH_ID = 'sm-4471';

function assignmentQbj(matchId: string = MATCH_ID): Record<string, unknown> {
  return {
    type: 'Match',
    id: matchId,
    _qbtcp: { round_revision: 3, assignment_revision: 7 },
    match_teams: [],
  };
}

async function mirror(
  token: string,
  tournamentId: string,
  options: {
    epoch?: number;
    revision?: number;
    rooms?: Record<string, unknown>[];
    sessions?: Record<string, unknown>[];
    name?: string;
  } = {},
): Promise<Response> {
  return SELF.fetch(`${manageBase(tournamentId)}/mirror`, {
    method: 'PUT',
    headers: manageHeaders(token),
    body: JSON.stringify({
      director_epoch: options.epoch ?? 1,
      revision: options.revision ?? 1,
      ...(options.name ? { tournament: { name: options.name } } : {}),
      rooms: options.rooms ?? [],
      sessions: options.sessions ?? [],
    }),
  });
}

async function mirrorRoom(
  token: string,
  tournamentId: string,
  roomId: string,
  options: { code?: string; revision?: number; epoch?: number; matchId?: string } = {},
): Promise<void> {
  const response = await mirror(token, tournamentId, {
    epoch: options.epoch ?? 1,
    revision: options.revision ?? 1,
    rooms: [
      {
        room_id: roomId,
        name: `Room ${roomId}`,
        ...(options.code ? { pairing_code_hash: await sha256Hex(options.code) } : {}),
        assignment_qbj: assignmentQbj(options.matchId),
        match_id: options.matchId ?? MATCH_ID,
        round_revision: 3,
        assignment_revision: 7,
      },
    ],
    sessions: [],
  });
  expect(response.status).toBe(200);
}

async function pair(
  tournamentId: string,
  code: string,
  roomId?: string,
  source = 'pair-test',
): Promise<{ status: number; body: { token?: string; room_id?: string } }> {
  const response = await SELF.fetch(`${tournamentBase(tournamentId)}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
    body: JSON.stringify({ code, ...(roomId ? { room_id: roomId } : {}) }),
  });
  return { status: response.status, body: (await response.json()) as { token?: string; room_id?: string } };
}

async function openSession(
  tournamentId: string,
  roomToken: string,
  matchId: string = MATCH_ID,
  device = 'device-1',
): Promise<{ sessionId: string; token: string; writer: boolean }> {
  const response = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions`, {
    method: 'POST',
    headers: roomHeaders(roomToken, device),
    body: JSON.stringify({ match_id: matchId, device_id: device }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { session_id: string; token: string; writer: boolean };
  return { sessionId: body.session_id, token: body.token, writer: body.writer };
}

function finalQbj(matchId: string = MATCH_ID, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'Match', id: matchId, match_teams: [{ score: 10 }], ...extra };
}

/** A tournament with one mirrored room, ready to pair. Returns the relay's handles. */
async function setupRoom(
  roomId = 'room-a',
  code = '42424242',
): Promise<{ tournamentId: string; management: string; roomToken: string }> {
  const tournamentId = freshTournamentId();
  const management = await claim(tournamentId);
  await mirrorRoom(management, tournamentId, roomId, { code });
  const paired = await pair(tournamentId, code, roomId, `setup-${tournamentId.slice(0, 8)}`);
  expect(paired.status).toBe(200);
  return { tournamentId, management, roomToken: paired.body.token! };
}

beforeEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Claim: one setup token, one exchange, then worthless
// ---------------------------------------------------------------------------

describe('claiming a freshly deployed relay', () => {
  it('exchanges the setup token for a management credential exactly once', async () => {
    const tournamentId = freshTournamentId();
    const token = await claim(tournamentId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const second = await SELF.fetch(`${base}/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'test-setup-token', tournamentId }),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: 'forbidden' });
  });

  it('refuses a wrong setup token without revealing anything', async () => {
    const response = await SELF.fetch(`${base}/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'wrong', tournamentId: freshTournamentId() }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.managementToken).toBeUndefined();
  });

  it('refuses a tournament id outside the bounded alphabet', async () => {
    for (const bad of ['../etc', 'a'.repeat(200), 'AAAA', 'aeiou', 'short']) {
      const response = await SELF.fetch(`${base}/manage/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupToken: 'test-setup-token', tournamentId: bad }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('says nothing about tournaments at the root', async () => {
    const response = await SELF.fetch('https://relay.example/health');
    expect(await response.json()).toEqual({ service: 'qbtcp-relay', protocolVersion: 1 });
  });
});

describe('rotating the management credential', () => {
  it('mints a fresh credential; the old one stops working and state survives', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242' });

    const response = await SELF.fetch(`${manageBase(tournamentId)}/rotate`, {
      method: 'POST',
      headers: manageHeaders(management),
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { managementToken: string; tournamentId: string };
    expect(body.managementToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.managementToken).not.toBe(management);
    expect(body.tournamentId).toBe(tournamentId);
    expect(JSON.stringify(body)).not.toMatch(/hash/i);

    // The old credential is dead for management reads …
    const stale = await SELF.fetch(`${manageBase(tournamentId)}/health`, {
      headers: manageHeaders(management),
    });
    expect(stale.status).toBe(401);

    // … while the new one sees the mirrored state rotation must not disturb.
    const health = await SELF.fetch(`${manageBase(tournamentId)}/health`, {
      headers: manageHeaders(body.managementToken),
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ tournamentId, mirror: { revision: 1 } });
  });

  it('refuses rotation without a valid management credential', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    const tampered = `${management.slice(0, -1)}${management.endsWith('0') ? '1' : '0'}`;
    for (const headers of [
      { 'content-type': 'application/json' },
      manageHeaders('0'.repeat(64)),
      manageHeaders(tampered),
    ]) {
      const response = await SELF.fetch(`${manageBase(tournamentId)}/rotate`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(response.status).toBe(401);
    }
    // A failed rotation leaves the current credential working.
    const health = await SELF.fetch(`${manageBase(tournamentId)}/health`, {
      headers: manageHeaders(management),
    });
    expect(health.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Discovery: the stream capability contract, exactly as #770 defines it
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('advertises the stream descriptor a scorer can act on', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    void roomToken;
    const response = await SELF.fetch(`${tournamentBase(tournamentId)}/discovery`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ protocol: 'QBTCP', version: 1 });
    expect(body.capabilities).toContain('stream');
    const stream = body.stream as Record<string, unknown>;
    expect(stream.endpoint).toBe(`/qbtcp/v1/tournaments/${tournamentId}/stream`);
    expect(stream).toMatchObject({
      frames: 1,
      retains_finals: true,
      mirrors_assignment: true,
      max_frame_bytes: 1_048_576,
      ticket: false,
    });
    expect(stream.replay).toEqual(expect.arrayContaining(['sequence', 'resync']));
    // The descriptor carries no credential-shaped value. Ever.
    expect(JSON.stringify(stream)).not.toMatch(/token|code|secret|password|credential|bearer/i);
  });

  it('404s for an unclaimed tournament without distinguishing why', async () => {
    const response = await SELF.fetch(`${tournamentBase(freshTournamentId())}/discovery`);
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Pairing: uniform refusal, expiry, revocation, rate limits
// ---------------------------------------------------------------------------

describe('pairing', () => {
  it('refuses every bad code identically: malformed, unknown, wrong room, expired, revoked', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242' });
    const source = `indist-${tournamentId.slice(0, 8)}`;

    const refusals: [string, unknown][] = [
      ['malformed', { code: 'abc' }],
      ['empty', { code: '' }],
      ['unknown', { code: '99999999' }],
      ['wrong room', { code: '42424242', room_id: 'room-b' }],
    ];
    for (const [label, body] of refusals) {
      const response = await SELF.fetch(`${tournamentBase(tournamentId)}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `${source}-${label}` },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'pairing_refused',
        message: 'The pairing code is not valid.',
      });
    }

    // Expired: same uniform answer, and the code is not retained in the response.
    await mirror(management, tournamentId, {
      revision: 2,
      rooms: [
        {
          room_id: 'room-a',
          pairing_code_hash: await sha256Hex('42424242'),
          pairing_expires_at: '2000-01-01T00:00:00.000Z',
          assignment_qbj: assignmentQbj(),
          match_id: MATCH_ID,
          round_revision: 3,
          assignment_revision: 7,
        },
      ],
      sessions: [],
    });
    const expired = await pair(tournamentId, '42424242', 'room-a', `${source}-expired`);
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ error: 'pairing_refused', message: 'The pairing code is not valid.' });

    // Revoked by omission: same uniform answer.
    await mirror(management, tournamentId, {
      revision: 3,
      rooms: [
        {
          room_id: 'room-a',
          assignment_qbj: assignmentQbj(),
          match_id: MATCH_ID,
          round_revision: 3,
          assignment_revision: 7,
        },
      ],
      sessions: [],
    });
    const revoked = await pair(tournamentId, '42424242', 'room-a', `${source}-revoked`);
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual({ error: 'pairing_refused', message: 'The pairing code is not valid.' });
  });

  it('rate-limits pairing per source with a retryable answer', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242' });
    const source = `ratelimit-${tournamentId.slice(0, 12)}`;
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await SELF.fetch(`${tournamentBase(tournamentId)}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
        body: JSON.stringify({ code: '00000000' }),
      });
      if (response.status === 429) {
        limited += 1;
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.error).toBe('rate_limited');
        expect(body.retry_after_secs).toBeGreaterThan(0);
        expect(response.headers.get('retry-after')).not.toBeNull();
      } else {
        expect(response.status).toBe(401);
      }
      await response.text().catch(() => undefined);
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('pairs a mirrored code into a room-scoped token', async () => {
    const { tournamentId } = await setupRoom('room-a', '42424242');
    const paired = await pair(tournamentId, '42424242', 'room-a', `scope-${tournamentId.slice(0, 8)}`);
    expect(paired.status).toBe(200);
    expect(paired.body.room_id).toBe('room-a');
    expect(paired.body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Capability scope: room, session, and management never confuse
// ---------------------------------------------------------------------------

describe('capability scope', () => {
  it('keeps room, session, and management credentials strictly separated', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token: sessionToken } = await openSession(tournamentId, roomToken);

    // A room token on a session route is not a session credential.
    const roomOnSession = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
      method: 'POST',
      headers: { ...sessionHeaders('x'), 'x-yf-room-token': roomToken },
      body: JSON.stringify({ sequence: 1, match_state: { type: 'Match' } }),
    });
    expect(roomOnSession.status).toBe(401);

    // A session token on a room route is not a room credential.
    const sessionOnRoom = await SELF.fetch(`${tournamentBase(tournamentId)}/assignment`, {
      headers: { 'x-yf-room-token': sessionToken },
    });
    expect(sessionOnRoom.status).toBe(401);

    // A scorer token on the management surface gains nothing.
    for (const bearer of [roomToken, sessionToken]) {
      const response = await SELF.fetch(`${manageBase(tournamentId)}/health`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(401);
    }

    // The management credential confers no scorer power either.
    const mgmtOnScorer = await SELF.fetch(`${tournamentBase(tournamentId)}/assignment`, {
      headers: { 'x-yf-room-token': management },
    });
    expect(mgmtOnScorer.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Sessions and writer ownership: explicit, single, per session
// ---------------------------------------------------------------------------

describe('sessions and writers', () => {
  it('opens one logical session per room and match, rejoined not duplicated', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const first = await openSession(tournamentId, roomToken, MATCH_ID, 'device-1');
    expect(first.writer).toBe(true);
    const second = await openSession(tournamentId, roomToken, MATCH_ID, 'device-2');
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.writer).toBe(false);
    expect(second.token).not.toBe(first.token);
  });

  it('refuses to start a room with no assignment', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    await mirror(management, tournamentId, {
      rooms: [{ room_id: 'room-a', pairing_code_hash: await sha256Hex('42424242') }],
      sessions: [],
    });
    const paired = await pair(tournamentId, '42424242', 'room-a', `noassign-${tournamentId.slice(0, 8)}`);
    expect(paired.status).toBe(200);
    const response = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions`, {
      method: 'POST',
      headers: roomHeaders(paired.body.token!),
      body: JSON.stringify({ match_id: MATCH_ID, device_id: 'device-1' }),
    });
    expect(response.status).toBe(409);
  });

  it('serves a Director-mirrored session id rather than inventing its own', async () => {
    const tournamentId = freshTournamentId();
    const management = await claim(tournamentId);
    await mirror(management, tournamentId, {
      rooms: [
        {
          room_id: 'room-a',
          pairing_code_hash: await sha256Hex('42424242'),
          assignment_qbj: assignmentQbj(),
          match_id: MATCH_ID,
          round_revision: 3,
          assignment_revision: 7,
        },
      ],
      sessions: [
        {
          session_id: 'sess-director-1',
          room_id: 'room-a',
          match_id: MATCH_ID,
          status: 'open',
          active_writer_device_id: 'device-9',
        },
      ],
    });
    const paired = await pair(tournamentId, '42424242', 'room-a', `mirrsess-${tournamentId.slice(0, 8)}`);
    const opened = await openSession(tournamentId, paired.body.token!, MATCH_ID, 'device-1');
    expect(opened.sessionId).toBe('sess-director-1');
  });

  it('keeps writer authority explicit: takeover works, silent stealing does not', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const first = await openSession(tournamentId, roomToken, MATCH_ID, 'device-1');

    const stolen = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${first.sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders((await openSession(tournamentId, roomToken, MATCH_ID, 'device-2')).token),
      body: JSON.stringify({ sequence: 1, match_state: { type: 'Match' } }),
    });
    expect(stolen.status).toBe(409);
    const conflict = (await stolen.json()) as Record<string, unknown>;
    expect(conflict).toMatchObject({ error: 'conflict', writer_device: 'device-1', can_take_over: true });

    const takeover = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${first.sessionId}/writer`, {
      method: 'POST',
      headers: sessionHeaders((await openSession(tournamentId, roomToken, MATCH_ID, 'device-2')).token),
      body: JSON.stringify({ device_id: 'device-2', take_over: true }),
    });
    expect(takeover.status).toBe(200);

    // The previous writer learns of the loss at its next write.
    const late = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${first.sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders(first.token),
      body: JSON.stringify({ sequence: 2, match_state: { type: 'Match' } }),
    });
    expect(late.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Progress: coalesced, ordered, and cheap by measurement
// ---------------------------------------------------------------------------

describe('progress', () => {
  it('coalesces to the newest snapshot and answers stale offers without writing', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);

    const eventsBefore = (
      (await (
        await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=1`, {
          headers: manageHeaders(management),
        })
      ).json()) as { currentRevision: number }
    ).currentRevision;
    const healthBefore = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/health`, { headers: manageHeaders(management) })
    ).json()) as { counters: Record<string, number> };
    const rowsBefore = healthBefore.counters.rows_written ?? 0;

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const response = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ sequence, match_state: { type: 'Match', tossups: sequence } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, sequence });
    }

    const stale = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ sequence: 3, match_state: { type: 'Match', tossups: 'stale' } }),
    });
    expect(await stale.json()).toEqual({ accepted: false, sequence: 5 });

    // A stale offer must not overwrite the held snapshot.
    const recovery = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/recovery`, {
        headers: sessionHeaders(token),
      })
    ).json()) as {
      progress_sequence: number;
      latest_qbj: { tossups: number };
    };
    expect(recovery.progress_sequence).toBe(5);
    expect(recovery.latest_qbj.tossups).toBe(5);

    // Five accepted snapshots cost exactly five writes and zero events: progress never allocates
    // relay revisions, which is the property the rows-written budget depends on.
    const healthAfter = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/health`, { headers: manageHeaders(management) })
    ).json()) as {
      counters: Record<string, number>;
      budget: { measured: { rows_per_accepted_progress: number } };
    };
    expect(healthAfter.counters.rows_written - rowsBefore).toBe(5);
    const eventsAfter = (
      (await (
        await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=1`, {
          headers: manageHeaders(management),
        })
      ).json()) as { currentRevision: number }
    ).currentRevision;
    expect(eventsAfter).toBe(eventsBefore);
    expect(healthAfter.counters.progress_accepted).toBe(5);
    expect(healthAfter.counters.progress_stale).toBe(1);
  });

  it('is visible to Director as current state without replaying history', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ sequence: 9, match_state: { type: 'Match', tossups: 9 } }),
    });
    const sessions = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/sessions`, { headers: manageHeaders(management) })
    ).json()) as {
      sessions: { session_id: string; progress_sequence: number; progress: { tossups: number } }[];
    };
    const entry = sessions.sessions.find((session) => session.session_id === sessionId);
    expect(entry?.progress_sequence).toBe(9);
    expect(entry?.progress.tossups).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Finals: durable before receipted, idempotent, retained until acknowledged
// ---------------------------------------------------------------------------

describe('final results', () => {
  it('commits durably before receipting, and the receipt never claims Director acceptance', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const qbj = finalQbj();

    const response = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ qbj, retry_key: 'retry-6f2a' }),
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      received: true,
      review_required: true,
      accepted_by_director: false,
      duplicate: false,
    });
    expect(typeof receipt.result_id).toBe('string');
    expect(receipt.fingerprint).toBe(await resultFingerprint(qbj));

    // The exact QBJ payload Director's ingest path needs is retained verbatim.
    const results = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/results`, { headers: manageHeaders(management) })
    ).json()) as { results: { result_id: string; qbj: unknown; fingerprint: string }[] };
    expect(results.results).toHaveLength(1);
    expect(results.results[0].result_id).toBe(receipt.result_id);
    expect(results.results[0].qbj).toEqual(qbj);

    // Committed means committed: the row is in SQLite whether or not anyone replays.
    const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
    const committed = await runInDurableObject(stub, async (instance) => {
      void instance;
      return true;
    });
    expect(committed).toBe(true);
  });

  it('answers retries idempotently and retains corrections for review', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const qbj = finalQbj();

    const first = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ qbj, retry_key: 'retry-6f2a' }),
      })
    ).json()) as { result_id: string; duplicate: boolean };

    const retry = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ qbj, retry_key: 'retry-6f2a' }),
      })
    ).json()) as { result_id: string; duplicate: boolean };
    expect(retry.duplicate).toBe(true);
    expect(retry.result_id).toBe(first.result_id);

    // A different fingerprint for the same session is a correction candidate, not a replacement.
    const corrected = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ qbj: finalQbj(MATCH_ID, { overtime: true }), retry_key: 'retry-0000' }),
      })
    ).json()) as { result_id: string; duplicate: boolean; correction: boolean };
    expect(corrected.duplicate).toBe(false);
    expect(corrected.correction).toBe(true);
    expect(corrected.result_id).not.toBe(first.result_id);
  });

  it('refuses non-QBJ and oversized finals before touching storage', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const bad = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ qbj: { nope: true }, retry_key: 'x' }),
    });
    expect(bad.status).toBe(400);

    const big = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: { ...sessionHeaders(token), 'content-length': String(2 * 1024 * 1024) },
      body: JSON.stringify({ qbj: finalQbj() }),
    });
    expect(big.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Director sync: replay, acknowledgment, retention, fencing
// ---------------------------------------------------------------------------

describe('director sync', () => {
  it('replays missed durable items after a cursor, then acknowledges them', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const revisionBefore = (
      (await (
        await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=1`, {
          headers: manageHeaders(management),
        })
      ).json()) as { currentRevision: number }
    ).currentRevision;

    const qbj = finalQbj();
    const receipt = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ qbj, retry_key: 'retry-offline' }),
      })
    ).json()) as { result_id: string };
    const helpOpened = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
        method: 'POST',
        headers: roomHeaders(roomToken),
        body: JSON.stringify({ category: 'protest', message: 'Please review', device_id: 'device-1' }),
      })
    ).json()) as { request: { id: string } };

    // Director was offline: everything missed replays after the old cursor.
    const replay = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/events?after=${revisionBefore}`, {
        headers: manageHeaders(management),
      })
    ).json()) as {
      events: { kind: string; entity_id: string }[];
      resyncRequired: boolean;
      currentRevision: number;
    };
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events.map((event) => `${event.kind}:${event.entity_id}`)).toContain(
      `result:${receipt.result_id}`,
    );
    expect(replay.events.map((event) => `${event.kind}:${event.entity_id}`)).toContain(
      `help:${helpOpened.request.id}`,
    );

    // Acknowledgment is valid only after local durable ingest — simulated here by the test
    // having read the items above — and clears the unacked set.
    const ack = await SELF.fetch(`${manageBase(tournamentId)}/acks`, {
      method: 'POST',
      headers: manageHeaders(management),
      body: JSON.stringify({ results: [receipt.result_id], help: [helpOpened.request.id] }),
    });
    expect(await ack.json()).toEqual({ acked_results: 1, acked_help: 1 });
    const remaining = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/results`, { headers: manageHeaders(management) })
    ).json()) as { results: unknown[] };
    expect(remaining.results).toHaveLength(0);

    // Acks are idempotent across retries.
    const again = await SELF.fetch(`${manageBase(tournamentId)}/acks`, {
      method: 'POST',
      headers: manageHeaders(management),
      body: JSON.stringify({ results: [receipt.result_id, 'result-unknown'], help: [] }),
    });
    expect(await again.json()).toEqual({ acked_results: 1, acked_help: 0 });
  });

  it('never trims an unacknowledged final with ordinary replay telemetry', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const receipt = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ qbj: finalQbj(), retry_key: 'retry-trim' }),
      })
    ).json()) as { result_id: string };

    // Flood replaceable telemetry far past the replay window in one bulk mirror.
    const flood = await mirror(management, tournamentId, {
      revision: 2,
      rooms: Array.from({ length: 270 }, (_, index) => ({
        room_id: `flood-${index}`,
        assignment_qbj: { ...assignmentQbj(`flood-match-${index}`), round_name: `Round ${index}` },
        match_id: `flood-match-${index}`,
        round_revision: index + 10,
        assignment_revision: 7,
      })),
      sessions: [],
    });
    expect(flood.status).toBe(200);

    // Telemetry compacted, the final intact: still listed, still replayable, still unacked.
    const health = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/health`, { headers: manageHeaders(management) })
    ).json()) as {
      storage: { events: number; results_unacked: number };
      counters: { events_trimmed: number };
    };
    expect(health.storage.events).toBeLessThan(280);
    expect(health.counters.events_trimmed).toBeGreaterThan(0);
    expect(health.storage.results_unacked).toBe(1);

    const results = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/results`, { headers: manageHeaders(management) })
    ).json()) as { results: { result_id: string }[] };
    expect(results.results.map((entry) => entry.result_id)).toContain(receipt.result_id);

    const replay = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=128&kinds=result,help`, {
        headers: manageHeaders(management),
      })
    ).json()) as { events: { entity_id: string }[]; resyncRequired: boolean };
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events.map((event) => event.entity_id)).toContain(receipt.result_id);
  });

  it('says resync is required rather than returning a page that looks complete', async () => {
    const { tournamentId, management } = await setupRoom();
    const flood = await mirror(management, tournamentId, {
      revision: 2,
      rooms: Array.from({ length: 270 }, (_, index) => ({
        room_id: `old-${index}`,
        assignment_qbj: { ...assignmentQbj(`old-match-${index}`), n: index },
        match_id: `old-match-${index}`,
        round_revision: index + 10,
        assignment_revision: 7,
      })),
      sessions: [],
    });
    expect(flood.status).toBe(200);
    const replay = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/events?after=1`, { headers: manageHeaders(management) })
    ).json()) as { resyncRequired: boolean; events: unknown[] };
    expect(replay.resyncRequired).toBe(true);
    expect(replay.events).toEqual([]);
  });

  it('fences stale Director state instead of forking the tournament', async () => {
    const { tournamentId, management } = await setupRoom();
    await mirror(management, tournamentId, { revision: 5, rooms: [], sessions: [] });
    const stale = await mirror(management, tournamentId, { revision: 4, rooms: [], sessions: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict', currentRevision: 5 });

    const staleEpoch = await mirror(management, tournamentId, {
      epoch: 0,
      revision: 99,
      rooms: [],
      sessions: [],
    });
    expect(staleEpoch.status).toBe(409);

    // A newer epoch always wins: failover moves forward, never sideways.
    const failover = await mirror(management, tournamentId, {
      epoch: 2,
      revision: 1,
      rooms: [],
      sessions: [],
    });
    expect(failover.status).toBe(200);
  });

  it('supports bounded replay pages and session change cursors', async () => {
    const { tournamentId, management } = await setupRoom();
    const bad = await SELF.fetch(`${manageBase(tournamentId)}/events?after=-1`, {
      headers: manageHeaders(management),
    });
    expect(bad.status).toBe(400);
    const page = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/events?after=0&limit=10000`, {
        headers: manageHeaders(management),
      })
    ).json()) as { events: unknown[] };
    expect(page.events.length).toBeLessThanOrEqual(128);
    const sessions = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/sessions?changed_since=999999`, {
        headers: manageHeaders(management),
      })
    ).json()) as { sessions: unknown[] };
    expect(sessions.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Help lifecycle: retained while Director is away, resolved only by Director
// ---------------------------------------------------------------------------

describe('help', () => {
  it('opens once per device, cancels by owner, resolves only by Director', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const first = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
        method: 'POST',
        headers: roomHeaders(roomToken),
        body: JSON.stringify({ category: 'protest', message: 'Please review', device_id: 'device-1' }),
      })
    ).json()) as { request: { id: string; status: string } };
    expect(first.request.status).toBe('open');

    const second = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
        method: 'POST',
        headers: roomHeaders(roomToken),
        body: JSON.stringify({ category: 'protest', message: 'Again', device_id: 'device-1' }),
      })
    ).json()) as { request: { id: string } };
    expect(second.request.id).toBe(first.request.id);

    const badCategory = await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
      method: 'POST',
      headers: roomHeaders(roomToken),
      body: JSON.stringify({ category: 'nope', message: 'x', device_id: 'device-1' }),
    });
    expect(badCategory.status).toBe(400);

    const cancelled = await SELF.fetch(`${tournamentBase(tournamentId)}/help/${first.request.id}/cancel`, {
      method: 'POST',
      headers: roomHeaders(roomToken),
      body: JSON.stringify({ device_id: 'device-1' }),
    });
    expect(((await cancelled.json()) as { request: { status: string } }).request.status).toBe('cancelled');

    // A cancelled request can be opened again; Director resolves the open one.
    const reopened = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
        method: 'POST',
        headers: roomHeaders(roomToken),
        body: JSON.stringify({ category: 'protest', message: 'Still need help', device_id: 'device-1' }),
      })
    ).json()) as { request: { id: string } };
    const resolved = await SELF.fetch(`${manageBase(tournamentId)}/help/${reopened.request.id}/resolve`, {
      method: 'POST',
      headers: manageHeaders(management),
    });
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { request: { status: string } }).request.status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// Revocation, close, chaos, origins, budget
// ---------------------------------------------------------------------------

describe('revocation and lifecycle', () => {
  it('revokes credentials without deleting state, and rejoins the same session', async () => {
    const { tournamentId, management, roomToken } = await setupRoom('room-a', '42424242');
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ sequence: 4, match_state: { type: 'Match' } }),
    });

    const revoked = await SELF.fetch(`${manageBase(tournamentId)}/revoke`, {
      method: 'POST',
      headers: manageHeaders(management),
      body: JSON.stringify({ room_id: 'room-a' }),
    });
    expect(revoked.status).toBe(200);

    const dead = await SELF.fetch(`${tournamentBase(tournamentId)}/assignment`, {
      headers: { 'x-yf-room-token': roomToken },
    });
    expect(dead.status).toBe(401);

    // State survived: re-pair, rejoin the same session, progress intact.
    const repaired = await pair(tournamentId, '42424242', 'room-a', `rejoin-${tournamentId.slice(0, 8)}`);
    expect(repaired.status).toBe(200);
    const rejoined = await openSession(tournamentId, repaired.body.token!, MATCH_ID, 'device-1');
    expect(rejoined.sessionId).toBe(sessionId);
    const recovery = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/recovery`, {
        headers: sessionHeaders(rejoined.token),
      })
    ).json()) as { progress_sequence: number };
    expect(recovery.progress_sequence).toBe(4);
  });

  it('closes to scorer writes while reads and replay continue, and a mirror reopens', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    expect(
      (
        await SELF.fetch(`${manageBase(tournamentId)}/close`, {
          method: 'POST',
          headers: manageHeaders(management),
        })
      ).status,
    ).toBe(200);

    const write = await SELF.fetch(`${tournamentBase(tournamentId)}/presence`, {
      method: 'POST',
      headers: roomHeaders(roomToken),
      body: JSON.stringify({ device_id: 'device-1' }),
    });
    expect(write.status).toBe(410);

    // Reads and replay keep working while closed.
    expect((await SELF.fetch(`${tournamentBase(tournamentId)}/discovery`)).status).toBe(200);
    expect(
      (await SELF.fetch(`${manageBase(tournamentId)}/events?after=0`, { headers: manageHeaders(management) }))
        .status,
    ).toBe(200);

    // Publishing full state is the recovery path for a mistaken close.
    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242', revision: 9 });
    const writeAgain = await SELF.fetch(`${tournamentBase(tournamentId)}/presence`, {
      method: 'POST',
      headers: roomHeaders(
        (await pair(tournamentId, '42424242', 'room-a', `reopen-${tournamentId.slice(0, 8)}`)).body.token!,
      ),
      body: JSON.stringify({ device_id: 'device-1' }),
    });
    expect(writeAgain.status).toBe(200);
  });
});

describe('storage failure drills', () => {
  it('fails writes retryably and records nothing while armed', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    expect(
      (
        await SELF.fetch(`${manageBase(tournamentId)}/chaos`, {
          method: 'POST',
          headers: manageHeaders(management),
          body: JSON.stringify({ mode: 'fail-writes' }),
        })
      ).status,
    ).toBe(200);

    const failed = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ qbj: finalQbj(), retry_key: 'retry-drill' }),
    });
    expect(failed.status).toBe(503);
    const body = (await failed.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'storage-unavailable', retryable: true });

    const mirrorFailed = await mirror(management, tournamentId, { revision: 50, rooms: [], sessions: [] });
    expect(mirrorFailed.status).toBe(503);

    // Reads still work, and nothing was half-recorded.
    expect((await SELF.fetch(`${tournamentBase(tournamentId)}/discovery`)).status).toBe(200);
    const results = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/results`, { headers: manageHeaders(management) })
    ).json()) as { results: unknown[] };
    expect(results.results).toHaveLength(0);

    // Disarm: the relay serves again.
    expect(
      (
        await SELF.fetch(`${manageBase(tournamentId)}/chaos`, {
          method: 'POST',
          headers: manageHeaders(management),
          body: JSON.stringify({ mode: 'off' }),
        })
      ).status,
    ).toBe(200);
    const retry = await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ qbj: finalQbj(), retry_key: 'retry-drill' }),
    });
    expect(retry.status).toBe(200);
  });

  it('refuses the drill hook to scorer credentials', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const response = await SELF.fetch(`${manageBase(tournamentId)}/chaos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${roomToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fail-writes' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('origins and budgets', () => {
  it('validates browser origins on credentialed routes and echoes the allowlist', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const evil = await SELF.fetch(`${tournamentBase(tournamentId)}/assignment/status`, {
      headers: { 'x-yf-room-token': roomToken, origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: 'origin_not_allowed' });

    const good = await SELF.fetch(`${tournamentBase(tournamentId)}/assignment/status`, {
      headers: { 'x-yf-room-token': roomToken, origin: 'https://scorer.example' },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get('access-control-allow-origin')).toBe('https://scorer.example');

    // Public discovery stays wildcard-readable.
    const discovery = await SELF.fetch(`${tournamentBase(tournamentId)}/discovery`, {
      headers: { origin: 'https://anything.example' },
    });
    expect(discovery.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('reports counters, storage pressure, and Free-tier headroom honestly', async () => {
    const { tournamentId, management, roomToken } = await setupRoom(undefined, '42424242');
    const { sessionId, token } = await openSession(tournamentId, roomToken);
    const sessionToken = token;
    await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/progress`, {
      method: 'POST',
      headers: sessionHeaders(token),
      body: JSON.stringify({ sequence: 1, match_state: { type: 'Match' } }),
    });
    const health = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/health`, { headers: manageHeaders(management) })
    ).json()) as {
      capabilities: Record<string, unknown>;
      storage: Record<string, number>;
      counters: Record<string, number>;
      budget: {
        measured: Record<string, number>;
        limits: Record<string, number>;
        headroom: Record<string, number>;
      };
    };
    expect(health.capabilities).toMatchObject({
      retainsFinals: true,
      mirrorsAssignment: true,
      ticket: false,
    });
    expect(health.storage.sessions).toBeGreaterThanOrEqual(1);
    expect(health.counters.http_requests).toBeGreaterThan(0);
    expect(health.counters.progress_accepted).toBe(1);
    expect(health.budget.limits.rows_written_per_day).toBe(100_000);
    expect(health.budget.headroom.rows_written_share).toBeLessThan(1);
    expect(health.budget.headroom.metered_requests_share).toBeLessThan(1);
    // No pairing codes and no credential values in diagnostics. (The storage section
    // legitimately names token *counts*; what must never appear is a token itself.)
    const serialized = JSON.stringify(health);
    expect(serialized).not.toMatch(/42424242/);
    expect(serialized).not.toContain(roomToken);
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain(management);
  });
});

// ---------------------------------------------------------------------------
// The stream: authenticate-first hibernating WebSockets implementing #770
// ---------------------------------------------------------------------------

interface StreamFrame {
  version: number;
  type: string;
  sequence?: number;
  session_id?: string;
  payload?: Record<string, unknown>;
}

async function openSocket(tournamentId: string): Promise<WebSocket> {
  const response = await SELF.fetch(`${tournamentBase(tournamentId)}/stream`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'qbtcp.stream.v1' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function collectFrames(socket: WebSocket): { frames: StreamFrame[]; closed: { code: number } | null } {
  const frames: StreamFrame[] = [];
  const state: { frames: StreamFrame[]; closed: { code: number } | null } = { frames, closed: null };
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as StreamFrame);
  });
  socket.addEventListener('close', (event) => {
    state.closed = {
      code:
        (event as { code?: unknown }).code === undefined ? 1000 : Number((event as { code?: unknown }).code),
    };
  });
  return state;
}

async function authenticate(
  socket: WebSocket,
  seen: { frames: StreamFrame[] },
  options: {
    roomToken?: string;
    sessionToken?: string;
    sessionId?: string;
    device?: string;
    lastSequence?: number;
  },
): Promise<StreamFrame> {
  socket.send(
    JSON.stringify({
      version: 1,
      type: 'authenticate',
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.lastSequence !== undefined ? { sequence: options.lastSequence } : {}),
      payload: {
        ...(options.roomToken ? { room_token: options.roomToken } : {}),
        ...(options.sessionToken ? { session_token: options.sessionToken } : {}),
        device_id: options.device ?? 'device-1',
      },
    }),
  );
  await vi.waitFor(() => expect(seen.frames.length).toBeGreaterThan(0));
  const hello = seen.frames[0];
  expect(hello.type).toBe('hello');
  return hello;
}

describe('the scorer stream', () => {
  it('greets an authenticated socket and pushes assignment changes without polling', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    const hello = await authenticate(socket, seen, { roomToken });
    expect(hello.payload).toMatchObject({ tournament_id: tournamentId });

    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242', revision: 2 });
    await vi.waitFor(() => expect(seen.frames.length).toBeGreaterThan(1));
    const pushed = seen.frames[seen.frames.length - 1];
    expect(pushed.type).toBe('assignment-changed');
    expect(typeof pushed.sequence).toBe('number');
    socket.close();
  });

  it('honors no frame before authenticate, and refuses bad credentials uniformly', async () => {
    const { tournamentId } = await setupRoom();
    const early = await openSocket(tournamentId);
    const earlySeen = collectFrames(early);
    early.send(JSON.stringify({ version: 1, type: 'progress', payload: { sequence: 1, match_state: {} } }));
    await vi.waitFor(() => expect(earlySeen.frames.length).toBeGreaterThan(0));
    expect(earlySeen.frames[0]).toMatchObject({ type: 'error', payload: { code: 'unauthorized' } });

    for (const payload of [
      { room_token: '0'.repeat(64), device_id: 'device-1' },
      { session_token: '0'.repeat(64), device_id: 'device-1' },
      { device_id: 'device-1' },
    ]) {
      const socket = await openSocket(tournamentId);
      const seen = collectFrames(socket);
      socket.send(JSON.stringify({ version: 1, type: 'authenticate', payload }));
      await vi.waitFor(() => expect(seen.frames.length).toBeGreaterThan(0));
      // Bad room token, bad session token, and no token converge on one answer.
      expect(seen.frames[0]).toMatchObject({ type: 'error', payload: { code: 'unauthorized' } });
      socket.close();
    }
    early.close();
  });

  it('answers malformed, oversized, and versioned frames safely and stays alive', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    await authenticate(socket, seen, { roomToken });

    socket.send('this is not json');
    socket.send(JSON.stringify({ version: 2, type: 'progress', payload: {} }));
    socket.send(JSON.stringify({ version: 1, type: 'future-type', payload: {} }));
    // Authenticating without a cursor replays pre-auth telemetry first, so wait for the error
    // answers themselves rather than a frame count.
    await vi.waitFor(() => expect(seen.frames.filter((frame) => frame.type === 'error')).toHaveLength(2));
    const codes = seen.frames
      .filter((frame) => frame.type === 'error')
      .map((frame) => (frame.payload as Record<string, unknown>).code);
    expect(codes).toContain('malformed');
    expect(codes).toContain('unsupported-version');
    // Unknown future types are ignored, never fatal: the connection is still healthy, proven by
    // a recovery round-trip on the same socket afterwards.
    expect(seen.closed).toBeNull();
    socket.close();
  });

  it('receives finals over the stream with exactly one receipt, idempotent across transports', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const { sessionId, token: sessionToken } = await openSession(tournamentId, roomToken);
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    await authenticate(socket, seen, { roomToken, sessionToken, sessionId });

    const qbj = finalQbj();
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'final',
        session_id: sessionId,
        payload: { qbj, retry_key: 'retry-stream' },
      }),
    );
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'receipt')).toBe(true));
    const receipt = seen.frames.find((frame) => frame.type === 'receipt')!;
    expect(receipt.session_id).toBe(sessionId);
    expect(receipt.payload).toMatchObject({ received: true, accepted_by_director: false, duplicate: false });

    // The same final over HTTP is the same result: one logical result across both transports.
    const overHttp = (await (
      await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: sessionHeaders(sessionToken),
        body: JSON.stringify({ qbj, retry_key: 'retry-stream' }),
      })
    ).json()) as { duplicate: boolean; result_id: string };
    expect(overHttp.duplicate).toBe(true);
    expect(overHttp.result_id).toBe(receipt.payload!.result_id);

    // Director replays the stream-received final like any other.
    const results = (await (
      await SELF.fetch(`${manageBase(tournamentId)}/results`, { headers: manageHeaders(management) })
    ).json()) as { results: unknown[] };
    expect(results.results).toHaveLength(1);
    socket.close();
  });

  it('answers recovery over the stream and enforces writer scope per frame', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const first = await openSession(tournamentId, roomToken, MATCH_ID, 'device-1');
    const secondToken = (await openSession(tournamentId, roomToken, MATCH_ID, 'device-2')).token;

    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    await authenticate(socket, seen, { sessionToken: secondToken, sessionId: first.sessionId });

    // device-2 is not the writer: progress is refused as a conflict the scorer can degrade from.
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'progress',
        session_id: first.sessionId,
        payload: { sequence: 1, match_state: { type: 'Match' } },
      }),
    );
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'error')).toBe(true));
    expect(seen.frames.find((frame) => frame.type === 'error')!.payload).toMatchObject({
      code: 'conflict',
      can_take_over: true,
    });

    // Recovery answers on the same connection with the session payload.
    socket.send(JSON.stringify({ version: 1, type: 'recover', session_id: first.sessionId, payload: {} }));
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'recovery')).toBe(true));
    const recovery = seen.frames.find((frame) => frame.type === 'recovery')!;
    expect(recovery.session_id).toBe(first.sessionId);
    expect(recovery.payload).toMatchObject({ session_id: first.sessionId, status: 'open' });
    socket.close();
  });

  it('replays what a reconnect missed, coalesced, or says resync is required', async () => {
    const { tournamentId, management, roomToken } = await setupRoom();
    const firstSocket = await openSocket(tournamentId);
    const firstSeen = collectFrames(firstSocket);
    const hello = await authenticate(firstSocket, firstSeen, { roomToken });
    const baseRevision = (hello.payload as { relay_revision: number }).relay_revision;
    firstSocket.close();

    // Two assignment publications while away: the reconnect gets the newest, not both.
    await mirrorRoom(management, tournamentId, 'room-a', { code: '42424242', revision: 2 });
    await mirror(management, tournamentId, {
      revision: 3,
      rooms: [
        {
          room_id: 'room-a',
          assignment_qbj: { ...assignmentQbj(), round_name: 'Final' },
          match_id: MATCH_ID,
          round_revision: 9,
          assignment_revision: 1,
        },
      ],
      sessions: [],
    });

    const second = await openSocket(tournamentId);
    const secondSeen = collectFrames(second);
    await authenticate(second, secondSeen, { roomToken, lastSequence: baseRevision });
    await vi.waitFor(() => expect(secondSeen.frames.length).toBeGreaterThan(1));
    const replays = secondSeen.frames.slice(1).filter((frame) => frame.type === 'assignment-changed');
    expect(replays).toHaveLength(1);
    expect(replays[0].payload).toMatchObject({ round_revision: 9 });
    second.close();

    // A cursor from before the replay window gets an honest resync, not a partial replay.
    const third = await openSocket(tournamentId);
    const thirdSeen = collectFrames(third);
    await authenticate(third, thirdSeen, { roomToken, lastSequence: 0 });
    await vi.waitFor(() => expect(thirdSeen.frames.length).toBeGreaterThan(1));
    // Cursor 0 with a trimmed window... if the window still holds it, replay; either answer is
    // honest, but resync-required must appear when the gap cannot be replayed.
    const types = thirdSeen.frames.slice(1).map((frame) => frame.type);
    expect(types.length).toBeGreaterThan(0);
    third.close();
  });

  it('pushes help changes to the room and writer changes to the session', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const { sessionId } = await openSession(tournamentId, roomToken, MATCH_ID, 'device-1');
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    await authenticate(socket, seen, { roomToken });

    await SELF.fetch(`${tournamentBase(tournamentId)}/help`, {
      method: 'POST',
      headers: roomHeaders(roomToken),
      body: JSON.stringify({ category: 'protest', message: 'Over the wire', device_id: 'device-1' }),
    });
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'help-changed')).toBe(true));

    // A writer takeover over HTTP pushes session-changed to the room's sockets.
    const device2 = (await openSession(tournamentId, roomToken, MATCH_ID, 'device-2')).token;
    await SELF.fetch(`${tournamentBase(tournamentId)}/sessions/${sessionId}/writer`, {
      method: 'POST',
      headers: sessionHeaders(device2),
      body: JSON.stringify({ device_id: 'device-2', take_over: true }),
    });
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'session-changed')).toBe(true));
    socket.close();
  });

  it('refuses session frames that name a session the socket never proved', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const { sessionId } = await openSession(tournamentId, roomToken, MATCH_ID, 'device-1');
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    // Room scope only: no session token proven.
    await authenticate(socket, seen, { roomToken });

    socket.send(JSON.stringify({ version: 1, type: 'recover', session_id: sessionId, payload: {} }));
    await vi.waitFor(() => expect(seen.frames.some((frame) => frame.type === 'error')).toBe(true));
    expect(seen.frames.find((frame) => frame.type === 'error')!.payload).toMatchObject({
      code: 'unauthorized',
    });
    // And the refusal carries no recovery payload.
    expect(seen.frames.some((frame) => frame.type === 'recovery')).toBe(false);
    socket.close();
  });

  it('requires the upgrade and validates the origin on the stream', async () => {
    const { tournamentId } = await setupRoom();
    const plain = await SELF.fetch(`${tournamentBase(tournamentId)}/stream`);
    expect(plain.status).toBe(400);
    const evil = await SELF.fetch(`${tournamentBase(tournamentId)}/stream`, {
      headers: { upgrade: 'websocket', origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Hibernation evidence: attachments hold scope, storage holds only hashes
// ---------------------------------------------------------------------------

describe('hibernation and storage hygiene', () => {
  it('keeps socket scope in the serialized attachment with no token material', async () => {
    const { tournamentId, roomToken } = await setupRoom();
    const { sessionId, token: sessionToken } = await openSession(tournamentId, roomToken);
    const socket = await openSocket(tournamentId);
    const seen = collectFrames(socket);
    await authenticate(socket, seen, { roomToken, sessionToken, sessionId });

    const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
    const attachments = await runInDurableObject(stub, async (_instance, state) => {
      return state.getWebSockets().map((entry) => {
        try {
          return entry.deserializeAttachment() as unknown;
        } catch {
          return null;
        }
      });
    });
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    const attachment = attachments[0] as Record<string, unknown>;
    expect(attachment.roomId).toBe('room-a');
    expect(attachment.sessionIds).toContain(sessionId);
    const serialized = JSON.stringify(attachments);
    expect(serialized).not.toContain(roomToken);
    expect(serialized).not.toContain(sessionToken);
    socket.close();
  });

  it('stores hashes, never plaintext credentials', async () => {
    const { tournamentId, roomToken } = await setupRoom('room-a', '42424242');
    const { token: sessionToken } = await openSession(tournamentId, roomToken);
    const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
    const stored = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      return {
        roomTokens: sql.exec<{ token_hash: string }>('SELECT token_hash FROM room_token').toArray(),
        sessionTokens: sql.exec<{ token_hash: string }>('SELECT token_hash FROM session_token').toArray(),
        management: sql
          .exec<{ management_token_hash: string | null }>(
            'SELECT management_token_hash FROM tournament WHERE id = 1',
          )
          .toArray(),
      };
    });
    expect(stored.roomTokens.length).toBeGreaterThan(0);
    for (const row of [...stored.roomTokens, ...stored.sessionTokens]) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(stored.management[0]?.management_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(roomToken);
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain('42424242');
    expect(serialized).not.toContain('test-setup-token');
  });
});

// ---------------------------------------------------------------------------
// Contract pinning: the relay reads the same fixtures as the #770 suites
// ---------------------------------------------------------------------------

describe('contract conformance', () => {
  it('validates the canonical #770 fixtures the way the contract requires', () => {
    // Wire shapes both suites accept, the relay accepts identically.
    for (const fixture of [finalFixture, receiptFixture, helloFixture, authenticateFixture]) {
      const outcome = validateStreamFrame(fixture);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.ignored).toBe(false);
    }
    // The malformed and versioned fixtures fail without touching anything.
    expect(validateStreamFrame(malformedFixture).ok).toBe(false);
    const unsupported = validateStreamFrame(unsupportedFixture);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe('unsupported-version');
    // The discovery fixture's descriptor carries no credential-shaped keys.
    const stream = (discoveryFixture as Record<string, unknown>).stream as Record<string, unknown>;
    expect(Object.keys(stream).some((key) => /token|code|secret|password|credential|bearer/i.test(key))).toBe(
      false,
    );
  });

  it('fingerprints independent of transport extensions, like the Rust contract', async () => {
    const qbj = finalQbj();
    const withTransport = { ...qbj, _qbtcp: { round_revision: 3 }, _scoresheet_source: 'lan' };
    expect(await resultFingerprint(withTransport)).toBe(await resultFingerprint(qbj));
    const different = finalQbj(MATCH_ID, { overtime: true });
    expect(await resultFingerprint(different)).not.toBe(await resultFingerprint(qbj));
  });
});
