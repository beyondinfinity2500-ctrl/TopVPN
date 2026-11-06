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

  // ---- VPN provisioning (server-only; set with `wrangler secret put`) ----
  /** VPNResellers API v4.1 bearer token. Never exposed to the browser. */
  VPNRESELLERS_API_TOKEN?: string;
  /** Override API base URL (defaults to the documented v4.1 endpoint). */
  VPNRESELLERS_API_URL?: string;
  /** Optional project id used when linking a provider customer. */
  VPNRESELLERS_PROJECT_ID?: string;

  // ---- VPN sales foundation (sandbox; see docs/PLATFORM_IMPLEMENTATION.md) ----
  /** "true" only when a sandbox checkout may create pending orders. Default off. */
  VPN_SALES_ENABLED?: string;
  /** "true" enables the sandbox-only Stripe Checkout flow (requires sk_test_). */
  VPN_SANDBOX_CHECKOUT_ENABLED?: string;
  /** "true" enables the one-time first-month price (requires prior-order check). */
  VPN_INTRO_ENABLED?: string;
  /** Stripe signing secret for the dedicated VPN webhook endpoint (not the ads one). */
  STRIPE_VPN_WEBHOOK_SECRET?: string;
  /** Server secret used to derive deterministic VPN account passwords. */
  VPN_PROVISIONING_SECRET?: string;

  // ---- Customer identity (magic link; separate from admin) ----
  /** "true" enables sending customer sign-in links (also requires RESEND_API_KEY). */
  VPN_CUSTOMER_AUTH_ENABLED?: string;
  /** Sender for customer emails; defaults to the accounts address below. */
  CUSTOMER_EMAIL_FROM?: string;

  // ---- Credential delivery (server-only; no credentials stored in D1) ----
  /** "true" enables the customer connection-details page. Default off. */
  VPN_CREDENTIAL_DELIVERY_ENABLED?: string;
  /** Provider server id used to generate WireGuard configs. */
  VPN_WIREGUARD_SERVER_ID?: string;
  /** Provider server id used to generate OpenVPN configs. */
  VPN_OPENVPN_SERVER_ID?: string;
  /** Provider port id used to generate OpenVPN configs. */
  VPN_OPENVPN_PORT_ID?: string;

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
  customerEmailFrom: 'TopVPN Accounts <accounts@topvpn.top>',
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
export function customerEmailFrom(env: Env): string {
  return env.CUSTOMER_EMAIL_FROM || DEFAULTS.customerEmailFrom;
}
export function cryptoEnabled(env: Env): boolean {
  return env.STRIPE_CRYPTO_ENABLED === 'true';
}
