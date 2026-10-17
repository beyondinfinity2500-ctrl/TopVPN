import { beforeAll, describe, expect, it } from 'vitest';
import { campaignEnd } from '../../src/lib/ads/pricing';
import {
  ADMIN_PASSWORD,
  adminFetch,
  adminLogin,
  applyMigrations,
  createOrder,
  fetch,
  fixtureBytes,
  orderForm,
  postOrder,
  publicStatus,
} from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

describe('admin authentication', () => {
  it('refuses unauthenticated access to every data route', async () => {
    const { orderId } = await createOrder({}, '10.40.0.1');
    expect((await fetch('/admin/api/orders')).status).toBe(401);
    expect((await fetch(`/admin/api/orders/${orderId}`)).status).toBe(401);
    expect((await fetch(`/admin/api/orders/${orderId}/creative`)).status).toBe(401);
    expect(
      (
        await fetch(`/admin/api/orders/${orderId}/approval`, {
          method: 'POST',
          body: JSON.stringify({ status: 'approved' }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const { res } = await adminLogin('wrong-password', '10.40.0.2');
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated failed logins from one IP', async () => {
    const ip = '10.40.0.3';
    for (let i = 0; i < 10; i++) {
      const { res } = await adminLogin('wrong-password', ip);
      expect(res.status).toBe(401);
    }
    const { res } = await adminLogin('wrong-password', ip);
    expect(res.status).toBe(429);
  });

  it('logs in with the configured password and returns a session cookie', async () => {
    const { res, cookie, csrf, data } = await adminLogin(ADMIN_PASSWORD, '10.40.0.4');
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(cookie).toMatch(/^topvpn_admin_session=/);
    expect(csrf).toBeTruthy();

    const session = await fetch('/admin/api/session', { headers: { Cookie: cookie } });
    expect(await session.json()).toEqual({ authenticated: true, csrfToken: csrf });
  });

  it('serves the dashboard shell with no sensitive data embedded', async () => {
    const res = await fetch('/admin');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Advertising Admin/);
    expect(body).not.toMatch(/ORD-[A-Z0-9]/);
  });
});

describe('admin dashboard', () => {
  async function login(ip = '10.40.1.1') {
    const { cookie, csrf } = await adminLogin(ADMIN_PASSWORD, ip);
    return { cookie, csrf };
  }

  it('lists orders with pagination metadata', async () => {
    const { cookie } = await login('10.40.1.2');
    const res = await adminFetch(cookie, '/admin/api/orders?page=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { orders: unknown[]; total: number; page: number; perPage: number };
    expect(data.perPage).toBe(20);
    expect(Array.isArray(data.orders)).toBe(true);
    expect(data.total).toBeGreaterThanOrEqual(data.orders.length);
  });

  it('paginates through more than one page of orders', async () => {
    const { cookie } = await login('10.40.1.2b');
    // Create enough orders to fill the first page (perPage is 20).
    for (let i = 0; i < 22; i++) {
      await createOrder({ name: `Pagination Advertiser ${i}` }, `10.40.2.${i}`);
    }
    const first = (await (await adminFetch(cookie, '/admin/api/orders?page=1')).json()) as {
      orders: unknown[];
      total: number;
    };
    const second = (await (await adminFetch(cookie, '/admin/api/orders?page=2')).json()) as {
      orders: unknown[];
    };
    expect(first.orders.length).toBe(20);
    expect(second.orders.length).toBeGreaterThan(0);
    expect(first.total).toBeGreaterThanOrEqual(22);
  });

  it('searches and filters orders', async () => {
    const { cookie } = await login('10.40.1.3');
    const { orderId } = await createOrder({ name: 'Filterable Advertiser' }, '10.40.1.4');

    const byQuery = (await (
      await adminFetch(cookie, `/admin/api/orders?q=${encodeURIComponent('Filterable')}`)
    ).json()) as { orders: { id: string }[]; total: number };
    expect(byQuery.orders.some((o) => o.id === orderId)).toBe(true);

    const byPayment = (await (
      await adminFetch(cookie, '/admin/api/orders?payment=pending')
    ).json()) as { orders: { id: string; payment_status: string }[] };
    expect(byPayment.orders.every((o) => o.payment_status === 'pending')).toBe(true);

    const notFound = (await (
      await adminFetch(cookie, '/admin/api/orders?q=zzz-no-such-advertiser')
    ).json()) as { orders: unknown[]; total: number };
    expect(notFound.total).toBe(0);
  });

  it('shows order detail including payment references', async () => {
    const { cookie } = await login('10.40.1.5');
    const { orderId } = await createOrder({}, '10.40.1.6');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: Record<string, unknown> };
    expect(data.order.id).toBe(orderId);
    expect(data.order.payment_status).toBe('pending');
  });

  it('previews a text creative only for an authenticated admin', async () => {
    const { cookie } = await login('10.40.1.7');
    const { orderId } = await createOrder({}, '10.40.1.8');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/creative`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { format: string; copy: string; destinationUrl: string };
    expect(data.format).toBe('text');
    expect(data.copy).toMatch(/money-back guarantee/);
  });

  it('previews an image creative served only to an authenticated admin', async () => {
    const { cookie } = await login('10.40.1.9');
    const { orderId } = await createOrder({ format: 'image' }, '10.40.1.10', {
      bytes: fixtureBytes('PNG_WIDE'),
      mime: 'image/png',
      name: 'banner.png',
    });
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/creative`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toMatch(/private/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The stored optimized output is WebP (RIFF....WEBP).
    expect([...bytes.slice(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect([...bytes.slice(8, 12)]).toEqual([0x57, 0x45, 0x42, 0x50]);
  });

  it('approves and rejects creatives, requiring a CSRF token', async () => {
    const { cookie, csrf } = await login('10.40.1.11');
    const { orderId } = await createOrder({}, '10.40.1.12');

    const noCsrf = await adminFetch(cookie, `/admin/api/orders/${orderId}/approval`, {
      method: 'POST',
      body: { status: 'approved' },
    });
    expect(noCsrf.status).toBe(403);

    const approved = await adminFetch(cookie, `/admin/api/orders/${orderId}/approval`, {
      method: 'POST',
      body: { status: 'approved' },
      csrf,
    });
    expect(approved.status).toBe(200);

    const rejected = await adminFetch(cookie, `/admin/api/orders/${orderId}/approval`, {
      method: 'POST',
      body: { status: 'rejected' },
      csrf,
    });
    expect(rejected.status).toBe(200);
    const detail = (await (await adminFetch(cookie, `/admin/api/orders/${orderId}`)).json()) as {
      order: { approval_status: string };
    };
    expect(detail.order.approval_status).toBe('rejected');
  });

  it('rejects an invalid approval status', async () => {
    const { cookie, csrf } = await login('10.40.1.13');
    const { orderId } = await createOrder({}, '10.40.1.14');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/approval`, {
      method: 'POST',
      body: { status: 'published' },
      csrf,
    });
    expect(res.status).toBe(400);
  });

  it('schedules a campaign and computes the end date from the duration', async () => {
    const { cookie, csrf } = await login('10.40.1.15');
    const { orderId } = await createOrder({ duration: '6' }, '10.40.1.16');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/campaign`, {
      method: 'POST',
      body: { status: 'scheduled', start: '2026-11-01' },
      csrf,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { campaignStart: string; campaignEnd: string };
    expect(data.campaignStart).toBe('2026-11-01T00:00:00.000Z');
    expect(data.campaignEnd).toBe(campaignEnd('2026-11-01T00:00:00.000Z', 6));

    const detail = (await (await adminFetch(cookie, `/admin/api/orders/${orderId}`)).json()) as {
      order: { campaign_status: string; payment_status: string };
    };
    expect(detail.order.campaign_status).toBe('scheduled');
    // Scheduling never falsifies payment state.
    expect(detail.order.payment_status).toBe('pending');
  });

  it('adds internal notes without exposing them publicly', async () => {
    const { cookie, csrf } = await login('10.40.1.17');
    const { orderId } = await createOrder({}, '10.40.1.18');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/note`, {
      method: 'POST',
      body: { note: 'Requested a custom start date.' },
      csrf,
    });
    expect(res.status).toBe(200);

    const detail = (await (await adminFetch(cookie, `/admin/api/orders/${orderId}`)).json()) as {
      order: { admin_notes: string };
    };
    expect(detail.order.admin_notes).toMatch(/Requested a custom start date/);

    const status = await publicStatus(orderId);
    expect(JSON.stringify(status)).not.toMatch(/Requested a custom start date/);
  });

  it('provides no endpoint to mark a payment paid manually', async () => {
    const { cookie, csrf } = await login('10.40.1.19');
    const { orderId } = await createOrder({}, '10.40.1.20');
    const res = await adminFetch(cookie, `/admin/api/orders/${orderId}/payment`, {
      method: 'POST',
      body: { paymentStatus: 'paid' },
      csrf,
    });
    expect(res.status).toBe(404);
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');
  });

  it('logs out and invalidates the session', async () => {
    const { cookie } = await login('10.40.1.21');
    const res = await adminFetch(cookie, '/admin/api/logout', { method: 'POST' });
    expect(res.status).toBe(200);

    const after = (await (await fetch('/admin/api/session', { headers: { Cookie: cookie } })).json()) as {
      authenticated: boolean;
    };
    expect(after.authenticated).toBe(false);
    expect((await adminFetch(cookie, '/admin/api/orders')).status).toBe(401);
  });
});

describe('order form hardening (admin-independent)', () => {
  it('does not accept a hidden honeypot field', async () => {
    const res = await postOrder(orderForm({ company_full_name: 'SEO Bot Inc' }), { ip: '10.40.9.1' });
    expect(res.status).toBe(400);
  });
});
