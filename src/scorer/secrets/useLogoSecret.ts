import { useCallback, useEffect, useRef, useState } from 'react';
import { loadRainbow, logoClickSequence, saveRainbow } from './secretState';

export const logoHoldDurationMs = 850;

export default function useLogoSecret(onUnlock: () => void) {
  const clicks = useRef<number[]>([]);
  const holdTimer = useRef<number | null>(null);
  const [rainbow, setRainbow] = useState(loadRainbow);
  const [reaction, setReaction] = useState(0);

  const unlock = useCallback(() => {
    clicks.current = [];
    saveRainbow();
    setRainbow(true);
    setReaction((value) => value + 1);
    onUnlock();
  }, [onUnlock]);

  const click = useCallback(() => {
    const next = logoClickSequence(clicks.current, Date.now());
    clicks.current = next.clicks;
    if (next.unlocked) unlock();
  }, [unlock]);

  const endHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  const beginHold = useCallback(() => {
    endHold();
    holdTimer.current = window.setTimeout(unlock, logoHoldDurationMs);
  }, [endHold, unlock]);

  useEffect(() => endHold, [endHold]);

  return { rainbow, reaction, click, beginHold, endHold };
}
