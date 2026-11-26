import { conflict, forbidden, invalid, notFound, AppError } from '@trendora/contracts';
import { paymentJournal, refundJournal, disputeJournal, sha256Hex, type JournalDraft } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { SandboxPaymentProvider, type ProviderEvent } from '../adapters/payments';
import { audit, enqueue, notify } from '../ops';
import { releaseReservations } from './checkout';
import { requireActor, requireStorePermission } from './identity';

/** Thrown when an event arrived before the state it depends on; the job runner retries with backoff. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/**
 * POST /v1/webhooks/:provider (spec §12): verify raw-body signature + timestamp,
 * persist once by (provider, event_id), enqueue processing, and only then 2xx.
 */
export async function ingestWebhook(ctx: ServiceContext, provider: string, rawBody: string, headers: Headers | Record<string, string | null>) {
  if (provider !== ctx.payments.name) throw notFound('Webhook endpoint');
  const evt = ctx.payments.verifyWebhook(rawBody, headers, Math.floor(Date.now() / 1000));
  if (!evt) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');
  const result = await ctx.db.tx(async (q) => {
    const row = await q.maybeOne<{ id: string }>(
      `insert into webhook_events (provider, event_id, event_type, payload_hash, payload) values ($1,$2,$3,$4,$5)
       on conflict (provider, event_id) do nothing returning id`,
      [provider, evt.id, evt.type, sha256Hex(rawBody), rawBody],
    );
    if (!row) return { duplicate: true, id: null };
    await enqueue(q, 'webhook.process', { webhookEventId: row.id }, { dedupeKey: `webhook:${row.id}` });
    return { duplicate: false, id: row.id };
  });
  if (!result.duplicate) ctx.kickJobs?.();
  return { received: true, duplicate: result.duplicate };
}

async function writeJournal(q: Q, j: JournalDraft, orderId: string) {
  const row = await q.maybeOne<{ id: string }>(
    `insert into journals (external_event_id, currency, type, memo, order_id) values ($1,$2,$3,$4,$5) on conflict (external_event_id) do nothing returning id`,
    [j.externalEventId, j.currency, j.type, j.memo, orderId],
  );
  if (!row) return; // already journaled (replay)
  for (const l of j.lines) await q.query(`insert into journal_lines (journal_id, account_code, amount_minor) values ($1,$2,$3)`, [row.id, l.accountCode, l.amountMinor]);
}

/** Outbox handler for a persisted webhook event. */
export async function processWebhookEvent(ctx: ServiceContext, webhookEventId: string) {
  await ctx.db.tx(async (q) => {
    const w = await q.maybeOne<{ id: string; status: string; payload: ProviderEvent }>(`select id, status, payload from webhook_events where id = $1 for update`, [webhookEventId]);
    if (!w || w.status === 'PROCESSED' || w.status === 'IGNORED') return;
    const evt = w.payload;
    const outcome = await applyProviderEvent(ctx, q, evt);
    await q.query(`update webhook_events set status = $2, processed_at = now() where id = $1`, [w.id, outcome]);
  });
}

async function applyProviderEvent(ctx: ServiceContext, q: Q, evt: ProviderEvent): Promise<'PROCESSED' | 'IGNORED'> {
  const d = evt.data as Record<string, string | number>;
  switch (evt.type) {
    case 'payment.succeeded':
      return onPaymentSucceeded(ctx, q, evt.id, String(d.sessionId), String(d.paymentId), Number(d.amountMinor), String(d.currency));
    case 'payment.failed':
      return onPaymentFailed(q, String(d.sessionId));
    case 'refund.succeeded':
    case 'refund.failed':
      return onRefund(ctx, q, evt.id, evt.type === 'refund.succeeded', String(d.refundId), String(d.paymentId), Number(d.amountMinor));
    case 'dispute.created':
      return onDispute(ctx, q, evt.id, String(d.disputeId), String(d.paymentId), Number(d.amountMinor));
    default:
      return 'IGNORED';
  }
}

