/**
 * Which scoring surface this device is using, as something React can render.
 *
 * A subscription rather than a read, so the Game menu's entry and the surface it names change in the
 * same turn. See `scoringViewPreference` for why the value is module state.
 */
import { useSyncExternalStore } from 'react';
import { defaultScoringView, ScoringView, scoringView, subscribeScoringView } from './scoringViewPreference';

export default function useScoringView(): ScoringView {
  return useSyncExternalStore(subscribeScoringView, scoringView, () => defaultScoringView);
}
