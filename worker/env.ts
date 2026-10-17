/**
 * Worker bindings, vars and secrets.
 *
 * Bindings (D1/R2) are declared in wrangler.ads.jsonc. Secrets are set with
 * `wrangler secret put` (never committed). See docs/ADVERTISING_SETUP.md.
 */
export interface Env {
  // ---- Bindings ----
  DB: D1Database;
  CREATIVES: R2Bucket;
  /** Cloudflare Images binding — optimizes uploads to WebP at ingest time. */
  IMAGES: ImagesBinding;
  /** Asset layer (the Astro build in dist/); serves the branded 404 page. */
  ASSETS: Fetcher;

  // ---- Non-secret vars (wrangler.ads.jsonc `vars`) ----
  SITE_URL?: string;
  ADMIN_EMAIL?: string;
  EMAIL_FROM?: string;
  /** Set to "true" ONLY after verifying Stripe crypto/stablecoin eligibility. */
  STRIPE_CRYPTO_ENABLED?: string;

  // ---- Secrets (`wrangler secret put`, or .dev.vars locally) ----
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  /** PBKDF2 hash produced by `node worker/dev-tools/hash-password.mjs`. */
  ADMIN_PASSWORD_HASH?: string;
  /** Random string used to sign stateless CSRF tokens. */
  SESSION_SECRET?: string;
}

export const DEFAULTS = {
  siteUrl: 'https://www.topvpn.top',
  adminEmail: 'beyondinfinity2500@gmail.com',
  emailFrom: 'TopVPN Advertising <ads@topvpn.top>',
} as const;

export function siteUrl(env: Env): string {
  return env.SITE_URL || DEFAULTS.siteUrl;
}
export function adminEmail(env: Env): string {
  return env.ADMIN_EMAIL || DEFAULTS.adminEmail;
}
export function emailFrom(env: Env): string {
  return env.EMAIL_FROM || DEFAULTS.emailFrom;
}
export function cryptoEnabled(env: Env): boolean {
  return env.STRIPE_CRYPTO_ENABLED === 'true';
}
