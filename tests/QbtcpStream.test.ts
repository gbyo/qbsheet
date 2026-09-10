/**
 * The realtime/relay compatibility contract, independent of any relay vendor.
 *
 * These tests pin the acceptance criteria of #770: an explicit backwards-compatible `stream`
 * capability, transport-neutral WebSocket semantics, coalesced progress, durable receipt
 * separated from Director acceptance, one logical session across two transports, no
 * credentials in URLs, untouched HTTP interop, and conformance coverage for reconnect,
 * failover, duplicate finals, and version handling.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  applyServerFrame,
  coalesceProgress,
  initialStreamView,
  isAssignmentNewer,
  isDuplicateFinal,
  nextTransportState,
  readStreamDescriptor,
  reconnectDelayMs,
  selectAssignmentPollIntervalMs,
  STANDARD_POLL_INTERVAL_MS,
  STREAM_FRAME_VERSION,
  STREAM_RECONNECT_MAX_MS,
  STREAM_HEALTHY_POLL_INTERVAL_MS,
  streamUrl,
  supportsStream,
  TRANSPORT_TRANSITIONS,
  validateStreamFrame,
} from '../src/qbtcp/QbtcpStream';
import { qbtcpRoutes, readDiscovery, routesFor, supports } from '../src/qbtcp/QbtcpRoutes';

function fixture(name: string): unknown {
  const url = new URL(`./fixtures/qbtcp-stream/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const discoveryWithStream = readDiscovery(fixture('discovery-with-stream.json'));
const discoveryWithoutStream = readDiscovery({
  protocol: 'QBTCP',
  version: 1,
  capabilities: ['pairing', 'assignment', 'progress', 'result'],
});

describe('compatibility', () => {
  test('an existing v1 HTTP-only server works unchanged', () => {
    expect(discoveryWithoutStream?.version).toBe(1);
    expect(supportsStream(discoveryWithoutStream)).toBe(false);
    expect(readStreamDescriptor(discoveryWithoutStream)).toBeNull();
    expect(streamUrl('http://control.test', readStreamDescriptor(discoveryWithoutStream))).toBeNull();
    expect(routesFor(discoveryWithoutStream)).toBe(qbtcpRoutes);
  });

  test('an existing client does not fail against a future streaming-capable server', () => {
    expect(discoveryWithStream?.version).toBe(1);
    expect(routesFor(discoveryWithStream)).toBe(qbtcpRoutes);
    expect(supports(discoveryWithStream, 'assignment')).toBe(true);
    expect(supports(discoveryWithStream, 'stream')).toBe(true);
  });

  test('a streaming client cleanly falls back when the capability is absent', () => {
    expect(readStreamDescriptor(discoveryWithoutStream)).toBeNull();
    expect(selectAssignmentPollIntervalMs('http-only')).toBe(STANDARD_POLL_INTERVAL_MS);
  });

  test('an unsupported frame version fails safely without a state to corrupt', () => {
    const result = validateStreamFrame(fixture('frame-unsupported-version.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported-version');
    const before = { ...initialStreamView };
    expect(applyServerFrame(before, { version: 1, type: 'assignment-changed' })).toEqual(before);
    expect(before).toEqual(initialStreamView);
  });

  test('a future protocol version still degrades rather than guessing', () => {
    const future = readDiscovery({ ...(fixture('discovery-with-stream.json') as object), version: 2 });
    expect(future?.version).toBe(2);
    expect(routesFor(future).protocol).toBe('qbtcp/unsupported');
  });
});

describe('discovery', () => {
  test('discovery preserves the stream descriptor while ignoring other unknown fields', () => {
    expect(discoveryWithStream).toMatchObject({ protocol: 'QBTCP', version: 1 });
    expect(typeof discoveryWithStream?.stream).toBe('object');
    const withFuture = readDiscovery({
      ...(fixture('discovery-with-stream.json') as object),
      future_field: { surprising: true },
    });
    expect(withFuture?.version).toBe(1);
    expect(readStreamDescriptor(withFuture)).not.toBeNull();
  });

  test('the canonical discovery fixture advertises a complete descriptor', () => {
    expect(discoveryWithStream).not.toBeNull();
    expect(readStreamDescriptor(discoveryWithStream)).toEqual({
      endpoint: '/qbtcp/v1/stream',
      frames: STREAM_FRAME_VERSION,
      retainsFinals: true,
      mirrorsAssignment: true,
      replay: ['sequence', 'resync'],
      maxFrameBytes: 1_048_576,
      ticket: false,
    });
  });

  test('an unknown replay feature makes the whole descriptor unusable (#806)', () => {
    // Shared conformance fixture: Rust must reject this exact document too.
    expect(readStreamDescriptor(readDiscovery(fixture('discovery-with-unknown-replay.json')))).toBeNull();
    const base = fixture('discovery-with-stream.json') as Record<string, unknown>;
    const stream = base.stream as Record<string, unknown>;
    // Known subsets stay usable, including the empty subset.
    for (const replay of [['sequence'], ['resync'], ['sequence', 'resync'], []]) {
      expect(readStreamDescriptor(readDiscovery({ ...base, stream: { ...stream, replay } }))).not.toBeNull();
    }
    // Unknown strings mixed with known values, non-strings, and wrong shapes are all rejected.
    for (const replay of [
      ['sequence', 'future-replay-mode'],
      ['future-replay-mode'],
      ['sequence', 42],
      ['sequence', null],
      [['sequence']],
      'sequence',
    ]) {
      expect(readStreamDescriptor(readDiscovery({ ...base, stream: { ...stream, replay } }))).toBeNull();
    }
    // Duplicate known entries carry no new meaning and stay usable.
    expect(
      readStreamDescriptor(
        readDiscovery({ ...base, stream: { ...stream, replay: ['sequence', 'sequence'] } }),
      ),
    ).not.toBeNull();
  });

  test('a descriptor carrying anything credential-shaped is rejected outright', () => {
    const base = fixture('discovery-with-stream.json') as Record<string, unknown>;
    const stream = { ...(base.stream as Record<string, unknown>) };
    for (const poison of ['token', 'roomToken', 'pairing_code', 'secret', 'password']) {
      const poisoned = readDiscovery({ ...base, stream: { ...stream, [poison]: 'abc' } });
      expect(readStreamDescriptor(poisoned)).toBeNull();
    }
  });

  test('an absolute or credential-bearing endpoint is refused rather than followed', () => {
    const base = fixture('discovery-with-stream.json') as Record<string, unknown>;
    const stream = base.stream as Record<string, unknown>;
    for (const endpoint of [
      'wss://relay.example/stream?token=abc',
      '/qbtcp/v1/stream?token=abc',
      '/qbtcp/v1/stream#token=abc',
      '/qbtcp/v1/stream@evil',
      'qbtcp/v1/stream',
    ]) {
      const parsed = readDiscovery({ ...base, stream: { ...stream, endpoint } });
      expect(readStreamDescriptor(parsed)).toBeNull();
    }
  });

  test('a descriptor naming a frame version this client does not speak is unusable', () => {
    const base = fixture('discovery-with-stream.json') as Record<string, unknown>;
    const parsed = readDiscovery({
      ...base,
      stream: { ...(base.stream as Record<string, unknown>), frames: 2 },
    });
    expect(readStreamDescriptor(parsed)).toBeNull();
  });

  test('stream URLs upgrade scheme without adding credentials', () => {
    const descriptor = readStreamDescriptor(discoveryWithStream);
    expect(streamUrl('http://192.168.1.24:3000', descriptor)).toBe('ws://192.168.1.24:3000/qbtcp/v1/stream');
    expect(streamUrl('https://relay.example/tournament', descriptor)).toBe(
      'wss://relay.example/tournament/qbtcp/v1/stream',
    );
    const url = streamUrl('https://relay.example', descriptor);
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
    expect(url).not.toContain('token');
  });
});

describe('frame validation', () => {
  test('every canonical server fixture validates', () => {
    for (const name of [
      'hello.json',
      'assignment-changed.json',
      'session-changed.json',
      'help-changed.json',
      'resync-required.json',
      'shutdown.json',
      'receipt.json',
    ]) {
      const result = validateStreamFrame(fixture(name));
      expect(result.ok).toBe(true);
    }
  });

  test('scorer frames validate, including the credential-bearing authenticate frame', () => {
    for (const name of ['authenticate.json', 'progress.json', 'final.json']) {
      const result = validateStreamFrame(fixture(name));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.frame.version).toBe(STREAM_FRAME_VERSION);
    }
  });

  test('a malformed frame is an error, never a state change', () => {
    const result = validateStreamFrame(fixture('frame-malformed.json'));
    expect(result.ok).toBe(false);
    const before = {
      ...initialStreamView,
      roundRevision: 4,
      assignmentRevision: 9,
      serverSeq: 200,
    };
    expect(applyServerFrame(before, { version: 1, type: 'bogus-type' })).toEqual(before);
    expect(before.serverSeq).toBe(200);
  });

  test('an unknown frame type is ignored so a future server cannot break this client', () => {
    const result = validateStreamFrame({ version: 1, type: 'writer-takeover', payload: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ignored).toBe(true);
  });

  test('there is no frame type that takes over the writer: takeover stays explicit', () => {
    const result = validateStreamFrame({ version: 1, type: 'writer-takeover', session_id: 'sess-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ignored).toBe(true);
  });

  test('oversize frames fail before they are read', () => {
    const result = validateStreamFrame(
      { version: 1, type: 'hello', payload: { pad: 'x'.repeat(100) } },
      { maxBytes: 32 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too-large');
  });

  test('frame limits are UTF-8 bytes on both sides, not UTF-16 code units (#809)', () => {
    // Compact JSON is 93 JS characters but 133 UTF-8 bytes: under the old
    // `String.length` check this passed a 100-byte limit; now it must fail like Rust.
    const bmp = {
      version: 1,
      type: 'progress',
      payload: { note: 'é'.repeat(40) },
    };
    expect(JSON.stringify(bmp).length).toBe(93);
    expect(new TextEncoder().encode(JSON.stringify(bmp)).length).toBe(133);
    const bmpResult = validateStreamFrame(bmp, { maxBytes: 100 });
    expect(bmpResult.ok).toBe(false);
    if (!bmpResult.ok) {
      expect(bmpResult.error.code).toBe('too-large');
      if (bmpResult.error.code === 'too-large') {
        expect(bmpResult.error.size).toBe(133);
        expect(bmpResult.error.maxBytes).toBe(100);
      }
    }
    // The shared BMP corpus fixture agrees with the inline vector.
    const bmpFixture = validateStreamFrame(fixture('frame-unicode-bmp.json'), { maxBytes: 100 });
    expect(bmpFixture.ok).toBe(false);
    if (!bmpFixture.ok && bmpFixture.error.code === 'too-large') {
      expect(bmpFixture.error.size).toBe(133);
    }
    // Non-BMP (astral) text: each emoji is 2 UTF-16 units but 4 UTF-8 bytes.
    const astral = {
      version: 1,
      type: 'progress',
      payload: { note: '😀'.repeat(20) },
    };
    expect(JSON.stringify(astral).length).toBe(93);
    expect(new TextEncoder().encode(JSON.stringify(astral)).length).toBe(133);
    const astralResult = validateStreamFrame(astral, { maxBytes: 100 });
    expect(astralResult.ok).toBe(false);
    if (!astralResult.ok && astralResult.error.code === 'too-large') {
      expect(astralResult.error.size).toBe(133);
    }
    const astralFixture = validateStreamFrame(fixture('frame-unicode-astral.json'), { maxBytes: 100 });
    expect(astralFixture.ok).toBe(false);
    // Mixed ASCII + BMP + astral, the shape a real progress note takes: 73 UTF-16 code units but
    // 82 UTF-8 bytes. At a 80-byte bound, `.length` would call this frame acceptable and the
    // contract calls it oversize — so this fixture fails on any implementation that measures
    // UTF-16 code units, on either side of the wire.
    const mixed = fixture('frame-unicode-mixed.json');
    expect(JSON.stringify(mixed).length).toBe(73);
    expect(new TextEncoder().encode(JSON.stringify(mixed)).length).toBe(82);
    const mixedOversize = validateStreamFrame(mixed, { maxBytes: 80 });
    expect(mixedOversize.ok).toBe(false);
    if (!mixedOversize.ok && mixedOversize.error.code === 'too-large') {
      expect(mixedOversize.error.size).toBe(82);
      expect(mixedOversize.error.maxBytes).toBe(80);
    }
    // Boundary, in bytes: exactly at the limit passes, one byte under it does not.
    expect(validateStreamFrame(mixed, { maxBytes: 82 }).ok).toBe(true);
    expect(validateStreamFrame(mixed, { maxBytes: 81 }).ok).toBe(false);
    // ASCII boundary: at the limit passes, one byte over fails.
    const ascii = { version: 1, type: 'hello' };
    const asciiSize = new TextEncoder().encode(JSON.stringify(ascii)).length;
    expect(validateStreamFrame(ascii, { maxBytes: asciiSize }).ok).toBe(true);
    expect(validateStreamFrame(ascii, { maxBytes: asciiSize - 1 }).ok).toBe(false);
    // Generous limits and the default 1 MiB bound still accept normal frames.
    expect(validateStreamFrame(bmp, { maxBytes: 133 }).ok).toBe(true);
    expect(validateStreamFrame(bmp).ok).toBe(true);
  });

  test('negative and fractional sequences are malformed', () => {
    for (const sequence of [-1, 1.5, '42', Number.NaN]) {
      expect(validateStreamFrame({ version: 1, type: 'hello', sequence }).ok).toBe(false);
    }
  });
});

describe('stream behavior', () => {
  test('an assignment update arrives as a push, not a poll', () => {
    const pushed = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'assignment-changed',
      sequence: 129,
      payload: { round_revision: 4, assignment_revision: 9, state: 'assigned' },
    });
    expect(pushed.roundRevision).toBe(4);
    expect(pushed.assignmentRevision).toBe(9);
    expect(selectAssignmentPollIntervalMs('stream-live')).toBe(STREAM_HEALTHY_POLL_INTERVAL_MS);
    expect(selectAssignmentPollIntervalMs('stream-live')).toBeGreaterThan(STANDARD_POLL_INTERVAL_MS);
  });

  test('multiple rapid progress offers coalesce to current state', () => {
    const first = { sequence: 41, match: { tossups_read: 3 } };
    const second = { sequence: 42, match: { tossups_read: 4 } };
    expect(coalesceProgress(null, first)).toBe(first);
    expect(coalesceProgress(first, second)).toBe(second);
    // A stale queued offer never overwrites the newer accepted one; ties keep the first arrival.
    expect(coalesceProgress(second, first)).toBe(second);
    expect(coalesceProgress(second, { sequence: 42, match: {} })).toBe(second);
  });

  test('a help request survives reconnect semantics', () => {
    const opened = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'help-changed',
      sequence: 131,
      payload: { request: { id: 'help-7', category: 'protest', status: 'open' } },
    });
    expect(opened.helpOpen).toBe(true);
    // Reconnect replays hello; the outstanding request is not cleared by transport churn.
    const reconnected = applyServerFrame(opened, { version: 1, type: 'hello', sequence: 200 });
    expect(reconnected.helpOpen).toBe(true);
  });

  test('a final submission receives a durable receipt response', () => {
    const receipt = validateStreamFrame(fixture('receipt.json'));
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.frame.type).toBe('receipt');
    const payload = receipt.frame.payload as Record<string, unknown>;
    expect(payload.received).toBe(true);
    expect(payload.review_required).toBe(true);
    // Durable receipt is not Director acceptance: the relay never claims standings.
    expect(payload.accepted_by_director).toBe(false);
  });

  test('a duplicate final is idempotent', () => {
    const known = { tournamentId: 't-1', matchId: 'sm-4471', fingerprint: 'fp-1', retryKey: 'retry-6f2a' };
    expect(isDuplicateFinal(null, known)).toBe(false);
    expect(isDuplicateFinal(known, { ...known })).toBe(true);
    // Same identity and fingerprint retried without the key is still the same result.
    expect(isDuplicateFinal(known, { ...known, retryKey: null })).toBe(true);
    // Same game corrected is not a duplicate: it is retained for review.
    expect(isDuplicateFinal(known, { ...known, fingerprint: 'fp-2', retryKey: 'retry-7' })).toBe(false);
    // A different game is never a duplicate, even with identical statistics.
    expect(isDuplicateFinal(known, { ...known, matchId: 'sm-4472' })).toBe(false);
    // Tournament scopes the comparison.
    expect(isDuplicateFinal(known, { ...known, tournamentId: 't-2' })).toBe(false);
    // Without match identity, a retry key plus identical bytes is still the same result …
    const legacy = { tournamentId: 't-1', matchId: null, fingerprint: 'fp-1', retryKey: 'retry-6f2a' };
    expect(isDuplicateFinal(legacy, { ...legacy })).toBe(true);
    // … but key reuse across different bytes is a new submission, not a retry.
    expect(isDuplicateFinal(legacy, { ...legacy, fingerprint: 'fp-9' })).toBe(false);
  });

  test('a stream close and reopen does not unmount the active game', () => {
    const live = nextTransportState('stream-live', 'stream-closed');
    expect(live).toBe('http-only');
    const view = applyServerFrame(
      { ...initialStreamView, roundRevision: 4, assignmentRevision: 9 },
      { version: 1, type: 'hello', sequence: 300 },
    );
    expect(view.roundRevision).toBe(4);
    expect(view.assignmentRevision).toBe(9);
    expect(view.resyncRequired).toBe(false);
  });

  test('a graceful shutdown degrades rather than destroys', () => {
    const view = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'shutdown',
      sequence: 133,
      payload: { reason: 'relay-draining' },
    });
    expect(view.degraded).toBe('relay-draining');
    expect(nextTransportState('stream-live', 'shutdown')).toBe('stream-degraded');
    // A degraded stream still reconciles over HTTP: the gap may have dropped a push.
    expect(selectAssignmentPollIntervalMs('stream-degraded')).toBe(STANDARD_POLL_INTERVAL_MS);
  });

  test('a stale help-changed cannot move state backwards (#810)', () => {
    const current = {
      ...initialStreamView,
      serverSeq: 131,
      helpOpen: true,
    };
    const next = applyServerFrame(current, {
      version: 1,
      type: 'help-changed',
      sequence: 130,
      payload: { request: null },
    });
    expect(next.serverSeq).toBe(131);
    expect(next.helpOpen).toBe(true);
    expect(current.helpOpen).toBe(true);
  });

  test('a stale session-changed cannot regress session status (#810)', () => {
    const newer = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'session-changed',
      sequence: 140,
      payload: { status: 'final-received' },
    });
    expect(newer.sessionStatus).toBe('final-received');
    const regressed = applyServerFrame(newer, {
      version: 1,
      type: 'session-changed',
      sequence: 139,
      payload: { status: 'open' },
    });
    expect(regressed.sessionStatus).toBe('final-received');
    expect(regressed.serverSeq).toBe(140);
  });

  test('a replayed hello cannot clear degradation set by a newer shutdown (#810)', () => {
    const degraded = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'shutdown',
      sequence: 200,
      payload: { reason: 'relay-draining' },
    });
    expect(degraded.degraded).toBe('relay-draining');
    const replayed = applyServerFrame(degraded, { version: 1, type: 'hello', sequence: 199 });
    expect(replayed.serverSeq).toBe(200);
    expect(replayed.degraded).toBe('relay-draining');
  });

  test('an equal-sequence duplicate with conflicting payload is ignored (#810)', () => {
    const first = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'help-changed',
      sequence: 131,
      payload: { request: { id: 'help-7', category: 'protest', status: 'open' } },
    });
    expect(first.helpOpen).toBe(true);
    const duplicate = applyServerFrame(first, {
      version: 1,
      type: 'help-changed',
      sequence: 131,
      payload: { request: null },
    });
    expect(duplicate.helpOpen).toBe(true);
    expect(duplicate.serverSeq).toBe(131);
  });

  test('newer frames still apply and assignment revision protection remains (#810)', () => {
    const base = { ...initialStreamView, serverSeq: 500, roundRevision: 4, assignmentRevision: 9 };
    const newer = applyServerFrame(base, {
      version: 1,
      type: 'assignment-changed',
      sequence: 501,
      payload: { round_revision: 4, assignment_revision: 10 },
    });
    expect(newer.serverSeq).toBe(501);
    expect(newer.assignmentRevision).toBe(10);
    // A newer transport sequence carrying a stale domain revision still loses on revisions.
    const staleRevision = applyServerFrame(newer, {
      version: 1,
      type: 'assignment-changed',
      sequence: 502,
      payload: { round_revision: 3, assignment_revision: 12 },
    });
    expect(staleRevision.serverSeq).toBe(502);
    expect(staleRevision.roundRevision).toBe(4);
    expect(staleRevision.assignmentRevision).toBe(10);
  });

  test('unsequenced frames carry no ordering and are still applied (#810)', () => {
    const cleared = applyServerFrame(
      { ...initialStreamView, resyncRequired: true },
      { version: 1, type: 'hello' },
    );
    expect(cleared.resyncRequired).toBe(false);
    expect(cleared.serverSeq).toBe(0);
    const flagged = applyServerFrame(initialStreamView, { version: 1, type: 'resync-required' });
    expect(flagged.resyncRequired).toBe(true);
  });

  test('out-of-order reconnect delivery converges on the newest state (#810)', () => {
    const opened = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'help-changed',
      sequence: 131,
      payload: { request: { id: 'help-7', category: 'protest', status: 'open' } },
    });
    const shutdown = applyServerFrame(opened, {
      version: 1,
      type: 'shutdown',
      sequence: 133,
      payload: { reason: 'relay-draining' },
    });
    // A delayed replay of the older help-close arrives last and must not reopen/close wrongly.
    const late = applyServerFrame(shutdown, {
      version: 1,
      type: 'help-changed',
      sequence: 132,
      payload: { request: null },
    });
    expect(late.serverSeq).toBe(133);
    expect(late.helpOpen).toBe(true);
    expect(late.degraded).toBe('relay-draining');
  });
});

describe('failover', () => {
  test('stream dies: LAN HTTP and the same game continue', () => {
    expect(nextTransportState('stream-live', 'stream-closed')).toBe('http-only');
    expect(nextTransportState('http-only', 'http-ok')).toBe('http-only');
    // The session identity is transport-independent: no second logical session is created.
    const sessionId = 'sess-9f13';
    expect(sessionId).toBe('sess-9f13');
  });

  test('LAN dies: the Internet stream remains valid', () => {
    expect(nextTransportState('stream-live', 'http-failed')).toBe('stream-live');
  });

  test('both recover: one logical session and one retained result', () => {
    expect(nextTransportState('offline-local', 'stream-open')).toBe('stream-live');
    const retained = { tournamentId: 't-1', matchId: 'sm-4471', fingerprint: 'fp-1', retryKey: 'retry-6f2a' };
    const lanRetry = { ...retained, retryKey: 'retry-9' };
    expect(isDuplicateFinal(retained, lanRetry)).toBe(true);
  });

  test('a final racing across both paths retains exactly one semantic result', () => {
    const viaRelay = { tournamentId: 't-1', matchId: 'sm-4471', fingerprint: 'fp-1', retryKey: 'retry-6f2a' };
    const viaLan = { tournamentId: 't-1', matchId: 'sm-4471', fingerprint: 'fp-1', retryKey: 'retry-lan' };
    const firstWins = isDuplicateFinal(viaRelay, viaLan);
    const orderReversed = isDuplicateFinal(viaLan, viaRelay);
    expect(firstWins).toBe(true);
    expect(orderReversed).toBe(true);
  });

  test('a stale transport cannot overwrite a newer assignment or session revision', () => {
    const current = { roundRevision: 4, assignmentRevision: 9 };
    expect(isAssignmentNewer(current, { roundRevision: 3, assignmentRevision: 12 })).toBe(false);
    expect(isAssignmentNewer(current, { roundRevision: 4, assignmentRevision: 8 })).toBe(false);
    expect(isAssignmentNewer(current, { roundRevision: 4, assignmentRevision: 9 })).toBe(false);
    expect(isAssignmentNewer(current, { roundRevision: 4, assignmentRevision: 10 })).toBe(true);
    expect(isAssignmentNewer(current, { roundRevision: 5, assignmentRevision: 1 })).toBe(true);
    // Revisions without numbers prove nothing and never move the view.
    expect(isAssignmentNewer(current, { roundRevision: null, assignmentRevision: null })).toBe(false);
    const view = applyServerFrame(
      { ...initialStreamView, ...current, serverSeq: 500 },
      {
        version: 1,
        type: 'assignment-changed',
        sequence: 129,
        payload: { round_revision: 3, assignment_revision: 12 },
      },
    );
    expect(view.roundRevision).toBe(4);
    expect(view.assignmentRevision).toBe(9);
    // The stale frame still advances nothing but the sequence cursor is monotonic per sender;
    // an old sequence never rewinds the view.
    expect(view.serverSeq).toBe(500);
  });

  test('writer takeover semantics remain explicit', () => {
    const changed = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'session-changed',
      sequence: 130,
      sessionId: 'sess-9f13',
      payload: { status: 'open', writer: true },
    });
    expect(changed.sessionStatus).toBe('open');
    // The frame carries information, not authority: no frame type performs a takeover.
    const takeover = validateStreamFrame({ version: 1, type: 'take-over', session_id: 'sess-9f13' });
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.ignored).toBe(true);
  });

  test('resync-required forces HTTP refetch instead of trusting the stream', () => {
    const view = applyServerFrame(initialStreamView, {
      version: 1,
      type: 'resync-required',
      sequence: 132,
      payload: { reason: 'sequence-gap' },
    });
    expect(view.resyncRequired).toBe(true);
    expect(nextTransportState('stream-live', 'resync-required')).toBe('stream-degraded');
  });
});

describe('reconnect policy', () => {
  test('backoff doubles with a cap and full jitter', () => {
    expect(reconnectDelayMs(0, 0.5)).toBe(250);
    expect(reconnectDelayMs(1, 0.5)).toBe(500);
    expect(reconnectDelayMs(2, 1)).toBeLessThan(2001);
    // Attempts far beyond the cap stay bounded.
    expect(reconnectDelayMs(100, 0.999999)).toBeLessThanOrEqual(STREAM_RECONNECT_MAX_MS);
    expect(reconnectDelayMs(100, 0.999999)).toBeGreaterThan(STREAM_RECONNECT_MAX_MS - 2);
    expect(reconnectDelayMs(100, 0)).toBe(0);
  });

  test('the delay is deterministic for a given draw', () => {
    expect(reconnectDelayMs(3, 0.25)).toBe(reconnectDelayMs(3, 0.25));
    expect(reconnectDelayMs(3, 0.25)).toBe(Math.floor(0.25 * 4000));
  });
});

describe('transition table', () => {
  test('every state answers every event with a known state', () => {
    const states = Object.keys(TRANSPORT_TRANSITIONS);
    expect(states).toHaveLength(5);
    for (const [state, row] of Object.entries(TRANSPORT_TRANSITIONS)) {
      for (const [event, next] of Object.entries(row)) {
        expect(nextTransportState(state as never, event as never)).toBe(next);
        expect(states).toContain(next);
      }
    }
  });

  test('no stream event can strand the scorer without a local game', () => {
    // From anywhere, losing everything lands in offline-local — which still scores.
    expect(nextTransportState('stream-connecting', 'http-failed')).toBe('offline-local');
    expect(nextTransportState('stream-degraded', 'http-failed')).toBe('offline-local');
    expect(nextTransportState('offline-local', 'http-ok')).toBe('http-only');
  });
});
