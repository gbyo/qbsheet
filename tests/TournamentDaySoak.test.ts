/**
 * Can one device survive Saturday?
 *
 * # A different question from the rest of the suite
 *
 * Everything else here asks whether scoring is correct: the state space, the property tests, the
 * mutation run. Those are about one game, and they are thorough. None of them asks the question a
 * tournament director actually has, which is whether the Chromebook in Room 204 still works at four
 * o'clock having been open since eight — through eleven games, three deploys, a Wi-Fi drop in round
 * five, a server restart over lunch, a lid closed for forty minutes, and a clock that corrected itself
 * backwards at some point nobody noticed.
 *
 * That question is about *accumulation and sequence*, not about arithmetic. The failures it catches are
 * the ones where each subsystem is individually correct and the composition is not: a record migrated
 * by a build that then got rolled back, a journal keyed to a game the store has pruned, a prune that
 * runs with a clock an hour behind the completion it is measuring.
 *
 * # The invariants, which matter more than the scenarios
 *
 * Scenarios are a list somebody thought of. Invariants are what has to be true regardless, so they are
 * asserted after every single round of every scenario below, and they are the actual content of this
 * file:
 *
 *   1. **No completed game ever disappears.** Not to a prune, not to a reload, not to a migration.
 *   2. **No completed result ever changes.** A score recorded in round three reads the same in round
 *      eleven.
 *   3. **An unfinished game survives a reload with every event intact.**
 *   4. **Nothing unbounded grows.** Not the timeline, not the error log, not the journal.
 *
 * # Why this is at the store level and not through the screens
 *
 * Because forty games through the real React screens is four minutes of jsdom, and the interactions
 * being tested are between the store, the journal and the migration reader — none of which the screens
 * contribute to. The hazards that genuinely are about the screens — a reload mid-round, a second tab,
 * a browser that has stopped saving — are in `TournamentDayScreens.test.tsx`.
 *
 * The network hazards are at the bottom of this file, against the connected runtime rather than a
 * server, because what is being tested is the room's response to a morning of failures and not the
 * protocol. `QbtcpContract.spec.ts` covers the protocol against a real one.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { GameStore, IStoredGameRecord, isActive, completedGameRetentionMs } from '../src/game/GameStore';
import { gameRecordVersion, readStoredRecord } from '../src/game/GameRecordUpgrade';
import { openRecordStore } from '../src/persistence/GameDatabase';
import { clearGame, loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import deriveGame from '../src/scoring/deriveGame';
import { IGamePackage } from '../src/game/GamePackage';
import { setupFromPackage } from '../src/app/App';
import { ConnectionTimeline, timelineLimit } from '../src/app/ConnectionTimeline';
import { ErrorLog, errorLogLimit } from '../src/app/ErrorLog';
import useConnectedRuntime, { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import { RoomConnectionState } from '../src/app/ConnectionState';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';
import { progressIntervalMs } from '../src/integrations/fruity/FruityResultDestination';
import { validPackage } from './packages';
import { event } from './events';

/** The round this game is, turned into a package with its own identity. */
function packageForRound(round: number): IGamePackage {
  return validPackage({
    scheduledMatchId: `sched-${round}`,
    round: { number: round, name: `Round ${round}`, revision: 1, packetName: `Packet ${round}` },
  });
}

/** The index of the answer type worth this many points, which is what an event references. */
function answerIndex(packageValue: IGamePackage, value: number): number {
  const found = packageValue.scorekeeperFormat.answerTypes.find((type) => type.value === value);
  if (!found) throw new Error(`This format has no answer worth ${value}`);
  return found.index;
}

/**
 * A short but real game: eight converted tossups, alternating, each with a bonus.
 *
 * Short because this file plays dozens of them and the arithmetic is exhaustively tested elsewhere.
 * Real because the events have to be ones `deriveGame` accepts — a soak test built on events the
 * engine rejects would prove that nothing breaks while nothing is being scored.
 */
function gameEvents(packageValue: IGamePackage, questions = 8): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  for (let question = 1; question <= questions; question += 1) {
    const team = question % 2 === 1 ? 'left' : 'right';
    const player = question % 2 === 1 ? 'Sarah Mitchell' : 'Emma Chen';
    events.push(
      event({
        type: 'tossup-buzz',
        questionNumber: question,
        team,
        playerName: player,
        answerTypeIndex: answerIndex(packageValue, 10),
      }),
    );
    events.push(event({ type: 'bonus', questionNumber: question, team, controlledPoints: 20 }));
  }
  return events;
}

