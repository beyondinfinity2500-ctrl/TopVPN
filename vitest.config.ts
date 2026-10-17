/**
 * Worker tests run inside the Workers runtime via @cloudflare/vitest-plugin.
 *
 * Test secrets are injected by miniflare (never real credentials): STRIPE_SECRET_KEY
 * and RESEND_API_KEY are intentionally absent so the order flow exercises its
 * "payments/email not configured" paths instead of calling live services.
 */
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.ads.jsonc' },
      miniflare: {
        bindings: {
          SESSION_SECRET: 'test-session-secret-not-for-production',
          STRIPE_WEBHOOK_SECRET: 'whsec_test_signing_secret',
          // PBKDF2 hash of "test-admin-password-1234" (fixed salt, test-only).
          ADMIN_PASSWORD_HASH:
            '100000.ASNFZ4mrze8.PWWdaN9uGUAvx-EBsPJeCN5UvWQ-OdgleNKNN-38i6w',
        },
      },
    }),
  ],
  test: {
    include: ['worker/test/**/*.test.ts'],
    // The Workers-runtime integration tests wait on real D1/R2 round trips;
    // on a loaded machine a single test can legitimately exceed the 5s default
    // (observed as load-related timeouts, never assertion failures).
    testTimeout: 30000,
    // Each test file gets its own Workers runtime; starting several workerd
    // processes at once on Windows races, so run the files sequentially.
    fileParallelism: false,
  },
});
