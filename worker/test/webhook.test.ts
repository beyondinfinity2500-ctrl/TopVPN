import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createOrder,
  fetch,
  postWebhook,
  publicStatus,
  signWebhook,
  testEnv,
  TEST_WEBHOOK_SECRET,
  webhookEvent,
} from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

describe('stripe webhooks', () => {
  it('marks an order paid only after a signature-verified completed checkout', async () => {
    const { orderId } = await createOrder({}, '10.30.0.1');
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');

    const event = webhookEvent('checkout.session.completed', orderId, {
      payment_status: 'paid',
      payment_intent: 'pi_test_abc123',
    });
    const res = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'processed' });

    const status = await publicStatus(orderId);
    expect(status.paymentStatus).toBe('paid');
  });

  it('never auto-approves an ad when a payment lands', async () => {
    const { orderId } = await createOrder({}, '10.30.0.2');
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'paid' }),
    );
    const status = await publicStatus(orderId);
    expect(status.paymentStatus).toBe('paid');
    expect(status.approvalStatus).toBe('pending');
    expect(status.campaignStatus).toBe('pending');
  });

  it('is idempotent: a replayed event is acknowledged but not re-processed', async () => {
    const { orderId } = await createOrder({}, '10.30.0.3');
    const event = webhookEvent('checkout.session.completed', orderId, { payment_status: 'paid' });

    const first = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(await first.json()).toEqual({ status: 'processed' });
    const second = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate' });

    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS c FROM ads_webhook_events WHERE event_id = ?')
      .bind(event.id)
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');
  });

  it('rejects an invalid signature with 401', async () => {
    const { orderId } = await createOrder({}, '10.30.0.4');
    const res = await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'paid' }),
      { signature: 't=123,v1=deadbeef' },
    );
    expect(res.status).toBe(401);
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');
  });

  it('rejects stale signatures (replay protection)', async () => {
    const { orderId } = await createOrder({}, '10.30.0.5');
    const rawBody = JSON.stringify(
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'paid' }),
    );
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = await signWebhook(TEST_WEBHOOK_SECRET, rawBody, old);
    const res = await fetch('/api/ads/webhook', {
      method: 'POST',
      body: rawBody,
      headers: { 'stripe-signature': signature },
    });
    expect(res.status).toBe(401);
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');
  });

  it('records an expired checkout session as expired (not paid)', async () => {
    const { orderId } = await createOrder({}, '10.30.0.6');
    const res = await postWebhook(TEST_WEBHOOK_SECRET, webhookEvent('checkout.session.expired', orderId));
    expect(res.status).toBe(200);
    expect((await publicStatus(orderId)).paymentStatus).toBe('expired');
  });

  it('records failed payments as failed', async () => {
    const { orderId } = await createOrder({}, '10.30.0.7');
    const res = await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.async_payment_failed', orderId),
    );
    expect(res.status).toBe(200);
    expect((await publicStatus(orderId)).paymentStatus).toBe('failed');
  });

  it('does not let a failed event overwrite a verified payment', async () => {
    const { orderId } = await createOrder({}, '10.30.0.8');
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'paid' }),
    );
    await postWebhook(TEST_WEBHOOK_SECRET, webhookEvent('payment_intent.payment_failed', orderId));
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');
  });

  it('keeps a completed-but-unpaid session pending while an async payment is in flight', async () => {
    const { orderId } = await createOrder({}, '10.30.0.9');
    const res = await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'unpaid' }),
    );
    expect(res.status).toBe(200);
    const status = await publicStatus(orderId);
    expect(status.paymentStatus).toBe('pending');
    expect(status.approvalStatus).toBe('pending');
  });

  it('marks an order paid on async_payment_succeeded after an unpaid completion', async () => {
    const { orderId } = await createOrder({}, '10.30.0.10');
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'unpaid' }),
    );
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');

    const res = await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.async_payment_succeeded', orderId, {
        payment_status: 'paid',
        payment_intent: 'pi_async_success',
      }),
    );
    expect(res.status).toBe(200);
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');
  });

  it('marks an order failed on async_payment_failed after an unpaid completion', async () => {
    const { orderId } = await createOrder({}, '10.30.0.11');
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.completed', orderId, { payment_status: 'unpaid' }),
    );
    expect((await publicStatus(orderId)).paymentStatus).toBe('pending');

    const res = await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.async_payment_failed', orderId),
    );
    expect(res.status).toBe(200);
    expect((await publicStatus(orderId)).paymentStatus).toBe('failed');
  });

  it('does not let a late failure event overwrite an async-verified payment', async () => {
    const { orderId } = await createOrder({}, '10.30.0.12');
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.async_payment_succeeded', orderId, {
        payment_status: 'paid',
        payment_intent: 'pi_async_late',
      }),
    );
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');

    await postWebhook(TEST_WEBHOOK_SECRET, webhookEvent('payment_intent.payment_failed', orderId));
    await postWebhook(
      TEST_WEBHOOK_SECRET,
      webhookEvent('checkout.session.async_payment_failed', orderId),
    );
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');
  });

  it('treats a duplicate async_payment_succeeded as a harmless no-op', async () => {
    const { orderId } = await createOrder({}, '10.30.0.13');
    const event = webhookEvent('checkout.session.async_payment_succeeded', orderId, {
      payment_status: 'paid',
      payment_intent: 'pi_async_duplicate',
    });
    const first = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(await first.json()).toEqual({ status: 'processed' });
    const second = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate' });
    expect((await publicStatus(orderId)).paymentStatus).toBe('paid');
  });

  it('ignores events for unknown orders but still logs them', async () => {
    const event = webhookEvent('checkout.session.completed', 'ORD-NOSUCHORDER', { payment_status: 'paid' });
    const res = await postWebhook(TEST_WEBHOOK_SECRET, event);
    expect(res.status).toBe(200);
    expect((await publicStatus('ORD-NOSUCHORDER')).paymentStatus).toBeUndefined();
  });
});
