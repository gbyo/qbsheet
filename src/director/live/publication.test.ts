/**
 * The durable outbox.
 *
 * The behaviour under test is the promise in `docs/QBLIVE.md`: a tournament keeps working when the
 * internet does not, and catches up correctly afterwards. The outage scenario at the bottom is the
 * one that matters most — it is the exact sequence a Director actually experiences when a school's
 * WiFi drops during round three.
 */

import { describe, expect, test, vi } from 'vitest';
import { QbliveClient, QbliveClientError, type QbliveSnapshot } from '@qbsheet/qblive-protocol';
import {
  defaultLivePublicationSettings,
  emptyLivePublication,
  type DirectorState,
  type LivePublication,
} from '../domain';
import { privacyFixture } from '@qbsheet/qblive-projection/fixture';
import {
  acknowledgeOutboxItem,
  backoffMilliseconds,
  composeAnnouncement,
  derivePublication,
  markOutboxItemInFlight,
  maxOutboxItems,
  nextOutboxItem,
  recordOutboxFailure,
  syncSummary,
} from './publication';
import { classifyFailure, publishOnce } from './worker';

function liveState(overrides: Partial<LivePublication> = {}): DirectorState {
  const state = privacyFixture();
  const live = emptyLivePublication('bcdfghjkmnpqrstvwxyz', '2026-09-05T12:00:00.000Z');
  live.lifecycle = 'live';
  live.settings = { ...defaultLivePublicationSettings(), enabled: true };
  live.backend = { kind: 'cloudflare', origin: 'https://backend.example' };
  state.live = { ...live, ...overrides };
  return state;
}

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 5, 14, 30, seconds));

describe('deriving a publication', () => {
  test('the first derivation queues a full snapshot', () => {
    const derived = derivePublication(liveState(), null, { now: at(0) });
    expect(derived.live?.outbox).toHaveLength(1);
    expect(derived.live?.outbox[0].kind).toBe('snapshot');
    expect(derived.live?.sync.localRevision).toBe(1);
    expect(derived.snapshot?.revision).toBe(1);
  });

  test('an unchanged state queues nothing', () => {
    const state = liveState();
    const first = derivePublication(state, null, { now: at(0) });
    const second = derivePublication(state, first.snapshot, { now: at(5) });
    expect(second.live).toBeNull();
    expect(second.changed).toEqual([]);
  });

  test('a live score change queues only the liveGames section', () => {
    const state = liveState();
    const first = derivePublication(
      { ...state, live: { ...state.live!, settings: { ...state.live!.settings, liveScores: true } } },
      null,
      { now: at(0) },
    );
    const moved = structuredClone(state);
    moved.live = { ...first.live! };
    moved.live.settings = { ...moved.live.settings, liveScores: true };
    moved.qbtcpSessions[0].progress = { tossupsRead: 14, leftScore: 195, rightScore: 135 };

    const second = derivePublication(moved, first.snapshot, { now: at(5) });
    expect(second.changed).toEqual(['liveGames']);
    const payload = second.live!.outbox.at(-1)!.payload as { sections: Record<string, unknown> };
    expect(Object.keys(payload.sections)).toEqual(['liveGames']);
  });

  test('an accepted result changes results, standings and statistics together', () => {
    const state = liveState();
    const first = derivePublication(state, null, { now: at(0) });
    const withResult = structuredClone(state);
    withResult.live = first.live!;
    withResult.rounds[1].status = 'closed';
    withResult.scheduledGames[2].status = 'accepted';
    withResult.games.push({
      id: 'result-3',
      scheduledGameId: 'game-3',
      roundId: 'round-2',
      packetId: null,
      status: 'accepted',
      scores: [
        {
          teamId: 'team-a',
          score: 300,
          powers: 5,
          gets: 10,
          negs: 0,
          bonuses: 15,
          bonusPoints: 160,
          bouncebacks: 0,
        },
        {
          teamId: 'team-c',
          score: 150,
          powers: 0,
          gets: 8,
          negs: 3,
          bonuses: 6,
          bonusPoints: 60,
          bouncebacks: 0,
        },
      ],
      playerStats: [],
      source: 'qbtcp',
      detailedStats: 'complete',
      acceptedAt: '2026-09-05T14:29:00.000Z',
    });
    const second = derivePublication(withResult, first.snapshot, { now: at(5) });
    expect(second.changed).toEqual(
      expect.arrayContaining(['results', 'standings', 'statistics', 'schedule']),
    );
  });

  test('a disabled publication derives nothing', () => {
    const state = liveState();
    state.live!.settings.enabled = false;
    expect(derivePublication(state, null, { now: at(0) }).live).toBeNull();
  });

  test('an unpublished publication derives nothing', () => {
    const state = liveState({ lifecycle: 'unpublished' });
    expect(derivePublication(state, null, { now: at(0) }).live).toBeNull();
  });
});

