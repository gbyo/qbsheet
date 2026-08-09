/** A timestamp-based room clock. The displayed seconds are never the source of truth. */
export const roomClockVersion = 2;

export type RoomClockSegment = string;

/** Select the persisted timer from derived procedure state, never from elapsed wall-clock time. */
export function roomClockSegment(
  halves: boolean | undefined,
  halfBreakCount: number,
  awaitingScoreCheck: boolean,
  overtimeStarted: boolean,
): RoomClockSegment {
  if (overtimeStarted) return 'overtime';
  if (halves && halfBreakCount > 0 && !awaitingScoreCheck) return 'half-2';
  return 'half-1';
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

export function idleRoomClock(durationMs: number): IRoomClockState {
  return { version: roomClockVersion, durationMs, status: 'idle', accumulatedMs: 0 };
}

export function resetRoomClock(state: IRoomClockState): IRoomClockState {
  return idleRoomClock(state.durationMs);
}

export function elapsedRoomClock(state: IRoomClockState, now = Date.now()): number {
  const running = state.status === 'running' && state.runningSince !== undefined ? now - state.runningSince : 0;
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
    (raw.status !== 'idle' && raw.status !== 'running' && raw.status !== 'paused' && raw.status !== 'expired') ||
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
  if (raw.status === 'running' && (typeof raw.runningSince !== 'number' || !Number.isFinite(raw.runningSince))) {
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

export function loadRoomClock(
  gameKey: string,
  durationMs: number,
  storage: IClockStorage | null = browserStorage(),
  segment: RoomClockSegment = 'regulation',
): IRoomClockState {
  if (!storage || gameKey === '') return idleRoomClock(durationMs);
  try {
    return normalizeRoomClock(JSON.parse(storage.getItem(storageKey(gameKey, segment)) ?? 'null'), durationMs);
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

export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
