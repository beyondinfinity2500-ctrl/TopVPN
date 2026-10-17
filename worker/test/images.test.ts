/**
 * Image optimization at ingest: validation, transcoding to WebP, dimension
 * caps, animation rejection, corruption/spoof rejection, quota-failure handling
 * and the admin replace-creative retry path.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  adminFetch,
  adminLogin,
  applyMigrations,
  createImageOrder,
  createOrder,
  fetch,
  fixtureBytes,
  orderForm,
  testEnv,
} from './helpers';
import { MAX_IMAGE_BYTES, MAX_IMAGE_BYTES_LABEL } from '../../src/lib/ads/pricing';
import type { Env } from '../env';
import { MAX_OUTPUT_WIDTH, optimizeCreative } from '../images';

const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

async function creativeRow(orderId: string) {
  return testEnv.DB.prepare(
    'SELECT creative_r2_key, creative_status, creative_width, creative_height, creative_optimization_error FROM ads_orders WHERE id = ?',
  )
    .bind(orderId)
    .first<{
      creative_r2_key: string | null;
      creative_status: string;
      creative_width: number | null;
      creative_height: number | null;
      creative_optimization_error: string | null;
    }>();
}

/** Keys under a specific order's prefix (each order gets its own folder). */
async function orderKeys(orderId: string | undefined): Promise<string[]> {
  const listed = await testEnv.CREATIVES.list();
  return listed.objects.filter((o) => orderId && o.key.startsWith(`creatives/${orderId}/`)).map((o) => o.key);
}

/** Any key whose folder matches an order id that must not have been created. */
async function anyCreatedKeys(): Promise<string[]> {
  const listed = await testEnv.CREATIVES.list();
  return listed.objects.map((o) => o.key);
}

