/**
 * Customer magic-link authentication.
 *
 * - Tokens are 32 random bytes (base64url); only their SHA-256 hash is stored.
 * - Consumption is one atomic UPDATE, so a replayed link can never create a
 *   second session.
 * - Sessions live in vpn_customer_sessions and use a dedicated cookie; they are
 *   completely separate from the advertising admin session.
 * - No email is sent unless VPN_CUSTOMER_AUTH_ENABLED=true AND RESEND_API_KEY is
 *   present. Without that, requests still get a generic success response.
 */
import type { Env } from '../env';
import { customerEmailFrom, siteUrl } from '../env';
import { isValidEmail } from '../validation';
import { bumpRateLimit } from '../db';
import { sendEmail, type SendResult } from '../email';
import {
  consumeCustomerToken,
  createCustomerSession,
  deleteCustomerSession,
  findOrCreateCustomer,
  getCustomerByEmail,
  getCustomerById,
  getCustomerSession,
  insertCustomerToken,
  linkOrdersToCustomer,
} from './repo';

const enc = new TextEncoder();
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export const CUSTOMER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CUSTOMER_COOKIE = 'topvpn_customer_session';

export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

/** Sending requires both the explicit flag and a configured email provider. */
export function customerAuthReady(env: Env): boolean {
  return env.VPN_CUSTOMER_AUTH_ENABLED === 'true' && !!env.RESEND_API_KEY;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CustomerAuthDeps {
  now?: Date;
  /** Injected in tests (captures the raw token without sending real email). */
  send?: (input: { to: string; token: string }) => Promise<SendResult>;
}

export async function sendCustomerEmail(env: Env, to: string, token: string): Promise<SendResult> {
  if (!customerAuthReady(env)) return { ok: false, status: 'not_configured' };
  const link = `${siteUrl(env)}/account/verify?token=${encodeURIComponent(token)}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
  <h1 style="font-size:20px">Sign in to TopVPN</h1>
  <p>Use the button below to open your account. The link expires in 15 minutes and can be used once.</p>
  <p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#D4AF37;color:#0B1020;border-radius:6px;text-decoration:none;font-weight:600">Sign in to TopVPN</a></p>
  <p style="color:#667085;font-size:13px">If you did not request this email, you can safely ignore it.</p>
</div>`;
  return sendEmail(env, [to], 'Sign in to TopVPN', html, customerEmailFrom(env));
}

/**
 * Always resolves with `{ ok: true }`, whether or not the email exists, so the
 * endpoint cannot be used to enumerate accounts. Rate limits are keyed by
 * hashed IP and hashed email.
 */
export async function requestMagicLink(
  env: Env,
  input: { email: string; ip: string },
  deps: CustomerAuthDeps = {},
): Promise<{ ok: true }> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { ok: true };

  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const ipHash = await sha256Hex(`ip:${input.ip || 'unknown'}`);
  const emailHash = await sha256Hex(`email:${email}`);

  const ipLimit = await bumpRateLimit(env.DB, `customer-link:ip:${ipHash}`, 3600, 10);
  if (!ipLimit.allowed) return { ok: true };

  // Only consume the per-email quota after the IP is allowed. The bucket is
  // keyed by IP+email, so one abusive network cannot exhaust another person's
  // sign-in budget from a different address.
  const emailLimit = await bumpRateLimit(
    env.DB,
    `customer-link:pair:${ipHash}:${emailHash}`,
    3600,
    3,
  );
  if (!emailLimit.allowed) return { ok: true };

  // No deliverable email channel: do not create a token that can never arrive.
  if (!deps.send && !customerAuthReady(env)) return { ok: true };

  // Blocked customers silently receive nothing (no account enumeration).
  const existing = await getCustomerByEmail(env.DB, email);
  if (existing?.blocked_at) return { ok: true };

  const customer = await findOrCreateCustomer(env.DB, email, nowIso);
  const token = randomToken();
  await insertCustomerToken(env.DB, {
    tokenHash: await sha256Hex(token),
    customerId: customer.id,
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS).toISOString(),
    now: nowIso,
  });

  try {
    if (deps.send) await deps.send({ to: email, token });
    else await sendCustomerEmail(env, email, token);
  } catch {
    // Generic response regardless of delivery outcome.
  }
  return { ok: true };
}

