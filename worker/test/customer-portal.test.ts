import { beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, applyMigrations, fetch, testEnv } from './helpers';
import { createCustomerSession, findOrCreateCustomer, insertCustomerToken, linkOrdersToCustomer } from '../customer/repo';
import { randomToken, sha256Hex } from '../customer/auth';
import { getVpnOrder, insertVpnOrder, markVpnPaid, markVpnRefunded } from '../vpn/repo';

beforeAll(async () => {
  await applyMigrations();
});

interface Seeded {
  customerId: string;
  cookie: string;
  csrf: string;
  orderId: string;
}

async function seed(email: string): Promise<Seeded> {
  const now = new Date().toISOString();
  const customer = await findOrCreateCustomer(testEnv.DB, email, now);
  const orderId = `ORD-VPN-${crypto.randomUUID()}`;
  await insertVpnOrder(testEnv.DB, {
    id: orderId,
    customerEmail: email,
    customerName: null,
    planId: 'annual',
    intervalMonths: 12,
    amountCents: 7200,
    currency: 'USD',
    providerUsername: `topvpn-${orderId.toLowerCase()}`.slice(0, 50),
    now,
  });
  await linkOrdersToCustomer(testEnv.DB, customer.id, email, now);

  const sessionToken = randomToken();
  const csrf = randomToken(12);
  await createCustomerSession(testEnv.DB, {
    tokenHash: await sha256Hex(sessionToken),
    customerId: customer.id,
    csrfToken: csrf,
    now,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });

  return { customerId: customer.id, cookie: `topvpn_customer_session=${sessionToken}`, csrf, orderId };
}