/** What a finished game is remembered as, for the "nothing ever changes" invariant. */
interface IResultLedger {
  id: string;
  round: number;
  left: number;
  right: number;
}

/**
 * One Chromebook, across a day.
 *
 * `reload` is the important method. It throws away every object the application was holding and opens
 * the store again over the same IndexedDB, which is exactly what pressing F5 does and is the only
 * honest way to test that something survived.
 */
class Chromebook {
  store!: GameStore;

  readonly timeline = new ConnectionTimeline();

  readonly errors = new ErrorLog();

  /** Every result this device has produced, as it was at the moment it was produced. */
  readonly ledger: IResultLedger[] = [];

  /** The device's own idea of the time. Moved deliberately; occasionally moved backwards. */
  private clock = Date.parse('2026-04-11T08:00:00.000Z');

  private schema = { version: gameRecordVersion, steps: {} as Record<number, never> };

  now(): Date {
    return new Date(this.clock);
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  /** An NTP sync, a manual change, a machine that booted with no network. */
  correctClockBackward(ms: number): void {
    this.clock -= ms;
  }

  async boot(): Promise<void> {
    this.store = new GameStore(await openRecordStore<IStoredGameRecord>(), this.schema);
    await this.store.prune(this.now());
  }

  /** Everything the application was holding is gone; the browser's storage is not. */
  async reload(): Promise<void> {
    await this.boot();
  }

  /** Deploy a new build to this device: it now believes in a later record schema. */
  async upgradeSchema(): Promise<void> {
    const from = this.schema.version;
    this.schema = {
      version: from + 1,
      steps: { [from]: (record: Record<string, unknown>) => record } as unknown as Record<number, never>,
    };
    await this.boot();
  }

  async playRound(round: number, options: { finish?: boolean } = {}): Promise<IStoredGameRecord> {
    const packageValue = packageForRound(round);
    const record = await this.store.create({
      package: packageValue,
      setup: setupFromPackage(packageValue),
      connected: false,
      now: this.now(),
    });

    // Through `saveEvents`, so the synchronous journal is written exactly as the scorer writes it.
    const events = gameEvents(packageValue);
    this.store.saveEvents(record.id, events);
    this.advance(20 * 60 * 1000);

    if (options.finish === false) return record;

    const game = deriveGame(packageValue.scorekeeperFormat, record.setup, events);
    const finalScore = { left: game.left.points, right: game.right.points };
    await this.store.update(record.id, {
      events,
      completedAt: this.now().toISOString(),
      finalScore,
      updatedAt: this.now().toISOString(),
    });
    // The journal belongs to the game in progress. A finished game leaving it behind is how a device
    // accumulates a day of dead entries in a five-megabyte quota.
    clearGame(record.gameKey);
    this.ledger.push({ id: record.id, round, ...finalScore });
    this.advance(10 * 60 * 1000);
    return record;
  }

  /**
   * The four things that have to be true no matter what just happened.
   *
   * Called after every round of every scenario. This is the content of the file; the scenarios are
   * only ways of getting the device into interesting states.
   */
  async assertInvariants(): Promise<void> {
    const records = await this.store.list();
    const byId = new Map(records.map((record) => [record.id, record]));

    for (const remembered of this.ledger) {
      const found = byId.get(remembered.id);
      // 1. No completed game ever disappears.
      expect(found, `round ${remembered.round} is gone from this device`).toBeDefined();
      // 2. No completed result ever changes.
      expect(found?.finalScore, `round ${remembered.round} changed score`).toEqual({
        left: remembered.left,
        right: remembered.right,
      });
      expect(found?.completedAt).toBeDefined();
    }

    // 4. Nothing unbounded grows.
    expect(this.timeline.entries().length).toBeLessThanOrEqual(timelineLimit);
    expect(this.errors.entries().length).toBeLessThanOrEqual(errorLogLimit);
    // At most one game is ever unfinished on one device.
    expect(records.filter(isActive).length).toBeLessThanOrEqual(1);
    // Nothing this build cannot read.
    expect(this.store.unreadable).toEqual([]);
  }
}

let device: Chromebook;

beforeEach(async () => {
  device = new Chromebook();
  await device.boot();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.indexedDB = new IDBFactory();
});

describe('a whole day of games', () => {
  test('twenty-four sequential games, each one still readable at the end', async () => {
    for (let round = 1; round <= 24; round += 1) {
      await device.playRound(round);
      await device.assertInvariants();
    }

    const records = await device.store.list();
    expect(records).toHaveLength(24);
    expect(device.ledger).toHaveLength(24);
  });

  test('a day of games leaves no journal entries behind', async () => {
    for (let round = 1; round <= 12; round += 1) await device.playRound(round);

    // Every finished game's journal was cleared as it finished. A day that accumulates twelve dead
    // journals is a day that ends with the one journal that matters unable to write.
    const records = await device.store.list();
    for (const record of records) {
      expect(loadGame(record.gameKey), `round ${record.package.round.number} left a journal`).toBeNull();
    }
  });

  test('a reload between every single game loses nothing', async () => {
    for (let round = 1; round <= 12; round += 1) {
      await device.playRound(round);
      await device.reload();
      await device.assertInvariants();
    }

    expect(await device.store.list()).toHaveLength(12);
  });
});

describe('hazards between rounds', () => {
  test('a build deployed between rounds does not disturb the games already scored', async () => {
    await device.playRound(1);
    await device.playRound(2);

    // The deploy: a new worker takes over and the build that comes up believes in a later schema.
    // Whether the swap is allowed to happen mid-game is `AppUpdate.test.ts`; this is about what the
    // games already on the device look like afterwards.
    await device.upgradeSchema();

    await device.assertInvariants();
    await device.playRound(3);
    await device.assertInvariants();

    // And the migrated records now carry the new build's version rather than being re-migrated daily.
    const records = await device.store.list();
    expect(records.every((record) => record.version === gameRecordVersion + 1)).toBe(true);
  });

  test('three deploys across a day, with games either side of each', async () => {
    for (let round = 1; round <= 9; round += 1) {
      if (round % 3 === 0) await device.upgradeSchema();
      await device.playRound(round);
      await device.assertInvariants();
    }

    expect(device.ledger).toHaveLength(9);
    expect((await device.store.list()).length).toBe(9);
  });

  test('a clock that corrects itself backwards mid-morning loses nothing to the prune', async () => {
    await device.playRound(1);
    await device.playRound(2);

    // The prune measures a completion against `now`. A device an hour behind the games it has already
    // finished must not conclude anything about their age.
    device.correctClockBackward(3 * 60 * 60 * 1000);
    await device.reload();

    await device.assertInvariants();
    await device.playRound(3);
    await device.assertInvariants();
  });

  test('a long idle period does not prune the day it just played', async () => {
    for (let round = 1; round <= 4; round += 1) await device.playRound(round);

    // A lid closed over lunch, then opened again.
    device.advance(90 * 60 * 1000);
    await device.reload();

    await device.assertInvariants();
    expect(await device.store.list()).toHaveLength(4);
  });

  test('games older than the retention window go, and only those', async () => {
    await device.playRound(1);
    const kept = device.ledger[0];

    // Next weekend. The retention window is deliberately generous, and this is the one case where a
    // record is allowed to leave, so it is asserted rather than assumed.
    device.advance(completedGameRetentionMs + 60 * 1000);
    await device.reload();
    await device.playRound(2);

    const records = await device.store.list();
    expect(records.map((record) => record.id)).not.toContain(kept.id);
    expect(records).toHaveLength(1);
  });
});

describe('an unfinished game', () => {
  test('survives a reload with every event intact', async () => {
    const started = await device.playRound(5, { finish: false });
    const before = await device.store.get(started.id);

    await device.reload();

    const after = await device.store.get(started.id);
    expect(after?.events).toEqual(before?.events);
    expect(isActive(after as IStoredGameRecord)).toBe(true);
  });

  test('survives a reload with the same score', async () => {
    const started = await device.playRound(5, { finish: false });
    const scoreOf = async () => {
      const record = (await device.store.get(started.id)) as IStoredGameRecord;
      const game = deriveGame(record.package.scorekeeperFormat, record.setup, record.events);
      return { left: game.left.points, right: game.right.points };
    };
    const before = await scoreOf();

    await device.reload();

    expect(await scoreOf()).toEqual(before);
  });

  test('survives a build upgrade mid-game', async () => {
    // The case the version constant used to break: a game in progress when a deploy lands.
    const started = await device.playRound(5, { finish: false });
    const before = await device.store.get(started.id);

    await device.upgradeSchema();

    const after = await device.store.get(started.id);
    expect(after).not.toBeNull();
    expect(after?.events).toEqual(before?.events);
    expect(after?.version).toBe(gameRecordVersion + 1);
  });

  test('survives twenty reloads in a row', async () => {
    // A Chromebook with a loose lid, or a scorekeeper who keeps hitting the wrong key.
    const started = await device.playRound(5, { finish: false });
    const before = await device.store.get(started.id);

    for (let reload = 0; reload < 20; reload += 1) await device.reload();

    expect((await device.store.get(started.id))?.events).toEqual(before?.events);
  });

  test('is never pruned, however old it is', async () => {
    const started = await device.playRound(5, { finish: false });

    device.advance(completedGameRetentionMs * 4);
    await device.reload();

    expect(await device.store.get(started.id)).not.toBeNull();
  });
});

describe('a record from a build this device does not have', () => {
  test('is not offered, not deleted, and named out loud', async () => {
    await device.playRound(1);

    // A rollback: this device ran a newer build this morning and is now on the older one.
    const records = await openRecordStore<IStoredGameRecord>();
    const existing = (await records.list())[0];
    await records.put({ ...existing, id: 'from-a-newer-build', version: gameRecordVersion + 5 });
    await device.reload();

    const listed = await device.store.list();
    expect(listed.map((record) => record.id)).not.toContain('from-a-newer-build');
    // Still in storage, for the build that wrote it.
    expect((await records.list()).map((record) => record.id)).toContain('from-a-newer-build');
    expect(device.store.unreadable).toEqual([
      { id: 'from-a-newer-build', readability: 'too-new', storedVersion: gameRecordVersion + 5 },
    ]);
  });

  test('a prune does not take it either', async () => {
    const records = await openRecordStore<IStoredGameRecord>();
    const packageValue = packageForRound(1);
    await records.put({
      version: gameRecordVersion + 5,
      id: 'from-a-newer-build',
      identity: 'x',
      attempt: 1,
      gameKey: 'x',
      package: packageValue,
      setup: setupFromPackage(packageValue),
      events: [],
      connected: false,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      completedAt: '2020-01-01T00:00:00.000Z',
      serverDelivery: 'none',
    });

    await device.reload();

    expect((await records.list()).map((record) => record.id)).toContain('from-a-newer-build');
  });

  test('reading it is refused rather than guessed at', () => {
    const stored = { version: gameRecordVersion + 5, id: 'x' };

    expect(readStoredRecord(stored).record).toBeNull();
    expect(readStoredRecord(stored).readability).toBe('too-new');
  });
});

describe('what accumulates over a day', () => {
  test('the connection timeline stays bounded through a morning of flapping', () => {
    // Wi-Fi that drops and returns every few minutes for four hours.
    for (let minute = 0; minute < 240; minute += 1) {
      device.timeline.record(minute % 7 === 0 ? 'offline' : 'connected');
      device.timeline.record('progress-sent');
      if (minute % 23 === 0) device.timeline.record('session-reopened');
    }

    expect(device.timeline.entries().length).toBeLessThanOrEqual(timelineLimit);
    // And it is the recent end that survived, which is the end anybody debugging needs.
    const entries = device.timeline.entries();
    expect(entries[entries.length - 1].seq).toBeGreaterThan(entries[0].seq);
  });

  test('the error log stays bounded through a component that throws all day', () => {
    for (let index = 0; index < 500; index += 1) {
      device.errors.record('uncaught', new Error('the same broken effect'));
    }

    // Collapsed rather than accumulated: one problem, not five hundred.
    expect(device.errors.entries()).toHaveLength(1);
    expect(device.errors.entries()[0].count).toBe(500);
  });

  test('many distinct errors are still bounded', () => {
    for (let index = 0; index < 500; index += 1) {
      device.errors.record('uncaught', new Error(`failure ${index}`));
    }

    expect(device.errors.entries().length).toBeLessThanOrEqual(errorLogLimit);
  });
});

/**
 * A tournament server that can be broken on purpose.
 *
 * Built as a switchboard rather than a sequence of canned replies, because the scenarios below are
 * about *transitions* — up, then down, then up again, then refusing one particular call — and a queue
 * of responses would make each test a puzzle about ordering rather than a description of a morning.
 */
class FakeControl {
  /** Nothing answers. Dropped Wi-Fi, or a laptop that went to sleep. */
  offline = false;