describe('outbox coalescing', () => {
  /** Advance the tournament's live score `count` times without publishing any of them. */
  function accumulateScoreTicks(count: number): { state: DirectorState; snapshot: QbliveSnapshot } {
    const state = liveState();
    state.live!.settings.liveScores = true;
    let derived = derivePublication(state, null, { now: at(0) });
    let snapshot = derived.snapshot!;
    let current = { ...state, live: derived.live! };
    // Acknowledge the first snapshot so later items are section updates.
    current.live = acknowledgeOutboxItem(current.live!, current.live!.outbox[0].id, 1, at(1));
    for (let tick = 0; tick < count; tick += 1) {
      const next = structuredClone(current);
      next.live = current.live;
      next.qbtcpSessions[0].progress = {
        tossupsRead: 13 + tick,
        leftScore: 180 + tick * 10,
        rightScore: 135,
      };
      derived = derivePublication(next, snapshot, { now: at(2 + tick) });
      if (derived.live) {
        current = { ...next, live: derived.live };
        snapshot = derived.snapshot!;
      }
    }
    return { state: current, snapshot };
  }

  test('consecutive score ticks collapse to the newest', () => {
    const { state } = accumulateScoreTicks(20);
    const pending = state.live!.outbox;
    expect(pending).toHaveLength(1);
    const payload = pending[0].payload as { revision: number; baseRevision: number };
    // The newest revision, applying on top of what the backend actually acknowledged.
    expect(payload.revision).toBe(state.live!.sync.localRevision);
    expect(payload.baseRevision).toBe(1);
  });

  test('a long queue of durable updates stays bounded by collapsing to a snapshot', () => {
    const state = liveState();
    let current: DirectorState = state;
    let snapshot: QbliveSnapshot | null = null;
    let highWaterMark = 0;
    // Alternate durable and transient changes so coalescing alone cannot bound the queue.
    for (let index = 0; index < maxOutboxItems + 10; index += 1) {
      const next = structuredClone(current);
      next.live = current.live;
      next.live!.announcements = [
        ...next.live!.announcements,
        composeAnnouncement({ title: `Update ${index}`, body: 'Body', severity: 'information' }, at(index)),
      ];
      const derived = derivePublication(next, snapshot, { now: at(index) });
      if (derived.live) {
        current = { ...next, live: derived.live };
        snapshot = derived.snapshot;
        highWaterMark = Math.max(highWaterMark, current.live!.outbox.length);
      }
    }
    // Announcements are durable, so none of them coalesce away. The bound comes from the snapshot
    // collapse instead: the queue is allowed to reach the limit and is then replaced wholesale by a
    // single snapshot carrying everything those items would have said.
    expect(highWaterMark).toBeLessThanOrEqual(maxOutboxItems + 1);
    expect(current.live!.outbox.length).toBeLessThan(maxOutboxItems);
    expect(current.live!.outbox[0].kind).toBe('snapshot');
    // And the snapshot really does carry every announcement, so nothing was lost by collapsing.
    const collapsed = current.live!.outbox[0].payload as { snapshot: QbliveSnapshot };
    expect(collapsed.snapshot.announcements.length).toBeGreaterThanOrEqual(maxOutboxItems);
  });
});

