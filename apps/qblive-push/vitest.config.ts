import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Tests run inside real `workerd`.
 *
 * What they cannot cover is APNs itself: Apple advertises only `h2` in ALPN and drops HTTP/1.1,
 * and local `workerd` makes outbound subrequests over HTTP/1.1 — a documented local-only
 * limitation (cloudflare/workerd#4841, and `docs/QBLIVE_PUSH_PROTOTYPE.md`). So the APNs client is
 * exercised with an injected `fetch`, and everything that decides *whether* and *what* to send —
 * dedup, coalescing, the budget, payload construction, token lifetime — is tested for real.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          APNS_PRIVATE_KEY: '',
          APNS_KEY_ID: 'TESTKEYID1',
          APNS_TEAM_ID: 'TESTTEAM01',
          APNS_ENVIRONMENT: 'sandbox',
          APNS_BUNDLE_ID: 'com.qbsheet.live',
          APNS_CLIP_BUNDLE_ID: 'com.qbsheet.live.Clip',
        },
        queueConsumers: { 'qblive-push': { maxBatchSize: 10, maxBatchTimeout: 1 } },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
