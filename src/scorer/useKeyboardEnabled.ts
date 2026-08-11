/**
 * Whether keyboard scoring is on, as something React can render.
 *
 * A subscription rather than a read, so the scorer's menu toggle and the practice coach's keystroke
 * hints change together. See `keyboardPreference` for why the value is module state.
 */
import { useEffect, useState } from 'react';
import { keyboardEnabled, subscribeKeyboardEnabled } from './keyboardPreference';

export default function useKeyboardEnabled(): boolean {
  const [enabled, setEnabled] = useState(keyboardEnabled);
  useEffect(() => {
    // Re-read on subscribe: the value can change between the first render and this effect.
    setEnabled(keyboardEnabled());
    return subscribeKeyboardEnabled(setEnabled);
  }, []);
  return enabled;
}