async function onPaymentSucceeded(ctx: ServiceContext, q: Q, eventId: string, sessionId: string, paymentId: string, amountMinor: number, currency: string): Promise<'PROCESSED' | 'IGNORED'> {
  const co = await q.maybeOne<{ id: string; order_id: string; status: string }>(`select id, order_id, status from checkouts where provider_session_id = $1 for update`, [sessionId]);
  if (!co) throw new RetryableError(`checkout for session ${sessionId} not found yet`);
  const order = await q.one<{ id: string; status: string; total_minor: number; currency: string; store_id: string; buyer_id: string }>(
    `select id, status, total_minor, currency, store_id, buyer_id from orders where id = $1 for update`,
    [co.order_id],
  );
  const dup = await q.maybeOne(`select 1 from payments where external_id = $1`, [paymentId]);
  if (dup) return 'IGNORED';
  if (amountMinor !== order.total_minor || currency !== order.currency) {
    await audit(q, { actorId: null, action: 'payment.amount_mismatch', targetType: 'order', targetId: order.id, metadata: { amountMinor, expected: order.total_minor } });
    throw new Error('payment amount mismatch — manual reconciliation required');
  }
  await q.query(`insert into payments (order_id, provider, external_id, status, amount_minor, currency) values ($1,$2,$3,'SUCCEEDED',$4,$5)`, [order.id, ctx.payments.name, paymentId, amountMinor, currency]);
  await writeJournal(q, paymentJournal({ eventId, orderId: order.id, storeId: order.store_id, currency, amountMinor, commissionBps: ctx.config.PLATFORM_COMMISSION_BPS }), order.id);

  if (order.status === 'PENDING' && co.status === 'OPEN') {
    await commitReservations(q, co.id);
  } else {
    // Out-of-order: payment captured after the checkout expired. Try to re-reserve; otherwise refund.
    const ok = await reReserve(q, order.id);
    if (!ok) {
      const { refundExternalId } = await ctx.payments.requestRefund({ paymentExternalId: paymentId, amountMinor, currency, reason: 'STOCK_UNAVAILABLE_AFTER_EXPIRY' });
      const pay = await q.one<{ id: string }>(`select id from payments where external_id = $1`, [paymentId]);
      await q.query(`insert into refunds (payment_id, order_id, external_id, amount_minor, reason) values ($1,$2,$3,$4,'Stock unavailable after checkout expired')`, [pay.id, order.id, refundExternalId, amountMinor]);
      await notify(q, order.buyer_id, 'order.auto_refunded', { orderId: order.id });
      emitSandboxRefund(ctx, refundExternalId, paymentId, amountMinor);
      return 'PROCESSED';
    }
  }
  const redemption = await q.maybeOne<{ coupon_id: string }>(
    `update coupon_redemptions set status = 'REDEEMED' where order_id = $1 and status in ('PENDING','RELEASED') returning coupon_id`,
    [order.id],
  );
  if (redemption) {
    await q.query(
      `update coupons set used_count = used_count + 1, status = case when used_count + 1 >= usage_limit then 'EXHAUSTED' else status end where id = $1`,
      [redemption.coupon_id],
    );
  }
  await q.query(`update checkouts set status = 'COMPLETED' where id = $1`, [co.id]);
  await q.query(`update orders set status = 'PAID', paid_at = now() where id = $1`, [order.id]);
  await enqueue(q, 'order.status_changed', { orderId: order.id, status: 'PAID' }, { dedupeKey: `order:${order.id}:PAID` });
  await notify(q, order.buyer_id, 'order.paid', { orderId: order.id }, `order.paid:${order.id}`);
  return 'PROCESSED';
}

async function commitReservations(q: Q, checkoutId: string) {
  const res = await q.query<{ id: string; variant_id: string; qty: number }>(
    `select id, variant_id, qty from stock_reservations where checkout_id = $1 and status = 'ACTIVE' order by variant_id for update`,
    [checkoutId],
  );
  for (const r of res) {
    await q.query(`update inventory set reserved = reserved - $2, version = version + 1, updated_at = now() where variant_id = $1`, [r.variant_id, r.qty]);
    await q.query(`update stock_reservations set status = 'COMMITTED' where id = $1`, [r.id]);
  }
}

async function reReserve(q: Q, orderId: string): Promise<boolean> {
  const items = await q.query<{ variant_id: string; qty: number }>(`select variant_id, qty from order_items where order_id = $1 order by variant_id`, [orderId]);
  const taken: { variant_id: string; qty: number }[] = [];
  for (const it of items) {
    const ok = await q.maybeOne(`update inventory set available = available - $2, version = version + 1 where variant_id = $1 and available >= $2 returning 1`, [it.variant_id, it.qty]);
    if (!ok) {
      for (const t of taken) await q.query(`update inventory set available = available + $2, version = version + 1 where variant_id = $1`, [t.variant_id, t.qty]);
      return false;
    }
    taken.push(it);
  }
  return true;
}

async function onPaymentFailed(q: Q, sessionId: string): Promise<'PROCESSED' | 'IGNORED'> {
  const co = await q.maybeOne<{ id: string; order_id: string; status: string }>(`select id, order_id, status from checkouts where provider_session_id = $1 for update`, [sessionId]);
  if (!co || co.status !== 'OPEN') return 'IGNORED';
  await releaseReservations(q, co.id);
  await q.query(`update coupon_redemptions set status = 'RELEASED' where order_id = $1 and status = 'PENDING'`, [co.order_id]);
  await q.query(`update checkouts set status = 'EXPIRED' where id = $1`, [co.id]);
  await q.query(`update orders set status = 'CANCELED' where id = $1 and status = 'PENDING'`, [co.order_id]);
  return 'PROCESSED';
}

