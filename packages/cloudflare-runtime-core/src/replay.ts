/**
 * Revision/replay cursor primitives shared by QBSheet's Cloudflare backends.
 *
 * # What is here
 *
 * Parsing and bounding an `after` cursor, clamping page sizes, and deciding honestly
 * whether a cursor is too old for the retained window (`resyncRequired`). Pure
 * functions over numbers — no storage, no protocol frames.
 *
 * # What is deliberately NOT here
 *
 * Retention policy stays product-specific: QBLive may trim old public revisions, while
 * QBTCP must never trim an unacknowledged final merely because a generic replay window
 * elapsed. Callers pass `durableOnly` so a replay scoped to durable kinds (results,
 * help) is complete for everything unacknowledged, whatever the cursor. Likewise the
 * event kinds themselves (`assignment`, `session`, …) belong to each protocol.
 */

/** Parse an `after` cursor: a non-negative integer, nothing else. */
export function parseAfterCursor(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: '`after` must be a non-negative integer.' };
  }
  return { ok: true, value };
}

/** Clamp a page size into `[low, high]`; non-finite input takes the floor. */
export function clampPage(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

/**
 * Decide whether a cursor predates the retained replay window.
 *
 * - `currentRevision` is the newest revision the service holds.
 * - `oldestRetained` is the oldest revision still in the window, or null when the log
 *   is empty (nothing to be behind on).
 * - `durableOnly` scopes the replay to durable kinds whose rows are never trimmed while
 *   unacknowledged: such a replay is complete for everything the caller has not yet
 *   acknowledged, whatever the cursor, so it never demands a resync.
 */
export function resyncDecision(options: {
  after: number;
  currentRevision: number;
  oldestRetained: number | null;
  durableOnly: boolean;
}): { resyncRequired: boolean } {
  const { after, currentRevision, oldestRetained, durableOnly } = options;
  if (durableOnly) return { resyncRequired: false };
  if (after >= currentRevision) return { resyncRequired: false };
  // An empty window with a stale cursor means everything the cursor names was trimmed.
  if (oldestRetained === null) return { resyncRequired: true };
  return { resyncRequired: after < oldestRetained - 1 };
}