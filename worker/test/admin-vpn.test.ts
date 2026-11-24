/**
 * Admin VPN-commerce API tests: server-side authorization (no button is
 * authorization), CSRF on every mutation, audit logging, and customer data
 * isolation (a customer can only reach their own tickets).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, adminFetch, adminLogin, ADMIN_PASSWORD, fetch as workerFetch, testEnv } from './helpers';
import { createTicket, getCustomerTicket, listTicketsForCustomer } from '../support/tickets';
import { writeAuditLog } from '../routes/admin-vpn';

let cookie = '';
let csrf = '';

beforeAll(async () => {
  await applyMigrations();
  const login = await adminLogin(ADMIN_PASSWORD, '10.74.0.1');
  cookie = login.cookie;
  csrf = login.csrf;
});

describe('admin shell integrity', () => {
  it('the rendered admin script must compile (black-page regression guard)', async () => {
    const res = await workerFetch('/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const script = match![1];
    // A template-literal escape bug (a consumed backslash, e.g. '\n' becoming a
    // raw newline) once produced an unparseable script: init() never ran and
    // the page rendered fully black. Compiling catches that class of bug.
    const compile = (): unknown => new Function(script);
    expect(compile).not.toThrow();
  });
});

describe('server-side authorization', () => {
  it('rejects unauthenticated reads on every VPN admin endpoint', async () => {
    for (const path of ['/admin/api/vpn/overview', '/admin/api/vpn/customers', '/admin/api/vpn/coupons', '/admin/api/vpn/tickets', '/admin/api/vpn/audit']) {
      const res = await workerFetch(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects mutations without a valid session or CSRF token', async () => {
    const noSession = await workerFetch('/admin/api/vpn/coupons', {
      method: 'POST',
      body: JSON.stringify({ code: 'X', discountType: 'fixed', discountValue: 100 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noSession.status).toBe(403);

    const noCsrf = await adminFetch(cookie, '/admin/api/vpn/coupons', {
      method: 'POST',
      body: { code: 'NOCSP', discountType: 'fixed', discountValue: 100 },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe('overview', () => {
  it('returns commerce stats for an authenticated admin', async () => {
    const res = await adminFetch(cookie, '/admin/api/vpn/overview');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stats: Record<string, number>; netRevenueCents: number };
    expect(data.stats).toHaveProperty('customers_total');
    expect(data.stats).toHaveProperty('gross_cents');
    expect(data.stats).toHaveProperty('tickets_open');
    expect(typeof data.netRevenueCents).toBe('number');
  });
});

describe('customers', () => {
  it('lists customers and blocks one with audit trail', async () => {
    // Seed a customer directly.
    await testEnv.DB.prepare(
      `INSERT INTO vpn_customers (id, email_norm, created_at, updated_at) VALUES ('CUS-admin-test', 'bad-actor@example.com', ?, ?)`,
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();

    const list = await adminFetch(cookie, '/admin/api/vpn/customers?q=bad-actor');
    expect(list.status).toBe(200);
    const { customers } = (await list.json()) as { customers: { id: string; email: string }[] };
    expect(customers.some((c) => c.email === 'bad-actor@example.com')).toBe(true);

    const noReason = await adminFetch(cookie, '/admin/api/vpn/customers/CUS-admin-test/block', {
      method: 'POST',
      body: { blocked: true },
      csrf,
    });
    expect(noReason.status).toBe(422); // reason required when blocking

    const res = await adminFetch(cookie, '/admin/api/vpn/customers/CUS-admin-test/block', {
      method: 'POST',
      body: { blocked: true, reason: 'abuse: shared credentials resale' },
      csrf,
    });
    expect(res.status).toBe(200);

    const row = await testEnv.DB.prepare('SELECT blocked_at, blocked_reason FROM vpn_customers WHERE id = ?')
      .bind('CUS-admin-test')
      .first<{ blocked_at: string | null; blocked_reason: string | null }>();
    expect(row?.blocked_at).not.toBeNull();
    expect(row?.blocked_reason).toBe('abuse: shared credentials resale');

    const audit = await adminFetch(cookie, '/admin/api/vpn/audit');
    const { entries } = (await audit.json()) as { entries: { action: string; target: string }[] };
    expect(entries.some((e) => e.action === 'customer_blocked' && e.target === 'CUS-admin-test')).toBe(true);

    const unblock = await adminFetch(cookie, '/admin/api/vpn/customers/CUS-admin-test/block', {
      method: 'POST',
      body: { blocked: false },
      csrf,
    });
    expect(unblock.status).toBe(200);
  });
});

describe('coupons', () => {
  it('creates, lists, and toggles coupons (audited)', async () => {
    const create = await adminFetch(cookie, '/admin/api/vpn/coupons', {
      method: 'POST',
      body: {
        code: 'WELCOME10',
        discountType: 'percent',
        discountValue: 10,
        appliesPlanId: 'annual',
        firstPurchaseOnly: true,
        maxRedemptions: 100,
      },
      csrf,
    });
    expect(create.status).toBe(201);

    const bad = await adminFetch(cookie, '/admin/api/vpn/coupons', {
      method: 'POST',
      body: { code: 'BAD!!', discountType: 'percent', discountValue: 200 },
      csrf,
    });
    expect(bad.status).toBe(422);

    const list = await adminFetch(cookie, '/admin/api/vpn/coupons');
    const { coupons } = (await list.json()) as { coupons: { id: string; code: string; active: number }[] };
    const welcome = coupons.find((c) => c.code === 'WELCOME10');
    expect(welcome).toBeDefined();

    const off = await adminFetch(cookie, `/admin/api/vpn/coupons/${welcome!.id}/toggle`, {
      method: 'POST',
      body: { active: false },
      csrf,
    });
    expect(off.status).toBe(200);

    const audit = await adminFetch(cookie, '/admin/api/vpn/audit');
    const { entries } = (await audit.json()) as { entries: { action: string }[] };
    expect(entries.some((e) => e.action === 'coupon_created')).toBe(true);
    expect(entries.some((e) => e.action === 'coupon_deactivated')).toBe(true);
  });
});

describe('support tickets + customer data isolation', () => {
  const NOW = new Date().toISOString();

  it('keeps each customer locked to their own tickets', async () => {
    const a = await createTicket(testEnv.DB, {
      customerId: 'CUS-a',
      email: 'a@example.com',
      subject: 'Customer A problem',
      body: 'I cannot connect.',
      now: NOW,
    });
    await createTicket(testEnv.DB, {
      customerId: 'CUS-b',
      email: 'b@example.com',
      subject: 'Customer B problem',
      body: 'Refund question.',
      now: NOW,
    });

    // Ownership is enforced in the query — B can never read A's ticket.
    expect(await getCustomerTicket(testEnv.DB, 'CUS-b', a.id)).toBeNull();
    expect(await getCustomerTicket(testEnv.DB, 'CUS-a', a.id)).not.toBeNull();

    const listA = await listTicketsForCustomer(testEnv.DB, 'CUS-a');
    expect(listA.every((t) => t.customer_id === 'CUS-a')).toBe(true);
  });

  it('lets the admin list, reply, and change ticket status (audited)', async () => {
    const list = await adminFetch(cookie, '/admin/api/vpn/tickets?status=open');
    expect(list.status).toBe(200);
    const { tickets } = (await list.json()) as { tickets: { id: string; subject: string }[] };
    const target = tickets.find((t) => t.subject === 'Customer A problem');
    expect(target).toBeDefined();

    const detail = await adminFetch(cookie, `/admin/api/vpn/tickets/${target!.id}`);
    const { messages } = (await detail.json()) as { messages: { author: string }[] };
    expect(messages.some((m) => m.author === 'customer')).toBe(true);

    const reply = await adminFetch(cookie, `/admin/api/vpn/tickets/${target!.id}/reply`, {
      method: 'POST',
      body: { body: 'Please try re-importing your config file.' },
      csrf,
    });
    expect(reply.status).toBe(200);

    const close = await adminFetch(cookie, `/admin/api/vpn/tickets/${target!.id}/status`, {
      method: 'POST',
      body: { status: 'closed' },
      csrf,
    });
    expect(close.status).toBe(200);

    const row = await testEnv.DB.prepare('SELECT status FROM support_tickets WHERE id = ?').bind(target!.id).first<{ status: string }>();
    expect(row?.status).toBe('closed');

    const audit = await adminFetch(cookie, '/admin/api/vpn/audit');
    const { entries } = (await audit.json()) as { entries: { action: string; target: string }[] };
    expect(entries.some((e) => e.action === 'ticket_reply' && e.target === target!.id)).toBe(true);
    expect(entries.some((e) => e.action === 'ticket_status' && e.target === target!.id)).toBe(true);
  });

  it('records the audit helper cleanly', async () => {
    await writeAuditLog(testEnv.DB, 'test_action', 'target-1', 'detail', '10.0.0.1', NOW);
    const row = await testEnv.DB.prepare(`SELECT actor, action FROM admin_audit_log WHERE action = 'test_action'`).first<{ actor: string }>();
    expect(row?.actor).toBe('admin');
  });
});

describe('provider suspend / reactivate / sync-expiry', () => {
  const NOW = new Date().toISOString();

  async function seedOrderWithAccount(id: string, paymentMode = 'live'): Promise<void> {
    const accountId = String(1000 + Math.floor(Math.random() * 1_000_000));
    await testEnv.DB.prepare(
      `INSERT INTO vpn_orders (id, customer_email, plan_id, interval_months, amount_cents, currency,
         order_status, payment_status, provisioning_status, subscription_status, provider_account_id,
         provider_username, expire_at, payment_mode, created_at, updated_at)
       VALUES (?, 'admin-vpn@example.com', 'monthly', 1, 900, 'USD', 'active', 'paid', 'succeeded', 'active', ?,
         ?, ?, ?, ?, ?)`,
    )
      .bind(id, accountId, `topvpn-${id.toLowerCase()}`, '2027-01-01', paymentMode, NOW, NOW)
      .run();
  }

  it('requires a session and CSRF token', async () => {
    const id = 'ORD-VPN-admin-suspend-1';
    await seedOrderWithAccount(id);

    const noSession = await workerFetch(`/admin/api/vpn/orders/${id}/suspend`, { method: 'POST' });
    expect(noSession.status).toBe(403);

    const noCsrf = await adminFetch(cookie, `/admin/api/vpn/orders/${id}/suspend`, { method: 'POST' });
    expect(noCsrf.status).toBe(403);
  });

  it('returns 503 when the provider is not configured', async () => {
    const id = 'ORD-VPN-admin-suspend-2';
    await seedOrderWithAccount(id);
    // No VPNRESELLERS_API_TOKEN in the test env => provider not configured.
    const res = await adminFetch(cookie, `/admin/api/vpn/orders/${id}/suspend`, { method: 'POST', body: {}, csrf });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/provider/i);
  });

  it('404s for an order with no provider account', async () => {
    const res = await adminFetch(cookie, '/admin/api/vpn/orders/ORD-VPN-does-not-exist/sync-expiry', {
      method: 'POST',
      body: {},
      csrf,
    });
    expect(res.status).toBe(404);
  });

  it('refuses sync-expiry for a non-active order', async () => {
    const id = 'ORD-VPN-admin-sync-pending';
    await testEnv.DB.prepare(
      `INSERT INTO vpn_orders (id, customer_email, plan_id, interval_months, amount_cents, currency,
         order_status, payment_status, provisioning_status, subscription_status, created_at, updated_at)
       VALUES (?, 'admin-vpn@example.com', 'monthly', 1, 900, 'USD', 'pending_payment', 'unpaid', 'none', 'none', ?, ?)`,
    )
      .bind(id, NOW, NOW)
      .run();
    const res = await adminFetch(cookie, `/admin/api/vpn/orders/${id}/sync-expiry`, { method: 'POST', body: {}, csrf });
    expect(res.status).toBe(409);
  });

  it('sync-expiry is a safe no-op (skipped) for a sandbox order', async () => {
    const id = 'ORD-VPN-admin-sync-sandbox';
    await seedOrderWithAccount(id, 'sandbox');
    const res = await adminFetch(cookie, `/admin/api/vpn/orders/${id}/sync-expiry`, { method: 'POST', body: {}, csrf });
    // Live provider call is not attempted for sandbox orders => skipped/409.
    expect(res.status).toBe(409);
  });
});