async function onRefund(ctx: ServiceContext, q: Q, eventId: string, succeeded: boolean, refundId: string, paymentId: string, amountMinor: number): Promise<'PROCESSED' | 'IGNORED'> {
  const pay = await q.maybeOne<{ id: string; order_id: string; amount_minor: number; currency: string }>(`select id, order_id, amount_minor, currency from payments where external_id = $1`, [paymentId]);
  if (!pay) throw new RetryableError(`payment ${paymentId} not recorded yet`);
  const order = await q.one<{ id: string; store_id: string; buyer_id: string }>(`select id, store_id, buyer_id from orders where id = $1 for update`, [pay.order_id]);
  const existing = await q.maybeOne<{ id: string; status: string }>(`select id, status from refunds where external_id = $1 for update`, [refundId]);
  if (existing && existing.status !== 'PENDING') return 'IGNORED';
  if (!existing) {
    await q.query(`insert into refunds (payment_id, order_id, external_id, amount_minor, reason, status) values ($1,$2,$3,$4,'Provider-initiated refund',$5)`, [pay.id, order.id, refundId, amountMinor, succeeded ? 'SUCCEEDED' : 'FAILED']);
  } else {
    await q.query(`update refunds set status = $2 where id = $1`, [existing.id, succeeded ? 'SUCCEEDED' : 'FAILED']);
  }
  if (!succeeded) return 'PROCESSED';
  await writeJournal(q, refundJournal({ eventId, orderId: order.id, storeId: order.store_id, currency: pay.currency, amountMinor, commissionBps: ctx.config.PLATFORM_COMMISSION_BPS }), order.id);
  const refunded = await q.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from refunds where payment_id = $1 and status = 'SUCCEEDED'`, [pay.id]);
  const full = refunded.n >= pay.amount_minor;
  await q.query(`update orders set financial_status = $2 where id = $1 and financial_status <> 'DISPUTED'`, [order.id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED']);
  await enqueue(q, 'order.refunded', { orderId: order.id, full }, { dedupeKey: `order.refunded:${eventId}` });
  await notify(q, order.buyer_id, 'order.refunded', { orderId: order.id, amountMinor });
  return 'PROCESSED';
}

async function onDispute(ctx: ServiceContext, q: Q, eventId: string, disputeId: string, paymentId: string, amountMinor: number): Promise<'PROCESSED' | 'IGNORED'> {
  const pay = await q.maybeOne<{ id: string; order_id: string; currency: string }>(`select id, order_id, currency from payments where external_id = $1`, [paymentId]);
  if (!pay) throw new RetryableError(`payment ${paymentId} not recorded yet`);
  const order = await q.one<{ store_id: string }>(`select store_id from orders where id = $1 for update`, [pay.order_id]);
  const ins = await q.maybeOne(`insert into disputes (payment_id, order_id, external_id, amount_minor) values ($1,$2,$3,$4) on conflict (external_id) do nothing returning id`, [pay.id, pay.order_id, disputeId, amountMinor]);
  if (!ins) return 'IGNORED';
  await writeJournal(q, disputeJournal({ eventId, orderId: pay.order_id, storeId: order.store_id, currency: pay.currency, amountMinor }), pay.order_id);
  await q.query(`update orders set financial_status = 'DISPUTED' where id = $1`, [pay.order_id]);
  await enqueue(q, 'order.refunded', { orderId: pay.order_id, full: true, dispute: true }, { dedupeKey: `order.disputed:${eventId}` });
  return 'PROCESSED';
}

// ---------------------------------------------------------------------------
// Merchant refunds and sandbox provider simulation
// ---------------------------------------------------------------------------

/** Duck-typed (module instances can differ across bundler layers, so avoid instanceof). */
function sandboxProvider(ctx: ServiceContext): SandboxPaymentProvider | null {
  return ctx.payments.isSandbox && 'buildDelivery' in ctx.payments ? (ctx.payments as SandboxPaymentProvider) : null;
}

function emitSandboxRefund(ctx: ServiceContext, refundId: string, paymentId: string, amountMinor: number) {
  const provider = sandboxProvider(ctx);
  if (!provider) return;
  setTimeout(() => {
    const delivery = provider.buildDelivery({ id: `evt_${refundId}`, type: 'refund.succeeded', data: { refundId, paymentId, amountMinor } });
    ingestWebhook(ctx, provider.name, delivery.body, delivery.headers).catch((e) => ctx.log.error('sandbox refund webhook failed', { err: (e as Error).message }));
  }, 10);
}

export async function requestRefund(ctx: ServiceContext, actor: Actor | null, orderId: string, input: { amountMinor: number; reason: string }) {
  const order = await ctx.db.maybeOne<{ id: string; store_id: string; currency: string }>(`select id, store_id, currency from orders where id = $1`, [orderId]);
  if (!order) throw notFound('Order');
  const { actor: a } = await requireStorePermission(ctx.db, actor, order.store_id, 'orders.refund');
  const result = await ctx.db.tx(async (q) => {
    const pay = await q.maybeOne<{ id: string; external_id: string; amount_minor: number }>(`select id, external_id, amount_minor from payments where order_id = $1 and status = 'SUCCEEDED' for update`, [orderId]);
    if (!pay) throw conflict('Order has no captured payment');
    const already = await q.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from refunds where payment_id = $1 and status in ('PENDING','SUCCEEDED')`, [pay.id]);
    if (already.n + input.amountMinor > pay.amount_minor) throw invalid('Refund exceeds the captured amount');
    const { refundExternalId } = await ctx.payments.requestRefund({ paymentExternalId: pay.external_id, amountMinor: input.amountMinor, currency: order.currency, reason: input.reason });
    await q.query(`insert into refunds (payment_id, order_id, external_id, amount_minor, reason, requested_by) values ($1,$2,$3,$4,$5,$6)`, [pay.id, orderId, refundExternalId, input.amountMinor, input.reason, a.userId]);
    await audit(q, { actorId: a.userId, action: 'refund.requested', targetType: 'order', targetId: orderId, reason: input.reason, metadata: { amountMinor: input.amountMinor } });
    return { refundExternalId, paymentExternalId: pay.external_id };
  });
  emitSandboxRefund(ctx, result.refundExternalId, result.paymentExternalId, input.amountMinor);
  return { refundId: result.refundExternalId, status: 'PENDING' };
}

