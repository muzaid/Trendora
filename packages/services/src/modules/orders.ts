import { conflict, notFound, type OrderDto, type OrderStatus } from '@trendora/contracts';
import { orderMachine, participantIneligibility, reachedMilestone, INELIGIBLE_MESSAGES } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, enqueue, iso, notify } from '../ops';
import { requireActor, requireStoreMember, requireStorePermission, loadActor } from './identity';
import { loadCampaign } from './campaign-data';

type OrderRow = { id: string; store_id: string; store_name: string; status: OrderStatus; financial_status: OrderDto['financialStatus']; currency: string; subtotal_minor: number; discount_minor: number; total_minor: number; created_at: Date; paid_at: Date | null; shipped_at: Date | null; delivered_at: Date | null; tracking: unknown; buyer_handle?: string };

async function hydrate(q: Q, rows: OrderRow[]): Promise<(OrderDto & { buyerHandle?: string })[]> {
  const items = rows.length
    ? await q.query<{ id: string; order_id: string; variant_id: string; title: string; qty: number; unit_minor: number; campaign_id: string | null }>(
        `select oi.id, oi.order_id, oi.variant_id, p.title || ' — ' || v.title as title, oi.qty, oi.unit_minor, oi.campaign_id
         from order_items oi join variants v on v.id = oi.variant_id join products p on p.id = v.product_id where oi.order_id = any($1)`,
        [rows.map((r) => r.id)],
      )
    : [];
  return rows.map((r) => ({
    id: r.id, storeId: r.store_id, storeName: r.store_name, status: r.status, financialStatus: r.financial_status, currency: r.currency,
    subtotalMinor: r.subtotal_minor, discountMinor: r.discount_minor, totalMinor: r.total_minor, createdAt: iso(r.created_at)!,
    paidAt: iso(r.paid_at), shippedAt: iso(r.shipped_at), deliveredAt: iso(r.delivered_at), tracking: r.tracking,
    ...(r.buyer_handle ? { buyerHandle: r.buyer_handle } : {}),
    items: items.filter((i) => i.order_id === r.id).map((i) => ({ id: i.id, variantId: i.variant_id, title: i.title, qty: i.qty, unitMinor: i.unit_minor, campaignId: i.campaign_id })),
  }));
}

export async function myOrders(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  const rows = await ctx.db.query<OrderRow>(
    `select o.*, s.name as store_name from orders o join stores s on s.id = o.store_id where o.buyer_id = $1 and o.status <> 'CANCELED' order by o.created_at desc limit 50`,
    [a.userId],
  );
  return hydrate(ctx.db, rows);
}

export async function merchantOrders(ctx: ServiceContext, actor: Actor | null, storeId: string, status?: string) {
  await requireStoreMember(ctx.db, actor, storeId);
  const rows = await ctx.db.query<OrderRow>(
    `select o.*, s.name as store_name, p.handle as buyer_handle from orders o join stores s on s.id = o.store_id join profiles p on p.id = o.buyer_id
     where o.store_id = $1 and o.status <> 'PENDING' and ($2::text is null or o.status = $2) order by o.created_at desc limit 100`,
    [storeId, status ?? null],
  );
  return hydrate(ctx.db, rows);
}

/** Merchant fulfilment transitions (FULFILLING → SHIPPED → DELIVERED). */
export async function transitionOrder(ctx: ServiceContext, actor: Actor | null, orderId: string, input: { to: 'FULFILLING' | 'SHIPPED' | 'DELIVERED'; carrier?: string; trackingNumber?: string }) {
  const o = await ctx.db.maybeOne<{ store_id: string }>(`select store_id from orders where id = $1`, [orderId]);
  if (!o) throw notFound('Order');
  const { actor: a } = await requireStorePermission(ctx.db, actor, o.store_id, 'orders.manage');
  await ctx.db.tx(async (q) => {
    const cur = await q.one<{ status: OrderStatus; buyer_id: string; financial_status: string }>(`select status, buyer_id, financial_status from orders where id = $1 for update`, [orderId]);
    orderMachine.assert(cur.status, input.to);
    if (cur.financial_status === 'REFUNDED') throw conflict('Order was refunded');
    const tracking = input.to === 'SHIPPED' ? JSON.stringify({ carrier: input.carrier ?? 'unspecified', trackingNumber: input.trackingNumber ?? '' }) : null;
    await q.query(
      `update orders set status = $2,
         shipped_at = case when $2 = 'SHIPPED' then now() else shipped_at end,
         delivered_at = case when $2 = 'DELIVERED' then now() else delivered_at end,
         tracking = coalesce($3::jsonb, tracking) where id = $1`,
      [orderId, input.to, tracking],
    );
    await enqueue(q, 'order.status_changed', { orderId, status: input.to }, { dedupeKey: `order:${orderId}:${input.to}` });
    await notify(q, cur.buyer_id, `order.${input.to.toLowerCase()}`, { orderId });
    await audit(q, { actorId: a.userId, action: 'order.transition', targetType: 'order', targetId: orderId, metadata: { to: input.to } });
  });
  ctx.kickJobs?.();
  return { ok: true };
}

