import { useCallback, useRef, useState } from 'react';
import { loadRainbow, logoClickSequence, saveRainbow } from './secretState';

export default function useLogoSecret(onUnlock: () => void) {
  const clicks = useRef<number[]>([]);
  const [rainbow, setRainbow] = useState(loadRainbow);
  const [reaction, setReaction] = useState(0);
  const click = useCallback(() => {
    const next = logoClickSequence(clicks.current, Date.now());
    clicks.current = next.clicks;
    if (!next.unlocked) return;
    saveRainbow();
    setRainbow(true);
    setReaction((value) => value + 1);
    onUnlock();
  }, [onUnlock]);
  return { rainbow, reaction, click };
}
