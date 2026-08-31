/** A timestamp-based room clock. The displayed seconds are never the source of truth. */
export const roomClockVersion = 2;

export type RoomClockSegment = string;

/**
 * Select the persisted timer from derived procedure state, never from elapsed wall-clock time.
 *
 * A round with configured breaks has as many play segments as it has breaks, plus one, so the segment
 * is the number of breaks behind the room rather than a choice between two halves. The `half-N`
 * naming is kept because it is already in the storage keys of every device that has run a timed game,
 * and renaming it would silently discard a clock a room is in the middle of.
 *
 * A score check belongs to the segment that just ended, not the one about to start: the room is still
 * agreeing the score of the half it played, and the clock it is looking at is that half's.
 */
export function roomClockSegment(
  takesBreaks: boolean | undefined,
  breaksTaken: number,
  awaitingScoreCheck: boolean,
  overtimeStarted: boolean,
): RoomClockSegment {
  if (overtimeStarted) return 'overtime';
  if (!takesBreaks || breaksTaken <= 0) return 'half-1';
  const segmentsFinished = awaitingScoreCheck ? breaksTaken - 1 : breaksTaken;
  return `half-${Math.max(0, segmentsFinished) + 1}`;
}

export type RoomClockStatus = 'idle' | 'running' | 'paused' | 'expired';
export type RoomClockPauseReason = 'manual' | 'timeout' | 'checkpoint' | undefined;

export interface IRoomClockState {
  version: number;
  durationMs: number;
  status: RoomClockStatus;
  accumulatedMs: number;
  runningSince?: number;
  pauseReason?: Exclude<RoomClockPauseReason, undefined>;
}

interface IClockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  length?: number;
  key?: (index: number) => string | null;
}

function browserStorage(): IClockStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(gameKey: string, segment: RoomClockSegment): string {
  return `yellowfruit.room.clock.v${roomClockVersion}.${encodeURIComponent(gameKey)}.${encodeURIComponent(segment)}`;
}

function storagePrefix(gameKey: string): string {
  return `yellowfruit.room.clock.v${roomClockVersion}.${encodeURIComponent(gameKey)}.`;
}

export function idleRoomClock(durationMs: number): IRoomClockState {
  return { version: roomClockVersion, durationMs, status: 'idle', accumulatedMs: 0 };
}

export function resetRoomClock(state: IRoomClockState): IRoomClockState {
  return idleRoomClock(state.durationMs);
}

export function elapsedRoomClock(state: IRoomClockState, now = Date.now()): number {
  const running =
    state.status === 'running' && state.runningSince !== undefined ? now - state.runningSince : 0;
  return Math.min(state.durationMs, Math.max(0, state.accumulatedMs + running));
}

export function remainingRoomClock(state: IRoomClockState, now = Date.now()): number {
  return Math.max(0, state.durationMs - elapsedRoomClock(state, now));
}

export function normalizeRoomClock(value: unknown, durationMs: number): IRoomClockState {
  if (typeof value !== 'object' || value === null) return idleRoomClock(durationMs);
  const raw = value as Partial<IRoomClockState>;
  if (
    raw.version !== roomClockVersion ||
    raw.durationMs !== durationMs ||
    (raw.status !== 'idle' &&
      raw.status !== 'running' &&
      raw.status !== 'paused' &&
      raw.status !== 'expired') ||
    typeof raw.accumulatedMs !== 'number' ||
    !Number.isFinite(raw.accumulatedMs) ||
    raw.accumulatedMs < 0
  ) {
    return idleRoomClock(durationMs);
  }
  if ((durationMs > 0 && raw.accumulatedMs >= durationMs) || raw.status === 'expired') {
    return { version: roomClockVersion, durationMs, status: 'expired', accumulatedMs: durationMs };
  }
  if (raw.status === 'idle') return idleRoomClock(durationMs);
  if (
    raw.status === 'running' &&
    (typeof raw.runningSince !== 'number' || !Number.isFinite(raw.runningSince))
  ) {
    return idleRoomClock(durationMs);
  }
  if (raw.status === 'paused') {
    return {
      version: roomClockVersion,
      durationMs,
      status: 'paused',
      accumulatedMs: raw.accumulatedMs,
      ...(raw.pauseReason === 'manual' || raw.pauseReason === 'timeout' || raw.pauseReason === 'checkpoint'
        ? { pauseReason: raw.pauseReason }
        : {}),
    };
  }
  return {
    version: roomClockVersion,
    durationMs,
    status: 'running',
    accumulatedMs: raw.accumulatedMs,
    runningSince: raw.runningSince,
  };
}

export function startRoomClock(state: IRoomClockState, now = Date.now()): IRoomClockState {
  if (state.status === 'running') return state;
  if (state.status === 'expired' || remainingRoomClock(state, now) <= 0) {
    return { ...state, status: 'expired', accumulatedMs: state.durationMs, runningSince: undefined };
  }
  return { ...state, status: 'running', runningSince: now, pauseReason: undefined };
}