/** SANDBOX hosted checkout: simulates the provider capturing (or failing) payment and sending a signed webhook. */
export async function sandboxPay(ctx: ServiceContext, actor: Actor | null, checkoutId: string, outcome: 'succeeded' | 'failed') {
  const a = requireActor(actor);
  const provider = sandboxProvider(ctx);
  if (!provider || !ctx.config.SANDBOX_MODE) throw forbidden('Sandbox payments are disabled');
  const co = await ctx.db.maybeOne<{ id: string; buyer_id: string; provider_session_id: string | null; status: string; total_minor: number; currency: string }>(
    `select c.id, c.buyer_id, c.provider_session_id, c.status, o.total_minor, o.currency from checkouts c join orders o on o.id = c.order_id where c.id = $1`,
    [checkoutId],
  );
  if (!co || co.buyer_id !== a.userId) throw notFound('Checkout');
  if (co.status !== 'OPEN' || !co.provider_session_id) throw conflict('Checkout is no longer open');
  const delivery = provider.buildDelivery({
    id: `evt_${outcome}_${checkoutId}`,
    type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
    data: { sessionId: co.provider_session_id, paymentId: `sbx_pi_${checkoutId}`, amountMinor: co.total_minor, currency: co.currency },
  });
  return ingestWebhook(ctx, provider.name, delivery.body, delivery.headers);
}

/** Daily provider settlement reconciliation (spec §8 ledger). */
export async function reconcile(ctx: ServiceContext, actor: Actor | null, opts: { system?: boolean } = {}) {
  if (!opts.system) {
    const a = requireActor(actor);
    if (!a.platformRoles.some((r) => r === 'FINANCE' || r === 'ADMIN')) throw forbidden();
  }
  const pay = await ctx.db.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from payments where status = 'SUCCEEDED'`);
  const ref = await ctx.db.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from refunds where status = 'SUCCEEDED'`);
  const disp = await ctx.db.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from disputes where status <> 'WON'`);
  const clearing = await ctx.db.one<{ n: number }>(`select coalesce(sum(amount_minor),0)::bigint as n from journal_lines where account_code = 'asset:provider_clearing'`);
  const commission = await ctx.db.one<{ n: number }>(`select coalesce(-sum(amount_minor),0)::bigint as n from journal_lines where account_code = 'revenue:platform_commission'`);
  const unbalanced = await ctx.db.one<{ n: number }>(`select count(*)::int as n from (select journal_id from journal_lines group by journal_id having sum(amount_minor) <> 0) x`);
  const expected = pay.n - ref.n - disp.n;
  return {
    capturedMinor: pay.n, refundedMinor: ref.n, disputedMinor: disp.n, expectedClearingMinor: expected,
    ledgerClearingMinor: clearing.n, platformCommissionMinor: commission.n, unbalancedJournals: unbalanced.n,
    ok: expected === clearing.n && unbalanced.n === 0,
  };
}