describe('customer portal ownership', () => {
  it('shows a sign-in notice instead of order data when signed out', async () => {
    const a = await seed(`portal-a-${crypto.randomUUID()}@example.com`);
    const res = await fetch('/account');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(a.orderId);
    expect(html).not.toContain('7200');
  });

  it('shows only the signed-in customer’s orders', async () => {
    const a = await seed(`portal-own-${crypto.randomUUID()}@example.com`);
    const res = await fetch('/account', { headers: { Cookie: a.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(a.orderId);
    expect(html).toContain('Annual');
  });

  it('denies cross-customer order access with 404', async () => {
    const a = await seed(`portal-x-a-${crypto.randomUUID()}@example.com`);
    const b = await seed(`portal-x-b-${crypto.randomUUID()}@example.com`);

    const detail = await fetch(`/account/orders/${encodeURIComponent(b.orderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(detail.status).toBe(404);

    const success = await fetch(`/checkout/success?order=${encodeURIComponent(b.orderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(success.status).toBe(404);
    expect(await success.text()).not.toContain(b.orderId);
  });

  it('never treats a success redirect as payment proof', async () => {
    const a = await seed(`portal-success-${crypto.randomUUID()}@example.com`);
    const before = await getVpnOrder(testEnv.DB, a.orderId);

    const res = await fetch(`/checkout/success?order=${encodeURIComponent(a.orderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Waiting for payment confirmation');
    expect(html).not.toContain('Payment confirmed');

    const after = await getVpnOrder(testEnv.DB, a.orderId);
    expect(after!.payment_status).toBe('unpaid');
    expect(after!.updated_at).toBe(before!.updated_at);
  });

  it('never marks an order paid or refunded on the cancel page', async () => {
    const a = await seed(`portal-cancel-${crypto.randomUUID()}@example.com`);
    const res = await fetch(`/checkout/cancel?order=${encodeURIComponent(a.orderId)}`);
    expect(res.status).toBe(200);

    const order = await getVpnOrder(testEnv.DB, a.orderId);
    expect(order!.payment_status).toBe('unpaid');
    expect(order!.order_status).toBe('pending_payment');
  });

  it('links an order created after sign-in by verified email', async () => {
    const email = `portal-late-${crypto.randomUUID()}@example.com`;
    const a = await seed(email);
    const lateOrderId = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id: lateOrderId,
      customerEmail: email,
      customerName: null,
      planId: 'monthly',
      intervalMonths: 1,
      amountCents: 900,
      currency: 'USD',
      providerUsername: `topvpn-${lateOrderId.toLowerCase()}`.slice(0, 50),
      now: new Date().toISOString(),
    });

    const success = await fetch(`/checkout/success?order=${encodeURIComponent(lateOrderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(success.status).toBe(200);
    expect(await success.text()).toContain(lateOrderId);

    const dashboard = await fetch('/account', { headers: { Cookie: a.cookie } });
    expect(await dashboard.text()).toContain(lateOrderId);
  });

  it('labels a refunded order correctly on the success page', async () => {
    const a = await seed(`portal-refund-${crypto.randomUUID()}@example.com`);
    const now = new Date().toISOString();
    await markVpnPaid(testEnv.DB, a.orderId, { now });
    await markVpnRefunded(testEnv.DB, a.orderId, now);

    const res = await fetch(`/checkout/success?order=${encodeURIComponent(a.orderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Order refunded');
    expect(html).not.toContain('Waiting for payment confirmation');
  });

  it('does not consume the magic link on GET and requires an explicit POST', async () => {
    const email = `confirm-${crypto.randomUUID()}@example.com`;
    const now = new Date().toISOString();
    const customer = await findOrCreateCustomer(testEnv.DB, email, now);
    const token = randomToken();
    await insertCustomerToken(testEnv.DB, {
      tokenHash: await sha256Hex(token),
      customerId: customer.id,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      now,
    });

    const get = await fetch(`/account/verify?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    expect(get.status).toBe(200);
    const html = await get.text();
    const confirm = /name="confirm" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(confirm).not.toBe('');
    expect(get.headers.get('set-cookie') ?? '').toContain('topvpn_verify=');

    // A mail scanner's GET did not consume the token; a POST without the
    // confirm cookie is rejected.
    const noCookie = await fetch('/account/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, confirm }).toString(),
    });
    expect(noCookie.status).toBe(403);

    const crossSite = await fetch('/account/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `topvpn_verify=${confirm}`,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: new URLSearchParams({ token, confirm }).toString(),
    });
    expect(crossSite.status).toBe(403);

    const ok = await fetch('/account/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `topvpn_verify=${confirm}`,
      },
      body: new URLSearchParams({ token, confirm }).toString(),
    });
    expect(ok.status).toBe(303);

    const replay = await fetch('/account/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `topvpn_verify=${confirm}`,
      },
      body: new URLSearchParams({ token, confirm }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it('requires CSRF to log out and invalidates the session', async () => {
    const a = await seed(`portal-logout-${crypto.randomUUID()}@example.com`);

    const denied = await fetch('/account/api/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: a.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'csrf=wrong',
    });
    expect(denied.status).toBe(403);

    const ok = await fetch('/account/api/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: a.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: a.csrf }).toString(),
    });
    expect(ok.status).toBe(303);

    const after = await fetch('/account', { headers: { Cookie: a.cookie } });
    expect(await after.text()).not.toContain(a.orderId);
  });

  it('does not accept an admin session as a customer session', async () => {
    const a = await seed(`portal-admin-${crypto.randomUUID()}@example.com`);
    const login = await adminLogin('test-admin-password-1234');

    const res = await fetch('/account', { headers: { Cookie: login.cookie } });
    const html = await res.text();
    expect(html).not.toContain(a.orderId);
  });

  it('does not accept a customer session on admin order routes', async () => {
    const a = await seed(`portal-admin2-${crypto.randomUUID()}@example.com`);
    const res = await fetch(`/admin/api/vpn/orders/${encodeURIComponent(a.orderId)}`, {
      headers: { Cookie: a.cookie },
    });
    expect(res.status).toBe(401);
  });
});