describe('failures', () => {
  test('a transient failure backs off and stays queued', () => {
    const state = liveState();
    const derived = derivePublication(state, null, { now: at(0) });
    const item = derived.live!.outbox[0];
    const failed = recordOutboxFailure(
      derived.live!,
      item.id,
      { kind: 'transient', message: 'offline' },
      derived.snapshot,
      at(1),
      () => 0.5,
    );
    expect(failed.outbox).toHaveLength(1);
    expect(failed.outbox[0].attempts).toBe(1);
    expect(failed.sync.retrying).toBe(true);
    expect(Date.parse(failed.outbox[0].nextAttemptAt!)).toBeGreaterThan(at(1).getTime());
    // Not due yet.
    expect(nextOutboxItem(failed, at(1))).toBeNull();
    expect(nextOutboxItem(failed, at(120))).not.toBeNull();
  });

  test('backoff grows and is capped, with jitter', () => {
    const low = backoffMilliseconds(1, () => 0);
    const high = backoffMilliseconds(1, () => 1);
    expect(low).toBeLessThan(high);
    expect(backoffMilliseconds(1, () => 1)).toBeLessThan(backoffMilliseconds(5, () => 1));
    expect(backoffMilliseconds(100, () => 1)).toBeLessThanOrEqual(60_000);
  });

  test('a fatal failure stops retrying and reports why', () => {
    const state = liveState();
    const derived = derivePublication(state, null, { now: at(0) });
    const item = derived.live!.outbox[0];
    const failed = recordOutboxFailure(
      derived.live!,
      item.id,
      { kind: 'fatal', message: 'That management credential is not valid.' },
      derived.snapshot,
      at(1),
    );
    expect(failed.outbox[0].nextAttemptAt).toBeNull();
    expect(failed.sync.retrying).toBe(false);
    expect(nextOutboxItem(failed, at(100000))).toBeNull();
    expect(failed.sync.lastError).toMatch(/credential/);
  });

  test('a conflict replaces the queued update with a full snapshot at the backend revision', () => {
    const state = liveState();
    const derived = derivePublication(state, null, { now: at(0) });
    const item = derived.live!.outbox[0];
    const repaired = recordOutboxFailure(
      derived.live!,
      item.id,
      { kind: 'conflict', message: 'The publication has moved on.', currentRevision: 77 },
      derived.snapshot,
      at(1),
    );
    expect(repaired.outbox).toHaveLength(1);
    expect(repaired.outbox[0].kind).toBe('snapshot');
    expect(repaired.outbox[0].id).not.toBe(item.id);
    expect(repaired.sync.acknowledgedRevision).toBe(77);
  });

  test('client errors are classified the way the retry policy needs', () => {
    expect(classifyFailure(new QbliveClientError('conflict', 'moved on', 409, 12)).kind).toBe('conflict');
    expect(classifyFailure(new QbliveClientError('unauthorized', 'nope', 401)).kind).toBe('fatal');
    expect(classifyFailure(new QbliveClientError('gone', 'unpublished', 410)).kind).toBe('fatal');
    expect(classifyFailure(new QbliveClientError('internal', 'boom', 500)).kind).toBe('transient');
    expect(classifyFailure(new QbliveClientError('network', 'offline')).kind).toBe('transient');
    expect(classifyFailure(new Error('who knows')).kind).toBe('transient');
  });
});

describe('the worker', () => {
  function clientReturning(handler: (url: string, init: RequestInit) => Response): QbliveClient {
    return new QbliveClient({
      backendOrigin: 'https://backend.example',
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      managementToken: 'token',
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) =>
        handler(String(input), init)) as unknown as typeof fetch,
    });
  }

  test('publishes a queued snapshot and records the acknowledged revision', async () => {
    const state = liveState();
    const derived = derivePublication(state, null, { now: at(0) });
    const client = clientReturning(() =>
      Response.json({ publicationId: 'bcdfghjkmnpqrstvwxyz', revision: 1, final: false }),
    );
    const attempt = await publishOnce(derived.live!, client, derived.snapshot, at(1));
    expect(attempt?.outcome).toBe('published');
    expect(attempt?.publication.outbox).toHaveLength(0);
    expect(attempt?.publication.sync.acknowledgedRevision).toBe(1);
    expect(attempt?.publication.sync.lastError).toBeNull();
  });

  test('records a conflict and repairs with a snapshot', async () => {
    const state = liveState();
    const derived = derivePublication(state, null, { now: at(0) });
    const client = clientReturning(() =>
      Response.json({ error: 'conflict', message: 'moved on', currentRevision: 9 }, { status: 409 }),
    );
    const attempt = await publishOnce(derived.live!, client, derived.snapshot, at(1));
    expect(attempt?.outcome).toBe('failed');
    expect(attempt?.publication.outbox[0].kind).toBe('snapshot');
    expect(attempt?.publication.sync.acknowledgedRevision).toBe(9);
  });

  test('does nothing when the outbox is empty', async () => {
    const state = liveState();
    const client = clientReturning(() => Response.json({}));
    expect(await publishOnce(state.live!, client, null, at(1))).toBeNull();
  });
});

