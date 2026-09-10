import { describe, expect, it } from 'vitest';
import { clampPage, parseAfterCursor, resyncDecision } from '../src/replay';

describe('replay cursors', () => {
  it('accepts non-negative safe integers and rejects everything else', () => {
    expect(parseAfterCursor('178')).toEqual({ ok: true, value: 178 });
    expect(parseAfterCursor(0)).toEqual({ ok: true, value: 0 });
    expect(parseAfterCursor(Number.MAX_SAFE_INTEGER)).toEqual({ ok: true, value: Number.MAX_SAFE_INTEGER });
    expect(parseAfterCursor('-1')).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
    expect(parseAfterCursor('1.5')).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
    expect(parseAfterCursor('0x10')).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
    expect(parseAfterCursor('   ')).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
    expect(parseAfterCursor(' 178 ')).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
    expect(parseAfterCursor(Number.MAX_SAFE_INTEGER + 1)).toEqual({
      ok: false,
      error: '`after` must be a non-negative integer.',
    });
    expect(parseAfterCursor('../etc')).toEqual({
      ok: false,
      error: '`after` must be a non-negative integer.',
    });
    expect(parseAfterCursor(null)).toEqual({ ok: false, error: '`after` must be a non-negative integer.' });
  });

  it('clamps page sizes with a non-finite floor', () => {
    expect(clampPage(64, 1, 128)).toBe(64);
    expect(clampPage(1000, 1, 128)).toBe(128);
    expect(clampPage(0, 1, 128)).toBe(1);
    expect(clampPage(NaN, 1, 128)).toBe(1);
  });

  it('detects gap, current, and page boundaries', () => {
    const base = { currentRevision: 182, oldestRetained: 100, durableOnly: false };
    // Fresh cursor: no resync. Cursor at the window edge: the page is complete.
    expect(resyncDecision({ ...base, after: 182 }).resyncRequired).toBe(false);
    expect(resyncDecision({ ...base, after: 99 }).resyncRequired).toBe(false);
    // Behind the window: honest resync. Empty window with a stale cursor: also resync.
    expect(resyncDecision({ ...base, after: 50 }).resyncRequired).toBe(true);
    expect(resyncDecision({ ...base, after: 50, oldestRetained: null }).resyncRequired).toBe(true);
    // A replay scoped to durable kinds never demands resync: unacknowledged rows are
    // never trimmed, so the durable endpoints stay complete whatever the cursor.
    expect(resyncDecision({ ...base, after: 0, durableOnly: true }).resyncRequired).toBe(false);
  });
});
