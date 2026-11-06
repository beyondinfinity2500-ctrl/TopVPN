import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { getSession } from '../db';
import { applyMigrations, testEnv } from './helpers';
import {
  consumeMagicLink,
  customerAuthReady,
  customerCookie,
  clearCustomerCookie,
  getCustomerSessionFromToken,
  logoutCustomer,
  normalizeEmail,
  randomToken,
  requestMagicLink,
  sha256Hex,
} from '../customer/auth';
import { createCustomerSession, findOrCreateCustomer, listCustomerOrders } from '../customer/repo';
import { insertVpnOrder } from '../vpn/repo';

const baseEnv = { DB: testEnv.DB } as unknown as Env;

beforeAll(async () => {
  await applyMigrations();
});

function captureSender() {
  const sent: { to: string; token: string }[] = [];
  return {
    sent,
    send: async (input: { to: string; token: string }) => {
      sent.push(input);
      return { ok: true, status: 'sent' };
    },
  };
}

async function tokenCount(customerId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS n FROM vpn_customer_tokens WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function totalTokens(): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM vpn_customer_tokens`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('magic-link tokens', () => {
  it('stores only a hash, never the raw token', async () => {
    const email = `hash-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    const result = await requestMagicLink(baseEnv, { email, ip: `10.1.0.${Math.floor(Math.random() * 200)}` }, { send });

    expect(result).toEqual({ ok: true });
    const raw = sent[0].token;
    const rawHash = await sha256Hex(raw);

    const stored = await testEnv.DB.prepare(`SELECT token_hash FROM vpn_customer_tokens WHERE token_hash = ?`)
      .bind(rawHash)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(rawHash);

    const rawRow = await testEnv.DB.prepare(`SELECT token_hash FROM vpn_customer_tokens WHERE token_hash = ?`)
      .bind(raw)
      .first();
    expect(rawRow).toBeNull();
  });

  it('is single-use and creates a session only once', async () => {
    const email = `single-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    await requestMagicLink(baseEnv, { email, ip: '10.2.0.1' }, { send });

    const first = await consumeMagicLink(baseEnv, sent[0].token);
    expect(first.ok).toBe(true);
    const second = await consumeMagicLink(baseEnv, sent[0].token);
    expect(second.ok).toBe(false);

    if (!first.ok) throw new Error('expected success');
    const session = await getCustomerSessionFromToken(baseEnv, first.session.sessionToken);
    expect(session?.email).toBe(normalizeEmail(email));
  });

  it('rejects expired links', async () => {
    const email = `expired-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    const start = new Date('2026-01-01T00:00:00.000Z');
    await requestMagicLink(baseEnv, { email, ip: '10.3.0.1' }, { send, now: start });

    const later = new Date(start.getTime() + 16 * 60 * 1000);
    const result = await consumeMagicLink(baseEnv, sent[0].token, { now: later });
    expect(result.ok).toBe(false);
  });

  it('consumes a token atomically under concurrent requests', async () => {
    const email = `race-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    await requestMagicLink(baseEnv, { email, ip: '10.4.0.1' }, { send });

    const results = await Promise.all([
      consumeMagicLink(baseEnv, sent[0].token),
      consumeMagicLink(baseEnv, sent[0].token),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('rate limits per IP+email while still returning a generic response', async () => {
    const email = `limit-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    const customer = await findOrCreateCustomer(testEnv.DB, email, new Date().toISOString());

    for (let i = 0; i < 5; i++) {
      const result = await requestMagicLink(baseEnv, { email, ip: '10.5.0.1' }, { send });
      expect(result).toEqual({ ok: true });
    }

    expect(sent.length).toBe(3); // email limit
    expect(await tokenCount(customer.id)).toBe(3);
  });

  it('does not create a token when email delivery is not configured', async () => {
    const email = `nocfg-${crypto.randomUUID()}@example.com`;
    expect(customerAuthReady(baseEnv)).toBe(false);
    await requestMagicLink(baseEnv, { email, ip: '10.6.0.1' });
    const customer = await testEnv.DB.prepare(`SELECT id FROM vpn_customers WHERE email_norm = ?`)
      .bind(email)
      .first<{ id: string }>();
    if (customer) expect(await tokenCount(customer.id)).toBe(0);
  });

  it('does not treat a customer session as an admin session', async () => {
    const email = `sep-${crypto.randomUUID()}@example.com`;
    const { sent, send } = captureSender();
    await requestMagicLink(baseEnv, { email, ip: '10.7.0.1' }, { send });
    const result = await consumeMagicLink(baseEnv, sent[0].token);
    if (!result.ok) throw new Error('expected success');

    expect(await getSession(testEnv.DB, result.session.sessionToken)).toBeNull();
  });

  it('links verified-email orders and supports logout', async () => {    const email = `link-${crypto.randomUUID()}@example.com`;
    const orderId = `ORD-VPN-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await insertVpnOrder(testEnv.DB, {
      id: orderId,
      customerEmail: email,
      customerName: null,
      planId: 'monthly',
      intervalMonths: 1,
      amountCents: 900,
      currency: 'USD',
      providerUsername: `topvpn-${orderId.toLowerCase()}`.slice(0, 50),
      now,
    });

    const { sent, send } = captureSender();
    await requestMagicLink(baseEnv, { email, ip: '10.8.0.1' }, { send });
    const result = await consumeMagicLink(baseEnv, sent[0].token);
    if (!result.ok) throw new Error('expected success');

    const orders = await listCustomerOrders(testEnv.DB, result.session.customerId);
    expect(orders.map((o) => o.id)).toContain(orderId);

    await logoutCustomer(baseEnv, result.session.sessionToken);
    expect(await getCustomerSessionFromToken(baseEnv, result.session.sessionToken)).toBeNull();
  });

  it('sets secure customer cookie attributes', () => {
    const cookie = customerCookie('sample-token');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) {
      expect(cookie).toContain(attr);
    }
    expect(clearCustomerCookie()).toContain('Max-Age=0');
  });

  it('rejects expired customer sessions', async () => {
    const email = `session-exp-${crypto.randomUUID()}@example.com`;
    const customer = await findOrCreateCustomer(testEnv.DB, email, '2026-01-01T00:00:00.000Z');
    const raw = randomToken();
    await createCustomerSession(testEnv.DB, {
      tokenHash: await sha256Hex(raw),
      customerId: customer.id,
      csrfToken: 'csrf',
      now: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });

    expect(await getCustomerSessionFromToken(baseEnv, raw, new Date('2026-01-01T12:00:00.000Z'))).not.toBeNull();
    expect(await getCustomerSessionFromToken(baseEnv, raw, new Date('2026-01-03T00:00:00.000Z'))).toBeNull();
  });

  it('limits sign-in links per IP', async () => {
    const before = await totalTokens();
    const { send } = captureSender();
    const ip = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.250`;

    for (let i = 0; i < 11; i++) {
      await requestMagicLink(
        baseEnv,
        { email: `ip-${crypto.randomUUID()}@example.com`, ip },
        { send },
      );
    }

    expect((await totalTokens()) - before).toBe(10);
  });
});