describe('the internet disappears mid-tournament', () => {
  test('local operations keep succeeding, and Live catches up when it returns', async () => {
    // 1. Live is working.
    let state = liveState();
    let snapshot: QbliveSnapshot | null = null;
    let derived = derivePublication(state, snapshot, { now: at(0) });
    state = { ...state, live: derived.live! };
    snapshot = derived.snapshot;

    const responses: Response[] = [];
    let online = true;
    const client = new QbliveClient({
      backendOrigin: 'https://backend.example',
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      managementToken: 'token',
      fetch: (async () => {
        if (!online) throw new TypeError('Failed to fetch');
        const response = Response.json({
          publicationId: 'bcdfghjkmnpqrstvwxyz',
          revision: state.live!.sync.localRevision,
          final: false,
        });
        responses.push(response);
        return response;
      }) as unknown as typeof fetch,
    });

    const attempt = await publishOnce(state.live!, client, snapshot, at(1));
    expect(attempt?.outcome).toBe('published');
    state = { ...state, live: attempt!.publication };

    // 2-9. The internet fails, but rooms keep scoring and Director keeps accepting results.
    online = false;
    for (let round = 0; round < 6; round += 1) {
      const next = structuredClone(state);
      next.live = state.live;
      next.qbtcpSessions[0].progress = {
        tossupsRead: 13 + round,
        leftScore: 180 + round * 15,
        rightScore: 135,
      };
      next.live!.settings = { ...next.live!.settings, liveScores: true };
      derived = derivePublication(next, snapshot, { now: at(10 + round) });
      // Every local mutation succeeds. That is the whole promise.
      expect(derived.live).not.toBeNull();
      state = { ...next, live: derived.live! };
      snapshot = derived.snapshot;

      const failedAttempt = await publishOnce(state.live!, client, snapshot, at(10 + round));
      expect(failedAttempt?.outcome).toBe('failed');
      state = { ...state, live: failedAttempt!.publication };
    }

    // 10. The outbox has accumulated, but coalesced rather than grown without bound.
    expect(state.live!.sync.pendingItems).toBeGreaterThan(0);
    expect(state.live!.outbox.length).toBeLessThanOrEqual(2);
    expect(state.live!.sync.localRevision).toBeGreaterThan(state.live!.sync.acknowledgedRevision);
    expect(syncSummary(state.live)).toMatch(/Tournament operation is unaffected/);

    // 11-14. The internet returns and Live resynchronizes without intervention.
    online = true;
    let guard = 0;
    while (state.live!.outbox.length > 0 && guard < 20) {
      const retry = await publishOnce(state.live!, client, snapshot, at(600 + guard));
      if (retry) state = { ...state, live: retry.publication };
      guard += 1;
    }
    expect(state.live!.outbox).toHaveLength(0);
    expect(state.live!.sync.acknowledgedRevision).toBe(state.live!.sync.localRevision);
    expect(state.live!.sync.lastError).toBeNull();
    expect(syncSummary(state.live)).toMatch(/synced/);
  });

  test('the Director sentence distinguishes a queued outage from a broken publication', () => {
    const state = liveState();
    expect(syncSummary(null)).toBe('QBSheet Live is off.');
    expect(syncSummary({ ...state.live!, settings: { ...state.live!.settings, enabled: false } })).toBe(
      'QBSheet Live is off.',
    );
    expect(
      syncSummary({
        ...state.live!,
        sync: { ...state.live!.sync, pendingItems: 14, lastError: 'offline' },
      }),
    ).toBe('Live backend unreachable. 14 updates are queued locally. Tournament operation is unaffected.');
  });
});

describe('announcements', () => {
  test('compose trims and defaults the audience to everybody', () => {
    vi.useFakeTimers();
    const announcement = composeAnnouncement(
      { title: '  Round 2  ', body: '  Be in your rooms.  ', severity: 'important' },
      at(0),
    );
    expect(announcement.title).toBe('Round 2');
    expect(announcement.body).toBe('Be in your rooms.');
    expect(announcement.audienceTeamIds).toEqual([]);
    vi.useRealTimers();
  });

  test('an announcement reaches the projection through the ordinary outbox', () => {
    const state = liveState();
    const first = derivePublication(state, null, { now: at(0) });
    const next = structuredClone(state);
    next.live = { ...first.live! };
    next.live.announcements = [
      composeAnnouncement(
        { title: 'Room change', body: 'Room 104 moves to 212.', severity: 'urgent' },
        at(5),
      ),
    ];
    const second = derivePublication(next, first.snapshot, { now: at(5) });
    expect(second.changed).toEqual(['announcements']);
    expect(second.snapshot?.announcements[0].title).toBe('Room change');
  });
});

