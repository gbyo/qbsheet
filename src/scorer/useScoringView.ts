/**
 * Which scoring layout this device is using, and which way its tables run.
 *
 * Subscriptions rather than reads, so the Game menu's entry, the strip above the surface and the
 * surface itself change in the same turn. See `scoringViewPreference` for why the values are module
 * state.
 */
import { useSyncExternalStore } from 'react';
import {
  defaultScoringView,
  defaultTableOrientation,
  ScoringView,
  scoringView,
  subscribeScoringView,
  subscribeTableOrientation,
  TableOrientation,
  tableOrientation,
} from './scoringViewPreference';

export default function useScoringView(): ScoringView {
  return useSyncExternalStore(subscribeScoringView, scoringView, () => defaultScoringView);
}

export function useTableOrientation(): TableOrientation {
  return useSyncExternalStore(subscribeTableOrientation, tableOrientation, () => defaultTableOrientation);
}