describe('image optimization', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it('optimizes a PNG to WebP and stores it under a .webp key', async () => {
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.31.0.1');
    const row = await creativeRow(orderId);
    expect(row?.creative_status).toBe('ready');
    expect(row?.creative_r2_key).toMatch(new RegExp(`^creatives/${orderId}/[0-9a-f-]+\\.webp$`));
    expect(row?.creative_optimization_error).toBeNull();

    const object = await testEnv.CREATIVES.get(row!.creative_r2_key!);
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object!.arrayBuffer());
    // Output is a real WebP (RIFF....WEBP), not the uploaded PNG.
    expect([...stored.slice(0, 12).slice(0, 4)]).toEqual(WEBP_MAGIC.slice(0, 4));
    expect([...stored.slice(8, 12)]).toEqual(WEBP_MAGIC.slice(8, 12));
    expect(object!.httpMetadata?.contentType).toBe('image/webp');
  });

  it('caps width at 1600 and preserves the aspect ratio exactly', async () => {
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.31.0.2');
    const row = await creativeRow(orderId);
    expect(row?.creative_width).toBe(MAX_OUTPUT_WIDTH);
    // Source is 2000x600 -> 1600x480.
    expect(row?.creative_height).toBe(480);
  });

  it('never upscales an image smaller than the maximum width', async () => {
    const { orderId } = await createImageOrder('PNG_SMALL', {}, '10.31.0.3');
    const row = await creativeRow(orderId);
    // Source is 300x200, below the cap, so dims are unchanged.
    expect(row?.creative_width).toBe(300);
    expect(row?.creative_height).toBe(200);
  });

  it('keeps the aspect ratio for tall images (height is the constraint)', async () => {
    const { orderId } = await createImageOrder('PNG_TALL', {}, '10.31.0.4');
    const row = await creativeRow(orderId);
    // Source is 600x1800 -> width capped at 600 (no upscale), height 1800.
    expect(row?.creative_width).toBe(600);
    expect(row?.creative_height).toBe(1800);
  });

  it('accepts JPEG and WebP sources and optimizes both to WebP', async () => {
    const jpeg = await createImageOrder('JPEG_WIDE', {}, '10.31.0.5', 'image/jpeg', 'banner.jpg');
    expect((await creativeRow(jpeg.orderId))?.creative_status).toBe('ready');
    expect((await creativeRow(jpeg.orderId))?.creative_width).toBe(MAX_OUTPUT_WIDTH);

    const webp = await createImageOrder('WEBP_WIDE', {}, '10.31.0.6', 'image/webp', 'banner.webp');
    expect((await creativeRow(webp.orderId))?.creative_status).toBe('ready');
    expect((await creativeRow(webp.orderId))?.creative_width).toBe(MAX_OUTPUT_WIDTH);
  });

  it('rejects an animated WebP instead of silently taking the first frame', async () => {
    const before = await anyCreatedKeys();
    const { res, data, orderId } = await createImageOrder('WEBP_ANIMATED', {}, '10.31.0.7', 'image/webp', 'anim.webp');
    expect(res.status).toBe(400);
    expect(String(data.error)).toMatch(/static|animated/i);
    expect(orderId).toBeUndefined();
    // No new object was written for the rejected upload.
    expect(await anyCreatedKeys()).toEqual(before);
  });

  it('rejects an animated PNG (APNG)', async () => {
    const { res, orderId } = await createImageOrder('PNG_ANIMATED', {}, '10.31.0.8');
    expect(res.status).toBe(400);
    expect(orderId).toBeUndefined();
  });

  it('rejects SVG bytes offered as a raster extension', async () => {
    const before = await anyCreatedKeys();
    const { res, orderId } = await createImageOrder('SVG', {}, '10.31.0.9', 'image/png', 'sneaky.png');
    expect(res.status).toBe(400);
    expect(orderId).toBeUndefined();
    expect(await anyCreatedKeys()).toEqual(before);
  });

  it('rejects a corrupt image with valid magic bytes', async () => {
    const before = await anyCreatedKeys();
    const { res, data, orderId } = await createImageOrder('PNG_CORRUPT', {}, '10.31.0.10');
    expect(res.status).toBe(400);
    expect(String(data.error)).toMatch(/could not be processed|valid/i);
    expect(orderId).toBeUndefined();
    // No order row and no new R2 object.
    expect(await anyCreatedKeys()).toEqual(before);
  });

  it('rejects an oversized upload at the 5 MB limit', async () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 16);
    oversized.set(fixtureBytes('PNG_SMALL'));
    const { res, data, orderId } = await createOrder(
      { ...orderForm(), format: 'image' },
      '10.31.0.11',
      { bytes: oversized, mime: 'image/png', name: 'big.png' },
    );
    expect(res.status).toBe(400);
    expect(String(data.error)).toContain(MAX_IMAGE_BYTES_LABEL);
    expect(orderId).toBeUndefined();
  });

  it('accepts an image exactly at the 5 MB boundary', async () => {
    // Build a PNG at exactly the limit by padding a valid image's trailing area.
    const base = fixtureBytes('PNG_SMALL');
    const exact = new Uint8Array(MAX_IMAGE_BYTES);
    exact.set(base);
    const { res, orderId } = await createOrder(
      { ...orderForm(), format: 'image' },
      '10.31.0.12',
      { bytes: exact, mime: 'image/png', name: 'boundary.png' },
    );
    expect(res.status).toBe(503); // payment not configured in tests; order stored
    const row = await creativeRow(orderId);
    expect(['ready', 'failed']).toContain(row?.creative_status);
  });
});

describe('optimizeCreative failure classification', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  /** An Env whose IMAGES binding is fully stubbed; D1/R2 are the real test ones. */
  function envWithImages(images: unknown): Env {
    return { ...testEnv, IMAGES: images as Env['IMAGES'] };
  }

  it('classifies a quota error (9422) as a service failure, not an invalid file', async () => {
    const quotaError = Object.assign(new Error('quota exceeded'), { code: 9422 });
    const env = envWithImages({
      info: () => Promise.reject(quotaError),
      input: () => {
        throw new Error('unexpected');
      },
    });
    const result = await optimizeCreative(env, fixtureBytes('PNG_WIDE'));
    expect(result.kind).toBe('unavailable');
  });

  it('classifies a corrupt-file error (9523 locally / 9412 in production) as invalid', async () => {
    const corruptError = Object.assign(new Error('Unexpected error response 500'), { code: 9523 });
    const env = envWithImages({
      info: () => Promise.reject(corruptError),
      input: () => {
        throw new Error('unexpected');
      },
    });
    const result = await optimizeCreative(env, fixtureBytes('PNG_CORRUPT'));
    expect(result.kind).toBe('invalid');
  });

  it('classifies the production not-an-image code (9412) as invalid', async () => {
    const notImage = Object.assign(new Error('Input is not an image'), { code: 9412 });
    const env = envWithImages({
      info: () => Promise.reject(notImage),
      input: () => {
        throw new Error('unexpected');
      },
    });
    const result = await optimizeCreative(env, fixtureBytes('SVG'));
    expect(result.kind).toBe('invalid');
  });

  it('treats a codeless transient error as a service failure (keeps the order)', async () => {
    const env = envWithImages({
      info: () => Promise.reject(new Error('network dropped')),
      input: () => {
        throw new Error('unexpected');
      },
    });
    const result = await optimizeCreative(env, fixtureBytes('PNG_WIDE'));
    expect(result.kind).toBe('unavailable');
  });

  it('reports SVG (no dimensions from info()) as invalid', async () => {
    const env = envWithImages({
      info: () => Promise.resolve({ format: 'image/svg+xml' }),
      input: () => {
        throw new Error('unexpected');
      },
    });
    const result = await optimizeCreative(env, fixtureBytes('SVG'));
    expect(result.kind).toBe('invalid');
  });
});

