import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout, payments, orders, type SandboxPaymentProvider } from '@trendora/services';
import { createWorld, createMarket, buyAndPay, SHIP, type World, type Market, DAY } from '../support/world';

let w: World;
let m: Market;
beforeAll(async () => {
  w = await createWorld();
  m = await createMarket(w, { stock: 3 });
});
afterAll(async () => w?.drop());

const inv = async (variantId: string) => w.db.one<{ available: number; reserved: number }>(`select available, reserved from inventory where variant_id = $1`, [variantId]);
const provider = () => w.s.payments as SandboxPaymentProvider;

describe('checkout', () => {
  it('reprices on the server and is idempotent per Idempotency-Key', async () => {
    const buyer = await w.user('idem_buyer');
    const body = { campaignId: m.campaignId, items: [{ variantId: m.variantId, qty: 1 }], shippingAddress: SHIP };
    const a = await checkout.createCheckout(w.s, buyer, body, 'idem-key-0001');
    const b = await checkout.createCheckout(w.s, buyer, body, 'idem-key-0001');
    expect(b.checkoutId).toBe(a.checkoutId);
    expect(a.totalMinor).toBe(4900); // campaign offer price, not client supplied
    await expect(checkout.createCheckout(w.s, buyer, { ...body, items: [{ variantId: m.variantId, qty: 2 }] }, 'idem-key-0001')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(checkout.createCheckout(w.s, buyer, body, null)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await checkout.expireCheckout(w.s, a.checkoutId, 'TEST')).toBe(true);
  });

  it('never oversells the last unit under concurrency', async () => {
    const before = await inv(m.variantId);
    const buyers = await Promise.all(Array.from({ length: 6 }, (_, i) => w.user(`race_${i}`)));
    const results = await Promise.allSettled(buyers.map((b, i) => checkout.createCheckout(w.s, b, { campaignId: m.campaignId, items: [{ variantId: m.variantId, qty: 1 }], shippingAddress: SHIP }, `race-key-${i}-xxxx`)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(before.available);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason.code).toBe('CONFLICT');
    const after = await inv(m.variantId);
    expect(after.available).toBe(0);
    expect(after.reserved).toBe(before.available);
    // TTL expiry releases every reservation.
    w.clock.advance(16 * 60_000);
    expect(await checkout.expireStaleCheckouts(w.s)).toBe(before.available);
    expect(await inv(m.variantId)).toEqual({ available: before.available, reserved: 0 });
  });

  it('enforces the campaign inventory cap', async () => {
    const w2 = await createWorld();
    try {
      const m2 = await createMarket(w2, { stock: 50, cap: 2 });
      const b = await w2.user('cap_buyer');
      await checkout.createCheckout(w2.s, b, { campaignId: m2.campaignId, items: [{ variantId: m2.variantId, qty: 2 }], shippingAddress: SHIP }, 'cap-key-00001');
      await expect(checkout.createCheckout(w2.s, b, { campaignId: m2.campaignId, items: [{ variantId: m2.variantId, qty: 1 }], shippingAddress: SHIP }, 'cap-key-00002')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/sold out/) });
      // Regular-price purchase is unaffected by the campaign cap.
      await expect(checkout.createCheckout(w2.s, b, { items: [{ variantId: m2.variantId, qty: 1 }], shippingAddress: SHIP }, 'cap-key-00003')).resolves.toMatchObject({ totalMinor: 9900 });
    } finally {
      await w2.drop();
    }
  });

  it('rejects campaign pricing for ineligible participants', async () => {
    const minor = await w.user('young', { birthYear: 2015 });
    await expect(checkout.createCheckout(w.s, minor, { campaignId: m.campaignId, items: [{ variantId: m.variantId, qty: 1 }], shippingAddress: SHIP }, 'young-key-0001')).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });
});

