import { randomUUID } from 'node:crypto';
import { conflict, forbidden, ineligible, invalid, notFound, type CheckoutDto, type CreateCheckoutInput } from '@trendora/contracts';
import { canonicalJson, evaluateCoupon, hashCouponCode, participantIneligibility, INELIGIBLE_MESSAGES, priceCart, sha256Hex, windows, type CatalogVariant } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, enqueue, rateLimit } from '../ops';
import { requireActor } from './identity';
import { killSwitches, loadCampaign, times } from './campaign-data';

/**
 * POST /v1/checkouts (spec §8, §12). The server reprices the cart from the
 * current catalog and campaign, reserves inventory with a TTL, holds the coupon,
 * and returns a hosted payment URL. Requires an Idempotency-Key.
 */
export async function createCheckout(ctx: ServiceContext, actor: Actor | null, input: CreateCheckoutInput, idempotencyKey: string | null): Promise<CheckoutDto> {
  const a = requireActor(actor);
  if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw invalid('Idempotency-Key header (8-100 url-safe chars) is required');
  const requestHash = sha256Hex(canonicalJson(input));
  const now = ctx.clock.now();

  const created = await ctx.db.tx(async (q) => {
    const existing = await q.maybeOne<{ id: string; order_id: string; request_hash: string; hosted_url: string | null; expires_at: Date; status: string }>(
      `select id, order_id, request_hash, hosted_url, expires_at, status from checkouts where buyer_id = $1 and idempotency_key = $2`,
      [a.userId, idempotencyKey],
    );
    if (existing) {
      if (existing.request_hash !== requestHash) throw conflict('Idempotency-Key was already used with a different checkout request');
      return { replay: true as const, checkoutId: existing.id, orderId: existing.order_id };
    }
    await rateLimit(q, `checkout:${a.userId}`, 20, 600, now);
    if ((await killSwitches(q)).commerceFrozen) throw forbidden('Checkout is temporarily paused');

    const variantIds = [...new Set(input.items.map((i) => i.variantId))];
    const rows = await q.query<{ id: string; store_id: string; price_minor: number; currency: string; active: boolean }>(
      `select v.id, p.store_id, v.price_minor, v.currency,
              (v.status = 'ACTIVE' and p.status = 'ACTIVE' and p.deleted_at is null and s.status = 'ACTIVE' and o.verification_status = 'VERIFIED') as active
       from variants v join products p on p.id = v.product_id join stores s on s.id = p.store_id join organizations o on o.id = s.org_id
       where v.id = any($1)`,
      [variantIds],
    );
    const catalog = new Map<string, CatalogVariant>(rows.map((r) => [r.id, { id: r.id, storeId: r.store_id, priceMinor: r.price_minor, currency: r.currency, active: r.active }]));

    let campaignCtx: Parameters<typeof priceCart>[2] = null;
    if (input.campaignId) {
      // Lock the campaign row: serializes campaign purchases so the inventory cap holds.
      const c = await loadCampaign(q, input.campaignId, { forUpdate: true });
      const offerOpen = c.status === 'OPEN' && !c.frozen && windows.canPurchaseOffer(times(c), now);
      if (!offerOpen) throw ineligible('This campaign offer is not open');
      const reason = participantIneligibility(a, c.rules, now);
      if (reason) throw ineligible(`${INELIGIBLE_MESSAGES[reason]}. You can still buy at the regular price.`, { reason });
      const offers = await q.query<{ variant_id: string; offer_minor: number; required_qty: number }>(
        `select variant_id, offer_minor, required_qty from campaign_skus where campaign_id = $1`,
        [c.id],
      );
      campaignCtx = { id: c.id, storeId: c.store_id, currency: c.currency, offerOpen, offers: offers.map((o) => ({ variantId: o.variant_id, offerMinor: o.offer_minor, requiredQty: o.required_qty })) };
    }

    const priced = priceCart(input.items, catalog, campaignCtx);

    if (campaignCtx) {
      const campaignUnits = priced.lines.filter((l) => l.campaignId).reduce((s, l) => s + l.qty, 0);
      const used = await q.one<{ n: number }>(
        `select coalesce(sum(oi.qty),0)::int as n from order_items oi join orders o on o.id = oi.order_id
         where oi.campaign_id = $1 and o.status <> 'CANCELED'`,
        [campaignCtx.id],
      );
      const cap = (await loadCampaign(q, campaignCtx.id)).inventory_cap;
      if (used.n + campaignUnits > cap) throw conflict('The campaign offer has sold out');
    }

    // Coupon: lock and evaluate against server prices.
    let coupon: { id: string; discount: number } | null = null;
    if (input.couponCode) {
      const c = await q.maybeOne<{ id: string; store_id: string; percent_off: number; max_discount_minor: number; min_spend_minor: number; currency: string; allowed_variant_ids: string[] | null; excluded_variant_ids: string[]; usage_limit: number; used_count: number; expires_at: Date; status: 'ACTIVE' | 'EXHAUSTED' | 'VOID'; owner_id: string }>(
        `select * from coupons where code_hash = $1 for update`,
        [hashCouponCode(input.couponCode)],
      );
      if (!c) throw ineligible('Coupon code not recognised');
      const pending = await q.one<{ n: number }>(`select count(*)::int as n from coupon_redemptions where coupon_id = $1 and status = 'PENDING'`, [c.id]);
      const discount = evaluateCoupon(
        { storeId: c.store_id, percentOff: c.percent_off, maxDiscountMinor: c.max_discount_minor, minSpendMinor: c.min_spend_minor, currency: c.currency, allowedVariantIds: c.allowed_variant_ids, excludedVariantIds: c.excluded_variant_ids, usageLimit: c.usage_limit, usedCount: c.used_count, pendingCount: pending.n, expiresAt: new Date(c.expires_at), status: c.status, ownerId: c.owner_id },
        { storeId: priced.storeId, buyerId: a.userId, currency: priced.currency, lines: priced.lines, now },
      );
      coupon = { id: c.id, discount };
    }

    const discount = coupon?.discount ?? 0;
    const total = priced.subtotalMinor - discount;
    const expiresAt = new Date(now.getTime() + ctx.config.CHECKOUT_TTL_SECONDS * 1000);
    const checkoutId = randomUUID();
    const sessionRef = `${ctx.payments.name}:${checkoutId}`;

    const order = await q.one<{ id: string }>(
      `insert into orders (buyer_id, store_id, currency, subtotal_minor, discount_minor, total_minor, payment_ref, shipping_address)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [a.userId, priced.storeId, priced.currency, priced.subtotalMinor, discount, total, sessionRef, JSON.stringify(input.shippingAddress)],
    );
    for (const l of priced.lines) {
      await q.query(`insert into order_items (order_id, variant_id, qty, unit_minor, campaign_id) values ($1,$2,$3,$4,$5)`, [order.id, l.variantId, l.qty, l.unitMinor, l.campaignId]);
    }
    await q.query(
      `insert into checkouts (id, order_id, buyer_id, idempotency_key, request_hash, provider, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [checkoutId, order.id, a.userId, idempotencyKey, requestHash, ctx.payments.name, expiresAt],
    );
    // Atomic stock reservation: the conditional update cannot oversell (and the
    // nonnegative check constraint is a second guard). Sorted to avoid deadlocks.
    for (const l of [...priced.lines].sort((x, y) => (x.variantId < y.variantId ? -1 : 1))) {
      const ok = await q.maybeOne(
        `update inventory set available = available - $2, reserved = reserved + $2, version = version + 1, updated_at = now()
         where variant_id = $1 and available >= $2 returning variant_id`,
        [l.variantId, l.qty],
      );
      if (!ok) throw conflict('An item in your cart just sold out', { variantId: l.variantId });
      await q.query(`insert into stock_reservations (variant_id, checkout_id, qty, expires_at) values ($1,$2,$3,$4)`, [l.variantId, checkoutId, l.qty, expiresAt]);
    }
    if (coupon) await q.query(`insert into coupon_redemptions (coupon_id, order_id, discount_minor) values ($1,$2,$3)`, [coupon.id, order.id, coupon.discount]);
    await enqueue(q, 'checkout.expire', { checkoutId }, { dedupeKey: `checkout.expire:${checkoutId}`, delayMs: ctx.config.CHECKOUT_TTL_SECONDS * 1000 + 1000 });
    await audit(q, { actorId: a.userId, action: 'checkout.created', targetType: 'order', targetId: order.id, metadata: { totalMinor: total, campaignId: input.campaignId ?? null } });
    return { replay: false as const, checkoutId, orderId: order.id, total, expiresAt };
  });

  if (!created.replay) {
    // Create the hosted session outside the inventory transaction.
    try {
      const order = await ctx.db.one<{ total_minor: number; currency: string }>(`select total_minor, currency from orders where id = $1`, [created.orderId]);
      const session = await ctx.payments.createCheckoutSession({ checkoutId: created.checkoutId, orderId: created.orderId, amountMinor: order.total_minor, currency: order.currency, expiresAt: created.expiresAt });
      await ctx.db.query(`update checkouts set provider_session_id = $2, hosted_url = $3 where id = $1`, [created.checkoutId, session.sessionId, session.hostedUrl]);
    } catch (e) {
      await expireCheckout(ctx, created.checkoutId, 'PROVIDER_ERROR');
      throw e;
    }
  }
  return checkoutDto(ctx.db, created.checkoutId);
}

export async function checkoutDto(q: Q, checkoutId: string): Promise<CheckoutDto> {
  const r = await q.maybeOne<{ id: string; order_id: string; hosted_url: string | null; expires_at: Date; total_minor: number; discount_minor: number; currency: string }>(
    `select c.id, c.order_id, c.hosted_url, c.expires_at, o.total_minor, o.discount_minor, o.currency from checkouts c join orders o on o.id = c.order_id where c.id = $1`,
    [checkoutId],
  );
  if (!r) throw notFound('Checkout');
  return { checkoutId: r.id, orderId: r.order_id, hostedUrl: r.hosted_url ?? '', expiresAt: new Date(r.expires_at).toISOString(), totalMinor: r.total_minor, discountMinor: r.discount_minor, currency: r.currency };
}

/** Release reservations and the coupon hold for an unpaid checkout. Idempotent. */
export async function expireCheckout(ctx: ServiceContext, checkoutId: string, reason = 'TTL'): Promise<boolean> {
  return ctx.db.tx(async (q) => {
    const c = await q.maybeOne<{ id: string; order_id: string; status: string; expires_at: Date }>(`select id, order_id, status, expires_at from checkouts where id = $1 for update`, [checkoutId]);
    if (!c || c.status !== 'OPEN') return false;
    if (reason === 'TTL' && new Date(c.expires_at) > ctx.clock.now()) return false;
    const order = await q.one<{ status: string }>(`select status from orders where id = $1 for update`, [c.order_id]);
    if (order.status !== 'PENDING') return false;
    await releaseReservations(q, checkoutId);
    await q.query(`update coupon_redemptions set status = 'RELEASED' where order_id = $1 and status = 'PENDING'`, [c.order_id]);
    await q.query(`update checkouts set status = 'EXPIRED' where id = $1`, [checkoutId]);
    await q.query(`update orders set status = 'CANCELED' where id = $1`, [c.order_id]);
    await audit(q, { actorId: null, action: 'checkout.expired', targetType: 'order', targetId: c.order_id, reason });
    return true;
  });
}

export async function releaseReservations(q: Q, checkoutId: string) {
  const res = await q.query<{ id: string; variant_id: string; qty: number }>(
    `select id, variant_id, qty from stock_reservations where checkout_id = $1 and status = 'ACTIVE' order by variant_id for update`,
    [checkoutId],
  );
  for (const r of res) {
    await q.query(`update inventory set available = available + $2, reserved = reserved - $2, version = version + 1, updated_at = now() where variant_id = $1`, [r.variant_id, r.qty]);
    await q.query(`update stock_reservations set status = 'RELEASED' where id = $1`, [r.id]);
  }
}

/** Sweep for checkouts whose TTL passed (backup for the delayed outbox event). */
export async function expireStaleCheckouts(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db.query<{ id: string }>(`select id from checkouts where status = 'OPEN' and expires_at < $1 limit 200`, [ctx.clock.now()]);
  let n = 0;
  for (const r of rows) if (await expireCheckout(ctx, r.id)) n++;
  return n;
}

/** Sandbox hosted-checkout page data (buyer only). */
export async function sandboxCheckoutView(ctx: ServiceContext, actor: Actor | null, checkoutId: string) {
  const a = requireActor(actor);
  const r = await ctx.db.maybeOne<{ id: string; buyer_id: string; status: string; expires_at: Date; order_id: string; total_minor: number; subtotal_minor: number; discount_minor: number; currency: string; store_name: string }>(
    `select c.id, c.buyer_id, c.status, c.expires_at, c.order_id, o.total_minor, o.subtotal_minor, o.discount_minor, o.currency, s.name as store_name
     from checkouts c join orders o on o.id = c.order_id join stores s on s.id = o.store_id where c.id = $1`,
    [checkoutId],
  );
  if (!r || r.buyer_id !== a.userId) throw notFound('Checkout');
  const items = await ctx.db.query<{ title: string; qty: number; unit_minor: number }>(
    `select p.title || ' — ' || v.title as title, oi.qty, oi.unit_minor from order_items oi join variants v on v.id = oi.variant_id join products p on p.id = v.product_id where oi.order_id = $1`,
    [r.order_id],
  );
  return { checkoutId: r.id, orderId: r.order_id, status: r.status, expiresAt: new Date(r.expires_at).toISOString(), storeName: r.store_name, subtotalMinor: r.subtotal_minor, discountMinor: r.discount_minor, totalMinor: r.total_minor, currency: r.currency, items: items.map((i) => ({ title: i.title, qty: i.qty, unitMinor: i.unit_minor })) };
}