  /** Answers, but not usefully. A 500, a proxy, a captive portal. */
  degraded = false;

  /** The session token is no longer recognized. What a restarted server looks like. */
  sessionRevoked = false;

  /** The room token is no longer recognized. The pairing really is gone; a new code fixes it. */
  roomRevoked = false;

  /**
   * Control accepts the credential and will not act on it — most often this origin is not on the
   * server's allowlist. A pairing code cannot fix this, and offering one is a task that cannot succeed.
   */
  forbidden = false;

  readonly snapshots: object[] = [];

  reopens = 0;

  private answer<T>(value: T) {
    if (this.offline) return { ok: false as const, status: undefined, error: 'Network unavailable' };
    if (this.degraded) return { ok: false as const, status: 500, error: 'Server error', detail: 'HTTP 500' };
    if (this.roomRevoked) return { ok: false as const, status: 401, error: 'Room not recognized' };
    if (this.forbidden) {
      return { ok: false as const, status: 403, error: 'Forbidden', detail: 'This origin is not allowed.' };
    }
    return { ok: true as const, value };
  }

  asClient(): FruityServerClient {
    return {
      ensureDiscovered: async () => null,
      assignment: async () =>
        this.answer({
          state: 'assigned',
          roomId: 'room-204',
          roomName: 'Room 204',
          tournamentName: 'Spring Invitational',
          definition: null,
          session: null,
          scheduledMatchId: 'sched-5',
        }),
      putSnapshot: async (_credentials: unknown, qbj: object) => {
        if (this.offline) return { ok: false as const, status: undefined, error: 'Network unavailable' };
        if (this.sessionRevoked) return { ok: false as const, status: 401, error: 'Session not recognized' };
        this.snapshots.push(qbj);
        return { ok: true as const, value: {} };
      },
      openSession: async () => {
        if (this.offline) return { ok: false as const, status: undefined, error: 'Network unavailable' };
        this.reopens += 1;
        // A restarted server reopens the same session with the room capability, which is what makes
        // this a repair rather than a new game.
        this.sessionRevoked = false;
        return { ok: true as const, value: { sessionId: 'session-5', token: 'session-token', writer: true } };
      },
      postFinal: async () => this.answer({ duplicate: false }),
      takeWriter: async () => this.answer({ sessionId: 'session-5', token: 'session-token' }),
      recover: async () => this.answer({ latestQbj: {} }),
      addRosterPlayer: async () => this.answer({}),
      requestHelp: async () => this.answer({}),
    } as unknown as FruityServerClient;
  }
}

/** Mount the runtime against a breakable server, with its own history to assert on. */
function room(control: FakeControl, timeline: ConnectionTimeline) {
  return renderHook(() =>
    useConnectedRuntime({
      client: control.asClient(),
      identity: { roomId: 'room-204', token: 'room-token', deviceId: 'device-1', roomName: 'Room 204' },
      credentials: { sessionId: 'session-5', token: 'session-token' },
      scheduledMatchId: 'sched-5',
      enabled: true,
      timeline,
    }),
  );
}

/** Let the poll and the trailing snapshot sender both come round. */
async function nextPoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(Math.max(assignmentPollIntervalMs, progressIntervalMs) + 50);
  });
}