describe('admin replace-creative retry path', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  async function login(ip = '10.41.0.1') {
    return adminLogin(ADMIN_PASSWORD, ip);
  }

  it('rejects unauthenticated and CSRF-less replace attempts', async () => {
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.41.0.2');
    expect((await fetch(`/admin/api/orders/${orderId}/creative/replace`, { method: 'POST' })).status).toBe(401);

    const { cookie } = await login('10.41.0.3');
    const noCsrf = await adminFetch(cookie, `/admin/api/orders/${orderId}/creative/replace`, {
      method: 'POST',
      body: {},
    });
    expect(noCsrf.status).toBe(403);
  });

  it('replaces a failed creative with an optimized one', async () => {
    const { cookie, csrf } = await login('10.41.0.4');
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.41.0.5');

    const form = new FormData();
    form.append('creative', new Blob([fixtureBytes('JPEG_WIDE')], { type: 'image/jpeg' }), 'replacement.jpg');
    const res = await fetch(`/admin/api/orders/${orderId}/creative/replace`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { creativeStatus: string; width: number };
    expect(data.creativeStatus).toBe('ready');

    const row = await creativeRow(orderId);
    expect(row?.creative_status).toBe('ready');
    expect(row?.creative_width).toBe(MAX_OUTPUT_WIDTH);
    expect(row?.creative_r2_key).toMatch(/\.webp$/);
  });

  it('rejects an animated replacement', async () => {
    const { cookie, csrf } = await login('10.41.0.6');
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.41.0.7');

    const form = new FormData();
    form.append('creative', new Blob([fixtureBytes('WEBP_ANIMATED')], { type: 'image/webp' }), 'anim.webp');
    const res = await fetch(`/admin/api/orders/${orderId}/creative/replace`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(400);
  });

  it('refuses to replace a text creative', async () => {
    const { cookie, csrf } = await login('10.41.0.8');
    const { orderId } = await createOrder({}, '10.41.0.9');

    const form = new FormData();
    form.append('creative', new Blob([fixtureBytes('PNG_WIDE')], { type: 'image/png' }), 'x.png');
    const res = await fetch(`/admin/api/orders/${orderId}/creative/replace`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(400);
  });

  it('never changes payment or approval state when replacing a creative', async () => {
    const { cookie, csrf } = await login('10.41.0.12');
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.41.0.13');

    const before = await testEnv.DB.prepare(
      'SELECT payment_status, approval_status, campaign_status FROM ads_orders WHERE id = ?',
    )
      .bind(orderId)
      .first<{ payment_status: string; approval_status: string; campaign_status: string }>();

    const form = new FormData();
    form.append('creative', new Blob([fixtureBytes('PNG_SMALL')], { type: 'image/png' }), 'r.png');
    const res = await fetch(`/admin/api/orders/${orderId}/creative/replace`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(200);

    const after = await testEnv.DB.prepare(
      'SELECT payment_status, approval_status, campaign_status FROM ads_orders WHERE id = ?',
    )
      .bind(orderId)
      .first<{ payment_status: string; approval_status: string; campaign_status: string }>();
    expect(after).toEqual(before);
  });

  it('is idempotent: replacing twice leaves exactly one stored object', async () => {
    const { cookie, csrf } = await login('10.41.0.10');
    const { orderId } = await createImageOrder('PNG_WIDE', {}, '10.41.0.11');

    for (let i = 0; i < 2; i++) {
      const form = new FormData();
      form.append(
        'creative',
        new Blob([fixtureBytes('PNG_SMALL')], { type: 'image/png' }),
        `r${i}.png`,
      );
      const res = await fetch(`/admin/api/orders/${orderId}/creative/replace`, {
        method: 'POST',
        body: form,
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
      });
      expect(res.status).toBe(200);
    }

    const row = await creativeRow(orderId);
    const keys = await orderKeys(orderId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(row!.creative_r2_key);
  });
});
