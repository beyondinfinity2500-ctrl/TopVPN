/**
 * Admin authentication and CSRF tokens.
 *
 * - Admin password is stored as a PBKDF2-SHA256 hash in the ADMIN_PASSWORD_HASH
 *   secret (never plaintext in code). Format: "<iterations>.<saltB64>.<hashB64>"
 * - Sessions are random tokens stored in D1, served via an HttpOnly/Secure/
 *   SameSite=Strict cookie.
 * - The public order form uses stateless HMAC-signed CSRF tokens.
 */
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const CSRF_TTL_SECONDS = 24 * 60 * 60; // 24 hours

const enc = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/* ---------- Admin password (PBKDF2) ---------- */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `${iterations}.${bytesToBase64(salt)}.${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('.');
  if (parts.length !== 3) return false;
  const iterations = Number(parts[0]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) return false;
  const salt = base64ToBytes(parts[1]);
  const expected = base64ToBytes(parts[2]);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const actual = new Uint8Array(hash);
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
  return mismatch === 0;
}

/* ---------- Sessions ---------- */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes.buffer);
}

export const SESSION_COOKIE = 'topvpn_admin_session';

export function sessionCookieHeader(token: string): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/admin',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  return attrs.join('; ');
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export const SESSION_TTL = SESSION_TTL_SECONDS;

/* ---------- CSRF (public order form): stateless HMAC token ---------- */
export interface CsrfToken {
  token: string;
  expiresAt: number;
}

export async function issueCsrfToken(secret: string): Promise<CsrfToken> {
  const expiresAt = Math.floor(Date.now() / 1000) + CSRF_TTL_SECONDS;
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const payload = `${expiresAt}.${nonce}`;
  const key = await hmacKey(secret);
  const sig = bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  return { token: `${payload}.${sig}`, expiresAt };
}

export async function verifyCsrfToken(secret: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isInteger(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false; // expired
  const key = await hmacKey(secret);
  const expected = bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${expStr}.${nonce}`)));
  return timingSafeEqual(sig, expected);
}
