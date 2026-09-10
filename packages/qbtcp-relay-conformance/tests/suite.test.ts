/**
 * The relay conformance suite, tested against scripted stub relays.
 *
 * A suite that passes everything is worthless. The stubs here each violate one rule, and the
 * tests assert that the corresponding check fails — which is the only way to know the checks are
 * load-bearing rather than decorative.
 *
 * The suite is also run against the real Cloudflare relay from `.github/workflows/qblive.yml`;
 * that is an integration concern and needs `workerd`.
 */

import { afterEach, describe, expect, test } from 'vitest';

import { runRelayConformance } from '../src/suite.js';
import { STUB_ALLOWED_ORIGIN, StubRelay } from './stub.js';

let running: StubRelay | null = null;

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
});

async function serve(options: ConstructorParameters<typeof StubRelay>[0] = {}): Promise<string> {
  running = new StubRelay(options);
  return running.origin;
}

function outcome(report: Awaited<ReturnType<typeof runRelayConformance>>, id: string): string {
  return report.results.find((result) => result.id === id)?.outcome ?? 'missing';
}

describe('a conforming relay', () => {
  test('passes every check', async () => {
    const origin = await serve();
    const report = await runRelayConformance({
      origin,
      setupToken: 'good-token',
      streamTimeoutMs: 2000,
      browserOrigin: STUB_ALLOWED_ORIGIN,
    });
    expect(report.failed).toBe(0);
    expect(report.conforming).toBe(true);
    expect(report.passed).toBeGreaterThan(10);
  }, 30000);

  test('skips the preflight checks rather than guessing an operator allowlist', async () => {
    const origin = await serve();
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(outcome(report, 'cors-preflight')).toBe('skip');
    expect(outcome(report, 'cors-public')).toBe('pass');
    expect(report.conforming).toBe(true);
  }, 30000);
});

describe('each check actually catches its violation', () => {
  test('a credential-leaking descriptor fails discovery', async () => {
    const origin = await serve({ badDescriptor: true });
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(report.conforming).toBe(false);
    expect(outcome(report, 'discovery')).toBe('fail');
  }, 30000);

  test('a missing receipt fails the streamed final', async () => {
    const origin = await serve({ noReceipt: true });
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(outcome(report, 'stream-receipt')).toBe('fail');
  }, 30000);

  test('an unfenced mirror fails Director sync', async () => {
    const origin = await serve({ acceptStaleMirror: true });
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(outcome(report, 'mirror-fencing')).toBe('fail');
  }, 30000);

  test('a scope-confused relay fails the capability check', async () => {
    const origin = await serve({ scopeConfusion: true });
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(outcome(report, 'scope')).toBe('fail');
  }, 30000);

  test('a public-only preflight fails the credentialed CORS check', async () => {
    // The exact shape of the shipped bug: every OPTIONS answered with the public GET-only policy.
    const origin = await serve({ publicPreflight: true });
    const report = await runRelayConformance({
      origin,
      setupToken: 'good-token',
      streamTimeoutMs: 2000,
      browserOrigin: STUB_ALLOWED_ORIGIN,
    });
    expect(report.conforming).toBe(false);
    expect(outcome(report, 'cors-preflight')).toBe('fail');
    // Discovery is genuinely public, so that check still passes: the finding is specific.
    expect(outcome(report, 'cors-public')).toBe('pass');
  }, 30000);

  test('a wildcard preflight on a credentialed route fails', async () => {
    const origin = await serve({ wildcardPreflight: true });
    const report = await runRelayConformance({
      origin,
      setupToken: 'good-token',
      streamTimeoutMs: 2000,
      browserOrigin: STUB_ALLOWED_ORIGIN,
    });
    expect(outcome(report, 'cors-preflight')).toBe('fail');
    expect(outcome(report, 'cors-origin-refusal')).toBe('fail');
  }, 30000);

  test('a non-idempotent relay fails the cross-transport retry', async () => {
    const origin = await serve({ notDuplicate: true });
    const report = await runRelayConformance({ origin, setupToken: 'good-token', streamTimeoutMs: 2000 });
    expect(outcome(report, 'stream-receipt')).toBe('fail');
  }, 30000);
});