export function pauseRoomClock(
  state: IRoomClockState,
  reason: Exclude<RoomClockPauseReason, undefined> = 'manual',
  now = Date.now(),
): IRoomClockState {
  if (state.status !== 'running') return state;
  const elapsed = elapsedRoomClock(state, now);
  return {
    ...state,
    accumulatedMs: elapsed,
    status: elapsed >= state.durationMs ? 'expired' : 'paused',
    runningSince: undefined,
    pauseReason: elapsed >= state.durationMs ? undefined : reason,
  };
}

export function resumeRoomClock(state: IRoomClockState, now = Date.now()): IRoomClockState {
  if (state.status !== 'paused') return state;
  return startRoomClock(state, now);
}

export function expireRoomClock(state: IRoomClockState, now = Date.now()): IRoomClockState {
  if (state.status !== 'running' || elapsedRoomClock(state, now) < state.durationMs) return state;
  return {
    ...state,
    status: 'expired',
    accumulatedMs: state.durationMs,
    runningSince: undefined,
    pauseReason: undefined,
  };
}

/**
 * Freeze a clock for transfer to another device.
 *
 * A portable file must not carry a `runningSince` wall-clock timestamp: moving a file between
 * Chromebooks is not time played. Running clocks are therefore snapshotted at the export instant
 * and restored paused. Same-device recovery continues to use `loadRoomClock` and its normal wall
 * clock semantics.
 */
export function snapshotRoomClock(state: IRoomClockState, now = Date.now()): IRoomClockState {
  if (state.status !== 'running') return normalizeRoomClock(state, state.durationMs);
  return normalizeRoomClock(pauseRoomClock(state, 'manual', now), state.durationMs);
}

export function loadRoomClock(
  gameKey: string,
  durationMs: number,
  storage: IClockStorage | null = browserStorage(),
  segment: RoomClockSegment = 'regulation',
): IRoomClockState {
  if (!storage || gameKey === '') return idleRoomClock(durationMs);
  try {
    return normalizeRoomClock(
      JSON.parse(storage.getItem(storageKey(gameKey, segment)) ?? 'null'),
      durationMs,
    );
  } catch {
    return idleRoomClock(durationMs);
  }
}

export function saveRoomClock(
  gameKey: string,
  state: IRoomClockState,
  storage: IClockStorage | null = browserStorage(),
  segment: RoomClockSegment = 'regulation',
): boolean {
  if (!storage || gameKey === '') return false;
  try {
    storage.setItem(storageKey(gameKey, segment), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearRoomClock(
  gameKey: string,
  storage: IClockStorage | null = browserStorage(),
  segment: RoomClockSegment = 'regulation',
): void {
  try {
    storage?.removeItem(storageKey(gameKey, segment));
  } catch {
    // Clock persistence is a recovery convenience, never a reason to stop scoring.
  }
}

/**
 * Read every persisted segment for one game as transfer-safe snapshots.
 *
 * Clock storage is auxiliary. A missing, inaccessible or malformed segment simply disappears from
 * the returned map; the scoring history remains usable and a destination can start that segment's
 * clock from idle if necessary.
 */
export function exportRoomClocks(
  gameKey: string,
  now = Date.now(),
  storage: IClockStorage | null = browserStorage(),
): Record<string, IRoomClockState> {
  const found: Record<string, IRoomClockState> = {};
  if (!storage || gameKey === '' || typeof storage.length !== 'number' || typeof storage.key !== 'function')
    return found;
  const prefix = storagePrefix(gameKey);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(prefix)) continue;
      const encodedSegment = key.slice(prefix.length);
      let segment: string;
      try {
        segment = decodeURIComponent(encodedSegment);
      } catch {
        continue;
      }
      if (segment === '') continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null) continue;
      const durationMs = (value as Partial<IRoomClockState>).durationMs;
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) continue;
      const state = normalizeRoomClock(value, durationMs);
      found[segment] = snapshotRoomClock(state, now);
    }
  } catch {
    // Return whatever was collected before storage refused enumeration.
  }
  return found;
}

/** Restore transfer-safe segment snapshots under a new local game key. */
export function restoreRoomClocks(
  gameKey: string,
  clocks: Record<string, IRoomClockState> | undefined,
  storage: IClockStorage | null = browserStorage(),
): void {
  if (!storage || gameKey === '' || !clocks) return;
  for (const [segment, state] of Object.entries(clocks)) {
    if (segment === '' || !/^[A-Za-z0-9._-]+$/.test(segment)) continue;
    const normalized =
      typeof state?.durationMs === 'number' && Number.isFinite(state.durationMs) && state.durationMs >= 0
        ? normalizeRoomClock(state, state.durationMs)
        : null;
    if (!normalized) continue;
    // A transferred clock is always paused, even if a caller supplied `running`. The export already
    // measured a running clock at its own snapshot instant; using Date.now() here would charge the
    // time spent copying the file as if the room were still playing.
    const paused: IRoomClockState =
      normalized.status === 'running'
        ? {
            version: normalized.version,
            durationMs: normalized.durationMs,
            status: 'paused',
            accumulatedMs: normalized.accumulatedMs,
            pauseReason: 'manual',
          }
        : normalized;
    saveRoomClock(gameKey, paused, storage, segment);
  }
}

export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