/**
 * Entitlement creation (spec §6): only after a verified paid order reaches the
 * campaign's configured milestone. Unique per (campaign, qualifying order line).
 */
export async function grantEntitlementsForOrder(ctx: ServiceContext, orderId: string) {
  await ctx.db.tx(async (q) => {
    const order = await q.maybeOne<{ id: string; buyer_id: string; status: OrderStatus; financial_status: string }>(`select id, buyer_id, status, financial_status from orders where id = $1 for update`, [orderId]);
    if (!order || order.financial_status !== 'NONE') return;
    const lines = await q.query<{ id: string; campaign_id: string; variant_id: string; qty: number }>(
      `select id, campaign_id, variant_id, qty from order_items where order_id = $1 and campaign_id is not null`,
      [orderId],
    );
    const buyer = await loadActor(q, order.buyer_id);
    if (!buyer) return;
    for (const line of lines) {
      const c = await loadCampaign(q, line.campaign_id, { forUpdate: true });
      if (!reachedMilestone(order.status, c.rules.eligibility.entitlementMilestone)) continue;
      const sku = await q.maybeOne<{ required_qty: number }>(`select required_qty from campaign_skus where campaign_id = $1 and variant_id = $2`, [c.id, line.variant_id]);
      if (!sku || line.qty < sku.required_qty) continue;
      const now = ctx.clock.now();
      if (['CANCELED', 'FINALIZED', 'FULFILLED', 'REVIEWING', 'VOTING_CLOSED'].includes(c.status) || now >= new Date(c.submission_end)) {
        await notify(q, order.buyer_id, 'entitlement.missed_deadline', { campaignId: c.id, orderId }, `ent-missed:${line.id}`);
        continue;
      }
      const reason = participantIneligibility(buyer, c.rules, now);
      if (reason) {
        await notify(q, order.buyer_id, 'entitlement.ineligible', { campaignId: c.id, message: INELIGIBLE_MESSAGES[reason] }, `ent-inel:${line.id}`);
        continue;
      }
      const count = await q.one<{ n: number }>(`select count(*)::int as n from entitlements where campaign_id = $1 and user_id = $2 and status <> 'REVOKED'`, [c.id, order.buyer_id]);
      if (count.n >= c.rules.eligibility.maxEntriesPerUser) continue;
      const ent = await q.maybeOne<{ id: string }>(
        `insert into entitlements (campaign_id, user_id, order_item_id, source) values ($1,$2,$3,'PURCHASE')
         on conflict (campaign_id, order_item_id) where order_item_id is not null do nothing returning id`,
        [c.id, order.buyer_id, line.id],
      );
      if (ent) {
        await notify(q, order.buyer_id, 'entitlement.granted', { campaignId: c.id, campaignTitle: c.title, entitlementId: ent.id }, `ent:${ent.id}`);
        await audit(q, { actorId: null, action: 'entitlement.granted', targetType: 'entitlement', targetId: ent.id, metadata: { orderItemId: line.id } });
      }
    }
  });
}

/**
 * Refunds/chargebacks trigger eligibility review under published rules — never
 * silent revocation (spec §6 edge cases).
 */
export async function reviewEligibilityAfterRefund(ctx: ServiceContext, orderId: string) {
  await ctx.db.tx(async (q) => {
    const ents = await q.query<{ id: string; campaign_id: string; user_id: string; status: string }>(
      `select e.id, e.campaign_id, e.user_id, e.status from entitlements e join order_items oi on oi.id = e.order_item_id where oi.order_id = $1 for update of e`,
      [orderId],
    );
    for (const e of ents) {
      if (e.status === 'REVOKED' || e.status === 'UNDER_REVIEW') continue;
      await q.query(`update entitlements set status = 'UNDER_REVIEW', status_reason = 'Order refunded or disputed' where id = $1`, [e.id]);
      const entry = await q.maybeOne<{ id: string }>(`select id from entries where entitlement_id = $1`, [e.id]);
      if (entry) {
        await q.query(`update rewards set status = 'UNDER_REVIEW' where entry_id = $1 and status in ('ISSUED','CLAIMED')`, [entry.id]);
      }
      await q.query(
        `insert into fraud_flags (campaign_id, entry_id, actor_id, kind, source, evidence, confidence, dedupe_key)
         values ($1,$2,$3,'REFUND_ELIGIBILITY_REVIEW','RULE',$4,1,$5) on conflict (dedupe_key) do nothing`,
        [e.campaign_id, entry?.id ?? null, e.user_id, JSON.stringify({ orderId }), `refund-review:${e.id}`],
      );
      await notify(q, e.user_id, 'entitlement.under_review', { campaignId: e.campaign_id });
    }
  });
}