export interface CustomerSessionContext {
  customerId: string;
  email: string;
  csrfToken: string;
  tokenHash: string;
}

/** `null` on expired, unknown or missing tokens. */
export async function getCustomerSessionFromToken(
  env: Env,
  rawToken: string | null | undefined,
  now: Date = new Date(),
): Promise<CustomerSessionContext | null> {
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await getCustomerSession(env.DB, tokenHash, now.toISOString());
  if (!row) return null;
  return { customerId: row.customer_id, email: row.email_norm, csrfToken: row.csrf_token, tokenHash };
}

export async function consumeMagicLink(
  env: Env,
  rawToken: string,
  deps: CustomerAuthDeps = {},
): Promise<{ ok: true; session: CustomerSessionContext & { sessionToken: string } } | { ok: false; reason: string }> {
  if (!rawToken || rawToken.length > 512) return { ok: false, reason: 'invalid_or_expired' };

  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const customerId = await consumeCustomerToken(env.DB, await sha256Hex(rawToken), nowIso);
  if (!customerId) return { ok: false, reason: 'invalid_or_expired' };

  const customer = await getCustomerById(env.DB, customerId);
  if (!customer) return { ok: false, reason: 'invalid_or_expired' };
  if (customer.blocked_at) return { ok: false, reason: 'account_blocked' };

  return { ok: true, session: await startCustomerSession(env, customer, now) };
}

/**
 * Shared session bootstrap for magic-link and Google sign-in: links the
 * customer's orders and creates the session row + cookie token.
 */
export async function startCustomerSession(
  env: Env,
  customer: { id: string; email_norm: string },
  now: Date,
): Promise<CustomerSessionContext & { sessionToken: string }> {
  const nowIso = now.toISOString();
  await linkOrdersToCustomer(env.DB, customer.id, customer.email_norm, nowIso);

  const sessionToken = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + CUSTOMER_SESSION_TTL_SECONDS * 1000).toISOString();
  const tokenHash = await sha256Hex(sessionToken);
  await createCustomerSession(env.DB, {
    tokenHash,
    customerId: customer.id,
    csrfToken,
    now: nowIso,
    expiresAt,
  });
  return { customerId: customer.id, email: customer.email_norm, csrfToken, tokenHash, sessionToken };
}

export async function logoutCustomer(env: Env, rawToken: string | null | undefined): Promise<void> {
  if (!rawToken) return;
  await deleteCustomerSession(env.DB, await sha256Hex(rawToken));
}

export function customerCookie(token: string): string {
  return `${CUSTOMER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CUSTOMER_SESSION_TTL_SECONDS}`;
}

export function clearCustomerCookie(): string {
  return `${CUSTOMER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/* ---------- Google (Gmail) sign-in ---------- */

export function googleAuthReady(env: Env): boolean {
  return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;
}

export function googleAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleOAuthDeps {
  fetchImpl?: typeof fetch;
}

export type GoogleExchangeResult =
  | { ok: true; email: string; emailVerified: boolean }
  | { ok: false; reason: string };

/**
 * Exchanges an OAuth code for a verified Google email. The email comes from
 * Google's userinfo endpoint over TLS using the token we just exchanged — no
 * unverified client data is trusted. Only email_verified accounts sign in.
 */
export async function exchangeGoogleCode(
  env: Env,
  code: string,
  redirectUri: string,
  deps: GoogleOAuthDeps = {},
): Promise<GoogleExchangeResult> {
  if (!googleAuthReady(env)) return { ok: false, reason: 'google_not_configured' };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      signal: controller.signal,
    });
    const tokenData = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
    if (!tokenRes.ok || typeof tokenData?.access_token !== 'string') {
      return { ok: false, reason: 'google_token_exchange_failed' };
    }

    const profileRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: controller.signal,
    });
    const profile = (await profileRes.json().catch(() => null)) as
      | { email?: string; email_verified?: boolean }
      | null;
    if (!profileRes.ok || typeof profile?.email !== 'string' || !isValidEmail(profile.email)) {
      return { ok: false, reason: 'google_profile_unavailable' };
    }
    return { ok: true, email: profile.email, emailVerified: profile.email_verified === true };
  } catch {
    return { ok: false, reason: 'google_timeout' };
  } finally {
    clearTimeout(timer);
  }
}
