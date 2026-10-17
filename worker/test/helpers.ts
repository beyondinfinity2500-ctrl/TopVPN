/**
 * Shared helpers for worker integration tests. Tests run inside the Workers
 * runtime, so bindings are used directly and requests are dispatched through
 * the Worker's own fetch handler.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import type { Env } from '../env';
import migrationSql from '../../migrations/0001_ads_init.sql?raw';
import migrationSql2 from '../../migrations/0002_ads_creative_status.sql?raw';
import { FIXTURES } from './fixtures';

const BASE = 'https://topvpn.test';

/**
 * The Worker's own Env type, applied to the runtime-provided bindings so tests
 * get real D1/R2 types without relying on generated ambient declarations.
 */
export const testEnv = env as unknown as Env;

type WorkerExports = {
  default: {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  };
};
const worker = exports as unknown as WorkerExports;

const enc = new TextEncoder();
function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const TEST_WEBHOOK_SECRET = 'whsec_test_signing_secret';

export type FetchInit = RequestInit & { ip?: string };

/** Dispatches a request through the Worker and waits for waitUntil() work. */
export async function fetch(pathAndQuery: string, init: FetchInit = {}): Promise<Response> {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip) headers.set('CF-Connecting-IP', ip);
  const ctx = createExecutionContext();
  const response = await worker.default.fetch(
    new Request(`${BASE}${pathAndQuery}`, { ...rest, headers }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Applies the D1 schema (idempotent) so tests run against the real tables.
 * The raw SQL is split into statements here because `readD1Migrations()` must
 * run under Node.js while these tests execute inside the Workers runtime.
 */
export async function applyMigrations(): Promise<void> {
  const splitStatements = (sql: string) =>
    sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

  await testEnv.DB.batch(splitStatements(migrationSql).map((s) => testEnv.DB.prepare(s)));

  // Migration 0002 adds NOT NULL columns; ALTER TABLE ... ADD COLUMN cannot be
  // re-run, so skip it when a previous run in this runtime already applied it.
  const cols = await testEnv.DB.prepare("PRAGMA table_info('ads_orders')").all<{ name: string }>();
  const hasStatus = (cols.results ?? []).some((c) => c.name === 'creative_status');
  if (!hasStatus) {
    await testEnv.DB.batch(splitStatements(migrationSql2).map((s) => testEnv.DB.prepare(s)));
  }
}

export async function getCsrf(ip = '10.0.0.7'): Promise<string> {
  const res = await fetch('/api/ads/csrf', { headers: {}, ip });
  const data = (await res.json()) as { token?: string; error?: string };
  if (!data.token) throw new Error(`CSRF endpoint failed: ${data.error ?? res.status}`);
  return data.token;
}

export function orderForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Jane Advertiser',
    email: 'jane@example.com',
    website: 'https://example.com',
    placement: 'header',
    duration: '3',
    format: 'text',
    terms: 'on',
    copy: 'Privacy-first VPN with a 30-day money-back guarantee.',
    destination_url: 'https://example.com/offer',
    ...overrides,
  };
}

function formDataFrom(form: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) body.append(key, value);
  return body;
}

export async function postOrder(
  form: Record<string, string>,
  options: { ip?: string; csrf?: string; file?: { bytes: Uint8Array; mime: string; name: string } } = {},
): Promise<Response> {
  const token = options.csrf ?? (await getCsrf(options.ip));
  const body = formDataFrom(form);
  if (options.file) {
    body.append('creative', new Blob([options.file.bytes], { type: options.file.mime }), options.file.name);
  }
  return fetch('/api/ads/orders', {
    method: 'POST',
    body,
    headers: { 'X-CSRF-Token': token },
    ip: options.ip ?? '10.0.0.8',
  });
}

export async function createOrder(
  overrides: Record<string, string> = {},
  ip = '10.0.0.8',
  file?: { bytes: Uint8Array; mime: string; name: string },
): Promise<{ res: Response; orderId: string; data: Record<string, unknown> }> {
  const res = await postOrder(orderForm(overrides), { ip, file });
  const data = (await res.json()) as Record<string, unknown>;
  return { res, orderId: data.orderId as string, data };
}

/** A minimal valid PNG for upload tests. */
export function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  ]);
}

/** Decodes a base64 fixture (worker/test/fixtures.ts) to bytes. */
export function fixtureBytes(key: string): Uint8Array {
  const bin = atob(FIXTURES[key]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uploads a fixture as the order's image creative. */
export async function createImageOrder(
  fixtureKey: string,
  overrides: Record<string, string> = {},
  ip = '10.30.0.1',
  mime = 'image/png',
  name = 'banner.png',
): Promise<{ res: Response; orderId: string; data: Record<string, unknown> }> {
  return createOrder({ ...orderForm(), format: 'image', ...overrides }, ip, {
    bytes: fixtureBytes(fixtureKey),
    mime,
    name,
  });
}

/* ---------- Stripe webhook helpers ---------- */
export async function signWebhook(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`)),
  );
  return `t=${timestamp},v1=${toHex(sig)}`;
}

export function webhookEvent(
  type: string,
  orderId: string,
  objectOverrides: Record<string, unknown> = {},
  eventId?: string,
): { id: string; type: string; data: { object: Record<string, unknown> } } {
  return {
    id: eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    type,
    data: {
      object: {
        id: 'cs_test_session',
        client_reference_id: orderId,
        metadata: { order_id: orderId },
        ...objectOverrides,
      },
    },
  };
}

export async function postWebhook(
  secret: string,
  event: unknown,
  options: { signature?: string; ip?: string } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(event);
  return fetch('/api/ads/webhook', {
    method: 'POST',
    body: rawBody,
    headers: {
      'stripe-signature': options.signature ?? (await signWebhook(secret, rawBody)),
      'Content-Type': 'application/json',
    },
    ip: options.ip ?? '10.0.0.9',
  });
}

export async function publicStatus(orderId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/ads/orders/${encodeURIComponent(orderId)}`);
  return (await res.json()) as Record<string, unknown>;
}

/* ---------- admin helpers ---------- */
export const ADMIN_PASSWORD = 'test-admin-password-1234';

export async function adminLogin(
  password: string,
  ip = '10.0.0.10',
): Promise<{ res: Response; cookie: string; csrf: string; data: Record<string, unknown> }> {
  const res = await fetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
    headers: { 'Content-Type': 'application/json' },
    ip,
  });
  const data = (await res.json()) as Record<string, unknown>;
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { res, cookie: setCookie.split(';')[0], csrf: data.csrfToken as string, data };
}

export async function adminFetch(
  cookie: string,
  path: string,
  options: { method?: string; body?: unknown; csrf?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
  }
  return fetch(path, {
    method: options.method ?? 'GET',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    headers,
  });
}
