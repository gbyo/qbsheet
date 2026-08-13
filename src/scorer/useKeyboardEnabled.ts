/**
 * Whether keyboard scoring is on, as something React can render.
 *
 * A subscription rather than a read, so the scorer's menu toggle and the practice coach's keystroke
 * hints change together. See `keyboardPreference` for why the value is module state.
 */
import { useSyncExternalStore } from 'react';
import { keyboardEnabled, subscribeKeyboardEnabled } from './keyboardPreference';

export default function useKeyboardEnabled(): boolean {
  // The preference is module state outside React, which is what this hook is for. It reads the value
  // as it renders, so there is no window between the first render and a subscription for the value to
  // change in — the gap a copy in `useState` had to be patched up for.
  return useSyncExternalStore(subscribeKeyboardEnabled, keyboardEnabled);
}
