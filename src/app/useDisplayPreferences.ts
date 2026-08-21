/**
 * Appearance and text size, as something React can render.
 *
 * A subscription rather than a read, for the reason `useKeyboardEnabled` documents: the Settings
 * dialog and anything else showing the current choice have to change together.
 */
import { useSyncExternalStore } from 'react';
import { Appearance, TextSize, displayPreferences, subscribeDisplayPreferences } from './displayPreference';

export default function useDisplayPreferences(): { appearance: Appearance; textSize: TextSize } {
  return useSyncExternalStore(subscribeDisplayPreferences, displayPreferences);
}