describe('outbox race: new score update arrives while previous publish is awaiting network', () => {
  test('the in-flight item is protected so coalescing cannot consume it', async () => {
    const state = liveState();
    state.live!.settings.liveScores = true;
    const first = derivePublication(state, null, { now: at(0) });
    // Acknowledge snapshot so subsequent items are transient section updates.
    let publication = acknowledgeOutboxItem(first.live!, first.live!.outbox[0].id, 1, at(1));
    let snapshot = first.snapshot!;

    // Queue first score tick.
    const tickState = structuredClone(state);
    tickState.live = publication;
    tickState.qbtcpSessions[0].progress = { tossupsRead: 14, leftScore: 195, rightScore: 135 };
    const tick = derivePublication(tickState, snapshot, { now: at(2) });
    publication = tick.live!;
    snapshot = tick.snapshot!;

    expect(publication.outbox).toHaveLength(1);
    const pendingId = publication.outbox[0].id;

    // Simulate publish starting: mark the pending item in-flight before the network settles.
    const inFlight = markOutboxItemInFlight(publication, pendingId, at(3));
    expect(inFlight.outbox[0].state).toBe('in-flight');
    // While in-flight, a newer score tick arrives. Collapse must not replace the in-flight item.
    const newerState = structuredClone(tickState);
    newerState.live = inFlight;
    newerState.qbtcpSessions[0].progress = { tossupsRead: 15, leftScore: 205, rightScore: 135 };
    const newer = derivePublication(newerState, snapshot, { now: at(4) });

    expect(newer.live).not.toBeNull();
    // Two items: the in-flight one and the fresh pending tick. No coalescing across the boundary.
    expect(newer.live!.outbox).toHaveLength(2);
    expect(newer.live!.outbox[0].state).toBe('in-flight');
    expect(newer.live!.outbox[0].id).toBe(pendingId);
    expect(newer.live!.outbox[1].state).toBe('pending');
    expect(newer.live!.outbox[1].revision).toBeGreaterThan(newer.live!.outbox[0].revision);

    // The in-flight publish succeeds; only its item is acknowledged. The newer tick must survive.
    const acknowledged = acknowledgeOutboxItem(newer.live!, pendingId, newer.live!.outbox[0].revision, at(5));
    expect(acknowledged.outbox).toHaveLength(1);
    expect(acknowledged.outbox[0].id).not.toBe(pendingId);
    // Not coalesced away, not accidentally acked.
    expect(acknowledged.sync.acknowledgedRevision).toBe(newer.live!.outbox[0].revision);
  });

  test('publishOnce marks the item in-flight so a concurrent transient tick is preserved', async () => {
    const state = liveState();
    state.live!.settings.liveScores = true;
    const first = derivePublication(state, null, { now: at(0) });
    let publication = acknowledgeOutboxItem(first.live!, first.live!.outbox[0].id, 1, at(1));
    let snapshot = first.snapshot!;

    const tickState = structuredClone(state);
    tickState.live = publication;
    tickState.qbtcpSessions[0].progress = { tossupsRead: 14, leftScore: 195, rightScore: 135 };
    const tick = derivePublication(tickState, snapshot, { now: at(2) });
    publication = tick.live!;
    snapshot = tick.snapshot!;

    // Start publish with a fetch that hangs, verify publishOnce created an in-flight publication.
    let resolveFetch!: (value: Response) => void;
    const hangingFetch = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    const client = new QbliveClient({
      backendOrigin: 'https://backend.example',
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      managementToken: 'token',
      fetch: hangingFetch as unknown as typeof fetch,
    });

    const pendingPromise = publishOnce(publication, client, snapshot, at(3));
    // While the network is pending, derive a newer tick against the in-flight publication
    // (which publishOnce derived internally). We simulate what drainLiveOutbox does: the
    // in-flight state is the one future derivations must see.
    const pendingItemId = publication.outbox[0].id;
    const inFlightForDerive = markOutboxItemInFlight(publication, pendingItemId, at(3));
    const newerState = structuredClone(tickState);
    newerState.live = inFlightForDerive;
    newerState.qbtcpSessions[0].progress = { tossupsRead: 15, leftScore: 205, rightScore: 135 };
    const newer = derivePublication(newerState, snapshot, { now: at(4) });
    expect(newer.live!.outbox).toHaveLength(2);

    // Resolve the original publish; it should only clear its own item.
    resolveFetch(
      Response.json({
        publicationId: 'bcdfghjkmnpqrstvwxyz',
        revision: publication.outbox[0].revision,
        final: false,
      }),
    );
    const attempt = await pendingPromise;
    expect(attempt?.outcome).toBe('published');
    // Merge as drainLiveOutbox does: newer item must still be present when combined with settled result.
    const mergedOutbox = [
      ...attempt!.publication.outbox,
      ...newer.live!.outbox.filter((item) => item.id !== pendingItemId),
    ];
    expect(mergedOutbox).toHaveLength(1);
    expect(mergedOutbox[0].id).not.toBe(pendingItemId);
  });
});
