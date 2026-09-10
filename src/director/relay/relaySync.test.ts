import { describe, expect, it, vi } from 'vitest';
import {
  advanceRelayCursor,
  buildRelayAckBody,
  buildRelayMirrorDocument,
  classifyRelayTransportFailure,
  fetchRelayEventsPage,
  fetchRelaySessionSnapshot,
  fetchUnackedRelayResults,
  reconcileRelaySessions,
  relayResultToIncomingDocument,
  resyncKeepsUnackedFinals,
  summarizeRelayReconnect,
  type RelaySyncConnection,
} from './relaySync';
import { assessIncomingDocument, stageIncomingDocument } from '../transfers/ingest';
import { assignmentFor, directorFixture, scoreAssignment } from '../transfers/testFixtures';

const connection: RelaySyncConnection = {
  baseUrl: 'https://qbtcp-relay-abc.xyz123.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz1234',
  managementToken: 'management-credential',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('mirror projection allowlist', () => {
  it('publishes rooms, sessions, and pairing hashes but never plaintext codes or credentials', () => {
    const built = buildRelayMirrorDocument({
      directorEpoch: 1,
      revision: 2,
      tournamentName: 'NSHS Tournament',
      rooms: [
        {
          roomId: 'room-101',
          name: 'Room 101',
          pairingCodeHash: 'a'.repeat(64),
          matchId: 'game-5-1',
          roundRevision: 3,
          assignmentRevision: 1,
        },
      ],
      sessions: [{ sessionId: 'session-1', roomId: 'room-101', matchId: 'game-5-1', status: 'open' }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const text = JSON.stringify(built.document);
    expect(text).toContain('room-101');
    expect(text).toContain('a'.repeat(64));
    expect(text).not.toMatch(/management|credential|secret|pairing_code(?!_hash)/i);
    expect(built.document).toMatchObject({ director_epoch: 1, revision: 2 });
  });

  it('fails closed on bounds, bad hashes, oversized assignments, and unknown-room sessions', () => {
    expect(buildRelayMirrorDocument({ directorEpoch: -1, revision: 1, rooms: [], sessions: [] }).ok).toBe(
      false,
    );
    expect(
      buildRelayMirrorDocument({
        directorEpoch: 1,
        revision: 1,
        rooms: [{ roomId: 'r', pairingCodeHash: 'not-a-hash' }],
        sessions: [],
      }).ok,
    ).toBe(false);
    expect(
      buildRelayMirrorDocument({
        directorEpoch: 1,
        revision: 1,
        rooms: [{ roomId: 'r', assignmentQbj: { big: 'x'.repeat(300_000) } }],
        sessions: [],
      }).ok,
    ).toBe(false);
    expect(
      buildRelayMirrorDocument({
        directorEpoch: 1,
        revision: 1,
        rooms: [],
        sessions: [{ sessionId: 's', roomId: 'ghost', matchId: 'm', status: 'open' }],
      }).ok,
    ).toBe(false);
  });
});

describe('durable cursor ordering', () => {
  it('advances only forward after durable local ingest, never backward', () => {
    const cursor = { lastIngestedRelayRevision: 178 };
    expect(advanceRelayCursor(cursor, 182)).toEqual({ lastIngestedRelayRevision: 182 });
    expect(advanceRelayCursor({ lastIngestedRelayRevision: 182 }, 180)).toEqual({
      lastIngestedRelayRevision: 182,
    });
    expect(advanceRelayCursor(cursor, -1)).toEqual(cursor);
  });

  it('builds idempotent ack bodies: deduped, bounded, and empty-safe', () => {
    expect(buildRelayAckBody(['r1', 'r1', 'r2'], ['h1'])).toEqual({ results: ['r1', 'r2'], help: ['h1'] });
    expect(buildRelayAckBody([], [])).toEqual({ results: [], help: [] });
  });

  it('treats quota refusal and outages as retryable transport failure without cursor motion', async () => {
    expect(classifyRelayTransportFailure(503, 'server_error')).toBe(true);
    expect(classifyRelayTransportFailure(429, 'rate_limited')).toBe(true);
    expect(classifyRelayTransportFailure(null)).toBe(true);
    expect(classifyRelayTransportFailure(403, 'quota_exhausted_1027')).toBe(true);
    expect(classifyRelayTransportFailure(401, 'invalid_credential')).toBe(false);
    expect(classifyRelayTransportFailure(409, 'conflict')).toBe(false);
    const quotaFetch = vi.fn(async () =>
      jsonResponse(503, { error: 'quota_exhausted', message: 'Error 1027 shaped refusal' }),
    ) as unknown as typeof fetch;
    await expect(fetchRelayEventsPage({ ...connection, fetchImpl: quotaFetch }, 178)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('replay and resync', () => {
  it('replays events after the cursor and flags resync honestly', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/events')) {
        return jsonResponse(200, {
          tournamentId: connection.tournamentId,
          currentRevision: 182,
          events: [
            {
              revision: 180,
              kind: 'result',
              entity_id: 'res-1',
              body: {},
              created_at: '2026-09-10T12:00:00Z',
            },
            {
              revision: 181,
              kind: 'help',
              entity_id: 'help-1',
              body: {},
              created_at: '2026-09-10T12:01:00Z',
            },
          ],
          resyncRequired: false,
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const page = await fetchRelayEventsPage({ ...connection, fetchImpl }, 178);
    expect(page.events.map((entry) => entry.revision)).toEqual([180, 181]);
    expect(page.resyncRequired).toBe(false);
  });

  it('never lets a full snapshot excuse losing an unacknowledged final', () => {
    expect(resyncKeepsUnackedFinals({ resyncRequired: true, unackedResultsFetched: false })).toBe(false);
    expect(resyncKeepsUnackedFinals({ resyncRequired: true, unackedResultsFetched: true })).toBe(true);
    expect(resyncKeepsUnackedFinals({ resyncRequired: false, unackedResultsFetched: false })).toBe(true);
  });

  it('reconciles sessions newest-wins with ties favoring local Director truth', () => {
    const local = [
      { sessionId: 's-new', updatedSequence: 10, status: 'open' },
      { sessionId: 's-terminal', updatedSequence: 9, status: 'final-received' },
    ];
    const { apply, ignoreStale } = reconcileRelaySessions(local, [
      { sessionId: 's-new', roomId: 'r', matchId: 'm', status: 'open', updatedSequence: 9 },
      { sessionId: 's-terminal', roomId: 'r', matchId: 'm', status: 'open', updatedSequence: 12 },
      { sessionId: 's-fresh', roomId: 'r', matchId: 'm', status: 'open', updatedSequence: 1 },
    ]);
    expect(apply.map((entry) => entry.sessionId)).toEqual(['s-fresh']);
    expect(ignoreStale).toBe(2);
  });

  it('summarizes reconnects concisely and stays quiet when nothing arrived', () => {
    expect(summarizeRelayReconnect({ results: 0, help: 0 })).toBeNull();
    expect(summarizeRelayReconnect({ results: 3, help: 1 })).toContain('3 results and 1 help request');
    expect(summarizeRelayReconnect({ results: 1, help: 0 })).toContain('1 result');
  });
});

describe('canonical result ingestion', () => {
  it('feeds a relay final through the same pipeline so LAN + relay duplicates converge', async () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const fetchImpl = (async (url: string) => {
      if (url.includes('/results')) {
        return jsonResponse(200, {
          tournamentId: connection.tournamentId,
          revision: 180,
          results: [
            {
              result_id: 'relay-res-1',
              session_id: 'session-1',
              room_id: 'room-101',
              match_id: 'game-5-1',
              fingerprint: 'relay-fp',
              retry_key: null,
              qbj: result,
              received_at: '2026-09-10T12:00:00Z',
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const [retained] = await fetchUnackedRelayResults({ ...connection, fetchImpl });
    const document = relayResultToIncomingDocument(retained, connection.tournamentId);
    expect(document.sourceKind).toBe('qbtcp');
    expect(document.sourceLabel).toBe('QBTCP relay');
    const assessment = assessIncomingDocument(state, document);
    expect(['ready', 'needs-review']).toContain(assessment.classification);
    stageIncomingDocument(state, document, assessment);
    expect(state.games).toHaveLength(1);
    const replay = assessIncomingDocument(state, document);
    expect(replay.classification).toBe('duplicate');
  });

  it('fetches the coalesced session snapshot for progress convergence', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        tournamentId: connection.tournamentId,
        revision: 182,
        sessions: [{ session_id: 's', room_id: 'r', match_id: 'm', status: 'open', updated_sequence: 4 }],
      })) as unknown as typeof fetch;
    const snapshot = await fetchRelaySessionSnapshot({ ...connection, fetchImpl });
    expect(snapshot.sessions).toHaveLength(1);
  });
});