describe('a morning of network failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test('Wi-Fi that drops and returns keeps scoring and resumes sending', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    act(() => hook.result.current.reportProgress({ q: 1 }));
    await nextPoll();
    const sentWhileUp = control.snapshots.length;
    expect(sentWhileUp).toBeGreaterThan(0);

    control.offline = true;
    act(() => hook.result.current.reportProgress({ q: 2 }));
    await nextPoll();
    expect(hook.result.current.connection).toBe(RoomConnectionState.Offline);
    // Nothing reached control, and nothing pretended to.
    expect(control.snapshots).toHaveLength(sentWhileUp);

    control.offline = false;
    // Twice: the poll re-offers the newest state, and the trailing sender's window has to come round
    // again before it actually goes. Convergence is eventual, and asserting otherwise would be
    // asserting the throttle away.
    await nextPoll();
    await nextPoll();

    expect(hook.result.current.connection).toBe(RoomConnectionState.Connected);
    // Reconnecting converges on the newest state rather than replaying what it missed.
    expect(control.snapshots.length).toBeGreaterThan(sentWhileUp);
    expect(control.snapshots[control.snapshots.length - 1]).toEqual({ q: 2 });
    hook.unmount();
  });

  test('the history says what happened, in order, once per transition', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    await nextPoll();
    control.offline = true;
    await nextPoll();
    await nextPoll();
    await nextPoll();
    control.offline = false;
    await nextPoll();

    const kinds = timeline.entries().map((entry) => entry.kind);
    // The drop and the recovery are each one line however many polls happened inside them. That is what
    // makes this readable by a person rather than a log.
    expect(kinds.filter((kind) => kind === 'offline')).toHaveLength(1);
    expect(kinds.indexOf('offline')).toBeLessThan(kinds.lastIndexOf('connected'));
    hook.unmount();
  });

  test('a server restarted over lunch is repaired without anybody pressing anything', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    act(() => hook.result.current.reportProgress({ q: 5 }));
    await nextPoll();

    control.sessionRevoked = true;
    act(() => hook.result.current.reportProgress({ q: 6 }));
    await nextPoll();

    // The one unattended reopen. The scorekeeper saw nothing, which is why the history matters.
    expect(control.reopens).toBe(1);
    expect(timeline.entries().map((entry) => entry.kind)).toContain('session-reopened');

    act(() => hook.result.current.reportProgress({ q: 7 }));
    await nextPoll();

    expect(control.snapshots[control.snapshots.length - 1]).toEqual({ q: 7 });
    hook.unmount();
  });

  test('a revoked room token stops writes, offers a code, and never stops the game', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    await nextPoll();
    control.roomRevoked = true;
    await nextPoll();

    // Writing stops, because filing snapshots with credentials control has withdrawn is worse than
    // not filing them.
    expect(hook.result.current.automaticDelivery).toBe(false);
    // A 401 is the one refusal a pairing code actually fixes, so that is the task offered.
    expect(hook.result.current.alerts.map((alert) => alert.id)).toContain('credentials');
    expect(hook.result.current.alerts.every((alert) => alert.offerDownload === true)).toBe(true);
    expect(timeline.entries().map((entry) => entry.kind)).toContain('room-refused');
    hook.unmount();
  });

  test('a forbidden origin is not mistaken for a lost pairing', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    await nextPoll();
    control.forbidden = true;
    await nextPoll();

    // The distinction that matters: handing somebody a pairing code for this sends them to find a slip
    // of paper that cannot help, and throws away a room capability that was working.
    const ids = hook.result.current.alerts.map((alert) => alert.id);
    expect(ids).toContain('forbidden');
    expect(ids).not.toContain('credentials');
    expect(hook.result.current.automaticDelivery).toBe(false);
    hook.unmount();
  });

  test('a final submitted while the room is barred is refused honestly, not left pending', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    await nextPoll();
    control.roomRevoked = true;
    await nextPoll();

    const delivery = await hook.result.current.submitFinal({ final: true });

    // `pending` would tell a scorekeeper to wait for a delivery that is never coming.
    expect(delivery.delivery).toBe('rejected');
    hook.unmount();
  });

  test('four hours of flapping does not grow the history without bound', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    for (let cycle = 0; cycle < 40; cycle += 1) {
      control.offline = cycle % 2 === 0;
      await nextPoll();
    }

    expect(timeline.entries().length).toBeLessThanOrEqual(timelineLimit);
    hook.unmount();
  });

  test('a degraded server is not called offline, because the two need different answers', async () => {
    const control = new FakeControl();
    const timeline = new ConnectionTimeline();
    const hook = room(control, timeline);

    control.degraded = true;
    await nextPoll();

    // "Offline — keep scoring" and "control answered but the room state may be stale" send a
    // scorekeeper to different places.
    expect(hook.result.current.connection).toBe(RoomConnectionState.Degraded);
    expect(hook.result.current.degradedMessage).toBeDefined();
    hook.unmount();
  });
});
