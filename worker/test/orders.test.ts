import { beforeAll, describe, expect, it } from 'vitest';
import { DURATIONS, PLACEMENTS, priceFor } from '../../src/lib/ads/pricing';
import {
  applyMigrations,
  createOrder,
  fetch,
  fixtureBytes,
  getCsrf,
  orderForm,
  postOrder,
  publicStatus,
  testEnv,
} from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

describe('order creation', () => {
  it('stores the server-calculated price for every placement x duration', async () => {
    for (const placement of PLACEMENTS) {
      for (const duration of DURATIONS) {
        const ip = `10.20.${PLACEMENTS.indexOf(placement) + 1}.${duration}`;
        const { res, orderId } = await createOrder({ placement, duration: String(duration) }, ip);
        // Stripe is not configured in tests, so the payment step reports 503
        // while the order itself is stored with a pending payment.
        expect(res.status).toBe(503);
        expect(orderId).toMatch(/^ORD-/);
        const status = await publicStatus(orderId);
        expect(status.amountCents).toBe(priceFor(placement, duration) * 100);
        expect(status.paymentStatus).toBe('pending');
        expect(status.approvalStatus).toBe('pending');
      }
    }
  });

  it('ignores any client-submitted amount', async () => {
    const { orderId } = await createOrder(
      { placement: 'fullsite', duration: '12', amount: '1', price: '100', total: '0.99' },
      '10.21.0.1',
    );
    const status = await publicStatus(orderId);
    expect(status.amountCents).toBe(priceFor('fullsite', 12) * 100);
  });

  it('never exposes customer data through the public status endpoint', async () => {
    const { orderId } = await createOrder({}, '10.21.0.2');
    const status = await publicStatus(orderId);
    expect(status).not.toHaveProperty('customerName');
    expect(status).not.toHaveProperty('customer_email');
    expect(status).not.toHaveProperty('customerEmail');
    expect(status).not.toHaveProperty('customer_website');
    expect(status).not.toHaveProperty('adCopy');
    expect(status).not.toHaveProperty('creativeR2Key');
    expect(status).toHaveProperty('paymentStatus');
  });

  it('reports unknown orders as 404', async () => {
    const res = await fetch('/api/ads/orders/ORD-DOESNOTEXIST');
    expect(res.status).toBe(404);
  });

  it('rejects invalid placements, durations and contact fields', async () => {
    const bad: Record<string, string>[] = [
      { placement: 'sidebar' },
      { duration: '2' },
      { email: 'not-an-email' },
      { website: 'javascript:alert(1)' },
      { name: 'A' },
    ];
    for (const overrides of bad) {
      const { res } = await createOrder(overrides, '10.21.0.3');
      expect(res.status).toBe(400);
    }
  });

  it('requires acceptance of the advertising terms', async () => {
    const { res } = await createOrder({ terms: 'off' }, '10.21.0.4');
    expect(res.status).toBe(400);
  });

  it('requires copy and a destination URL for text creatives', async () => {
    const { res } = await createOrder({ copy: '', destination_url: '' }, '10.21.0.5');
    expect(res.status).toBe(400);
  });

  it('accepts a valid image creative and stores it in R2 with a unique key', async () => {
    const { res, orderId } = await createOrder({ format: 'image' }, '10.21.0.6', {
      bytes: fixtureBytes('PNG_WIDE'),
      mime: 'image/png',
      name: 'banner.png',
    });
    expect(res.status).toBe(503);

    const row = await testEnv.DB.prepare('SELECT creative_r2_key FROM ads_orders WHERE id = ?')
      .bind(orderId)
      .first<{ creative_r2_key: string }>();
    expect(row?.creative_r2_key).toMatch(new RegExp(`^creatives/${orderId}/[0-9a-f-]+\\.webp$`));
    const object = await testEnv.CREATIVES.get(row!.creative_r2_key);
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object!.arrayBuffer());
    // Optimized output is WebP (RIFF....WEBP), not the source PNG.
    expect([...stored.slice(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect([...stored.slice(8, 12)]).toEqual([0x57, 0x45, 0x42, 0x50]);
  });

  it('rejects image uploads with a forged extension, wrong MIME or missing file', async () => {
    const textBytes = new TextEncoder().encode('<html><body>not an image</body></html>');
    const cases = [
      { bytes: textBytes, mime: 'image/png', name: 'banner.png' }, // magic bytes mismatch
      { bytes: fixtureBytes('PNG_WIDE'), mime: 'image/png', name: 'banner.gif' }, // disallowed extension
      { bytes: fixtureBytes('PNG_WIDE'), mime: 'application/octet-stream', name: 'banner.png' }, // disallowed MIME
      { bytes: fixtureBytes('PNG_WIDE'), mime: 'image/jpeg', name: 'banner.png' }, // MIME/extension mismatch
    ];
    for (const file of cases) {
      const { res, data } = await createOrder({ format: 'image' }, '10.21.0.7', file);
      expect(res.status).toBe(400);
      expect(String(data.error)).toMatch(/image|type|contents/i);
    }
    const { res: noFileRes } = await createOrder({ format: 'image' }, '10.21.0.7');
    expect(noFileRes.status).toBe(400);
  });

  it('rejects an oversized image', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 16);
    oversized.set(fixtureBytes('PNG_SMALL'));
    const { res, data } = await createOrder({ format: 'image' }, '10.21.0.8', {
      bytes: oversized,
      mime: 'image/png',
      name: 'big.png',
    });
    expect(res.status).toBe(400);
    expect(String(data.error)).toMatch(/5 MB/);
  });

  it('requires a valid CSRF token', async () => {
    // csrf: '' sends the request without a token at all.
    const res = await postOrder(orderForm(), { ip: '10.21.0.9', csrf: '' });
    expect(res.status).toBe(403);
    const resBad = await postOrder(orderForm(), { ip: '10.21.0.9', csrf: 'totally.bogus.token' });
    expect(resBad.status).toBe(403);
  });

  it('rate-limits repeated submissions from one IP', async () => {
    const ip = '10.21.0.11';
    for (let i = 0; i < 5; i++) {
      const { res } = await createOrder({}, ip);
      expect(res.status).toBe(503);
    }
    const { res } = await createOrder({}, ip);
    expect(res.status).toBe(429);
  });

  it('exposes a health endpoint without leaking secrets', async () => {
    const res = await fetch('/api/ads/health');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.database).toBe('ok');
    expect(data.storage).toBe('ok');
    expect(data.stripe).toBe(false);
    expect(data.email).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/sk_|whsec_|re_[a-z0-9]{8}|password/i);
  });

  it('issues CSRF tokens for the order form', async () => {
    const res = await fetch('/api/ads/csrf');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; expiresAt: number };
    expect(data.token.split('.').length).toBe(3);
    expect(data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await getCsrf();
  });
});

describe('unknown routes', () => {
  it('serves the branded 404 page with a 404 status', async () => {
    const res = await fetch('/this-page-does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.text();
    // The Astro-generated branded 404 page (dist/404.html), not the Worker's
    // plain-text fallback.
    expect(body).toContain('Page Not Found');
    expect(body).toContain('Back to Home');
    expect(body.trim()).not.toBe('Not Found');
  });

  it('answers 404 for unknown non-navigation requests too', async () => {
    const res = await fetch('/api/ads/no-such-endpoint');
    expect(res.status).toBe(404);
  });
});