describe('webhooks', () => {
  it('rejects forged signatures and stale timestamps', async () => {
    const d = provider().buildDelivery({ id: 'evt_forged', type: 'payment.succeeded', data: {} });
    await expect(payments.ingestWebhook(w.s, 'sandbox', d.body.replace('evt_forged', 'evt_forged2'), d.headers)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const stale = provider().buildDelivery({ id: 'evt_old', type: 'payment.succeeded', data: {} }, Math.floor(Date.now() / 1000) - 3600);
    await expect(payments.ingestWebhook(w.s, 'sandbox', stale.body, stale.headers)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(payments.ingestWebhook(w.s, 'stripe', d.body, d.headers)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('persists once, ignores duplicates and replays, and journals exactly once', async () => {
    const buyer = await w.user('dup_buyer');
    const co = await checkout.createCheckout(w.s, buyer, { campaignId: m.campaignId, items: [{ variantId: m.variantId, qty: 1 }], shippingAddress: SHIP }, 'dup-key-00001');
    const session = (await w.db.one<{ s: string }>(`select provider_session_id as s from checkouts where id = $1`, [co.checkoutId])).s;
    const data = { sessionId: session, paymentId: 'pi_dup', amountMinor: 4900, currency: 'USD' };
    const d1 = provider().buildDelivery({ id: 'evt_dup_1', type: 'payment.succeeded', data });
    expect(await payments.ingestWebhook(w.s, 'sandbox', d1.body, d1.headers)).toMatchObject({ duplicate: false });
    expect(await payments.ingestWebhook(w.s, 'sandbox', d1.body, d1.headers)).toMatchObject({ duplicate: true });
    // A different event id for the same payment (provider retry with new id).
    const d2 = provider().buildDelivery({ id: 'evt_dup_2', type: 'payment.succeeded', data });
    await payments.ingestWebhook(w.s, 'sandbox', d2.body, d2.headers);
    await w.drain();
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from payments where external_id = 'pi_dup'`)).n).toBe(1);
    expect((await w.db.one<{ status: string }>(`select status from orders where id = $1`, [co.orderId])).status).toBe('PAID');
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from journals where order_id = $1`, [co.orderId])).n).toBe(1);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from entitlements where user_id = $1`, [buyer.userId])).n).toBe(1);
  });

  it('handles out-of-order refund-before-payment with retries', async () => {
    const buyer = await w.user('ooo_buyer');
    const co = await checkout.createCheckout(w.s, buyer, { items: [{ variantId: m.otherVariantId, qty: 1 }], shippingAddress: SHIP }, 'ooo-key-00001');
    const session = (await w.db.one<{ s: string }>(`select provider_session_id as s from checkouts where id = $1`, [co.checkoutId])).s;
    const refund = provider().buildDelivery({ id: 'evt_ref_first', type: 'refund.succeeded', data: { refundId: 're_ooo', paymentId: 'pi_ooo', amountMinor: 14900 } });
    await payments.ingestWebhook(w.s, 'sandbox', refund.body, refund.headers);
    await w.drain();
    expect((await w.db.one<{ status: string; attempts: number }>(`select status, attempts from outbox where payload->>'webhookEventId' = (select id::text from webhook_events where event_id = 'evt_ref_first')`)).status).toBe('PENDING');
    const pay = provider().buildDelivery({ id: 'evt_pay_late', type: 'payment.succeeded', data: { sessionId: session, paymentId: 'pi_ooo', amountMinor: 14900, currency: 'USD' } });
    await payments.ingestWebhook(w.s, 'sandbox', pay.body, pay.headers);
    await w.drain();
    await w.db.query(`update outbox set available_at = now() where status = 'PENDING' and event_type = 'webhook.process'`);
    await w.drain();
    const o = await w.db.one<{ status: string; financial_status: string }>(`select status, financial_status from orders where id = $1`, [co.orderId]);
    expect(o).toEqual({ status: 'PAID', financial_status: 'REFUNDED' });
  });

  it('refunds a payment captured after the checkout expired when stock is gone', async () => {
    const w3 = await createWorld();
    try {
      const m3 = await createMarket(w3, { stock: 1 });
      const late = await w3.user('late');
      const co = await checkout.createCheckout(w3.s, late, { items: [{ variantId: m3.variantId, qty: 1 }], shippingAddress: SHIP }, 'late-key-00001');
      w3.clock.advance(20 * 60_000);
      await checkout.expireStaleCheckouts(w3.s);
      const other = await w3.user('other');
      await buyAndPay(w3, m3, other, { campaign: false }); // takes the last unit
      const session = (await w3.db.one<{ s: string }>(`select provider_session_id as s from checkouts where id = $1`, [co.checkoutId])).s;
      const d = (w3.s.payments as SandboxPaymentProvider).buildDelivery({ id: 'evt_late', type: 'payment.succeeded', data: { sessionId: session, paymentId: 'pi_late', amountMinor: 9900, currency: 'USD' } });
      await payments.ingestWebhook(w3.s, 'sandbox', d.body, d.headers);
      await w3.drain();
      await new Promise((r) => setTimeout(r, 50));
      await w3.db.query(`update outbox set available_at = now() where status = 'PENDING'`);
      await w3.drain();
      const o = await w3.db.one<{ status: string; financial_status: string }>(`select status, financial_status from orders where id = $1`, [co.orderId]);
      expect(o.status).toBe('CANCELED');
      expect(o.financial_status).toBe('REFUNDED');
      expect((await w3.db.one<{ available: number }>(`select available from inventory where variant_id = $1`, [m3.variantId])).available).toBe(0);
    } finally {
      await w3.drop();
    }
  });
});

describe('ledger & refunds', () => {
  it('keeps journals balanced, immutable and reconciled', async () => {
    const buyer = await w.user('ledger_buyer');
    w.clock.advance(1);
    await w.db.query(`update inventory set available = available + 10 where variant_id = $1`, [m.variantId]);
    const co = await buyAndPay(w, m, buyer);
    await payments.requestRefund(w.s, m.owner, co.orderId, { amountMinor: 1000, reason: 'Partial goodwill' });
    await new Promise((r) => setTimeout(r, 60));
    await w.drain();
    const o = await w.db.one<{ financial_status: string }>(`select financial_status from orders where id = $1`, [co.orderId]);
    expect(o.financial_status).toBe('PARTIALLY_REFUNDED');
    await expect(payments.requestRefund(w.s, m.owner, co.orderId, { amountMinor: 4900, reason: 'Too much' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(payments.requestRefund(w.s, m.staff, co.orderId, { amountMinor: 100, reason: 'staff cannot refund' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const recon = await payments.reconcile(w.s, m.admin);
    expect(recon.ok).toBe(true);
    expect(recon.unbalancedJournals).toBe(0);
    await expect(w.db.query(`update journal_lines set amount_minor = 1`)).rejects.toThrow(/append-only/);
    await expect(w.db.tx(async (q) => {
      const j = await q.one<{ id: string }>(`insert into journals (external_event_id, currency, type) values ('bad', 'USD', 'TEST') returning id`);
      await q.query(`insert into journal_lines (journal_id, account_code, amount_minor) values ($1, 'asset:x', 5), ($1, 'asset:y', -4)`, [j.id]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('merchant fulfilment transitions follow the order state machine', async () => {
    const buyer = await w.user('ship_buyer');
    const co = await buyAndPay(w, m, buyer, { campaign: false, variantId: m.otherVariantId });
    await expect(orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'DELIVERED' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'SHIPPED', carrier: 'UPS', trackingNumber: '1Z' });
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'DELIVERED' });
    const mine = await orders.myOrders(w.s, buyer);
    expect(mine[0]!.status).toBe('DELIVERED');
    void DAY;
  });
});
