import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  elapsedRoomClock,
  expireRoomClock,
  formatClock,
  idleRoomClock,
  IRoomClockState,
  loadRoomClock,
  pauseRoomClock,
  remainingRoomClock,
  resetRoomClock,
  resumeRoomClock,
  saveRoomClock,
  startRoomClock,
} from './RoomClock';

export interface IRoomClockApi {
  configured: boolean;
  state: IRoomClockState;
  elapsedMs: number;
  remainingMs: number;
  display: string;
  start: () => void;
  pause: () => void;
  resume: () => void;
  pauseFor: (reason: 'timeout' | 'checkpoint') => void;
  resumeAfter: (reason: 'timeout' | 'checkpoint') => void;
  reset: () => void;
}

/** React lifecycle around the pure timestamp clock. */
export default function useRoomClock(
  gameKey: string,
  halfLengthMinutes?: number,
  segment = 'regulation',
): IRoomClockApi {
  const durationMs =
    halfLengthMinutes !== undefined && Number.isFinite(halfLengthMinutes) && halfLengthMinutes > 0
      ? halfLengthMinutes * 60 * 1000
      : 0;
  const configured = durationMs > 0;
  const identity = `${gameKey}\u0000${segment}\u0000${durationMs}`;
  const [state, setState] = useState<IRoomClockState>(() =>
    configured ? expireRoomClock(loadRoomClock(gameKey, durationMs, undefined, segment), Date.now()) : idleRoomClock(0),
  );
  const [loadedIdentity, setLoadedIdentity] = useState(() => (configured ? identity : ''));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setLoadedIdentity('');
    setState(() => {
      if (!configured) return idleRoomClock(0);
      return expireRoomClock(loadRoomClock(gameKey, durationMs, undefined, segment), Date.now());
    });
    setLoadedIdentity(configured ? identity : '');
  }, [configured, durationMs, gameKey, identity, segment]);

  useEffect(() => {
    if (!configured || loadedIdentity !== identity) return undefined;
    saveRoomClock(gameKey, state, undefined, segment);
    return undefined;
  }, [configured, gameKey, identity, loadedIdentity, segment, state]);

  useEffect(() => {
    if (!configured || state.status !== 'running') return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      setState((previous) => expireRoomClock(previous, current));
    }, 1000);
    return () => clearInterval(timer);
  }, [configured, state.status]);

  useEffect(() => {
    if (!configured) return undefined;
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      setState((previous) => expireRoomClock(previous, current));
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [configured]);

  const transition = useCallback((next: (current: IRoomClockState, currentTime: number) => IRoomClockState) => {
    const currentTime = Date.now();
    setNow(currentTime);
    setState((current) => next(current, currentTime));
  }, []);

  const start = useCallback(() => transition(startRoomClock), [transition]);
  const pause = useCallback(
    () => transition((current, currentTime) => pauseRoomClock(current, 'manual', currentTime)),
    [transition],
  );
  const resume = useCallback(() => transition(resumeRoomClock), [transition]);
  const pauseFor = useCallback(
    (reason: 'timeout' | 'checkpoint') =>
      transition((current, currentTime) => pauseRoomClock(current, reason, currentTime)),
    [transition],
  );
  const resumeAfter = useCallback(
    (reason: 'timeout' | 'checkpoint') =>
      transition((current, currentTime) =>
        current.status === 'paused' && current.pauseReason === reason ? resumeRoomClock(current, currentTime) : current,
      ),
    [transition],
  );
  const reset = useCallback(() => transition(resetRoomClock), [transition]);

  const api = useMemo<IRoomClockApi>(() => {
    const elapsedMs = elapsedRoomClock(state, now);
    const remainingMs = remainingRoomClock(state, now);
    return {
      configured,
      state,
      elapsedMs,
      remainingMs,
      display: formatClock(remainingMs),
      start,
      pause,
      resume,
      pauseFor,
      resumeAfter,
      reset,
    };
  }, [configured, now, pause, pauseFor, reset, resume, resumeAfter, start, state]);

  return api;
}
