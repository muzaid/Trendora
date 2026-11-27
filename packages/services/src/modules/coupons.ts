import { conflict, forbidden, notFound, unauthenticated, type DirectRedeemInput } from '@trendora/contracts';
import { evaluateDirectRedemption, hashCouponCode, randomToken, sha256Hex } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, iso, notify, rateLimit } from '../ops';
import { requireStoreMember, requireStorePermission } from './identity';

/**
 * Direct coupon redemption: a shopper uses a TRENDORA reward coupon when buying
 * from the business itself (physical store, the merchant's own website or POS).
 * Store staff redeem from the merchant console; the merchant's own systems use a
 * store API key. The server computes the discount and consumes the coupon
 * atomically — the business never decides the discount client-side.
 */

export const STORE_KEY_PREFIX = 'trk_';

export type Redeemer =
  | { kind: 'staff'; actor: Actor; storeId: string }
  | { kind: 'key'; keyId: string; storeId: string };

/** Resolve who is redeeming: a store API key (Bearer trk_…) or a signed-in staff member with coupons.redeem. */
export async function resolveRedeemer(ctx: ServiceContext, actor: Actor | null, bearer: string | null, storeId: string): Promise<Redeemer> {
  if (bearer?.startsWith(STORE_KEY_PREFIX)) {
    const key = await ctx.db.maybeOne<{ id: string; store_id: string; revoked_at: Date | null; scopes: string[] }>(
      `select id, store_id, revoked_at, scopes from store_api_keys where key_hash = $1`,
      [sha256Hex(bearer)],
    );
    if (!key || key.revoked_at) throw unauthenticated('Invalid or revoked store API key');
    if (key.store_id !== storeId) throw forbidden('This API key belongs to a different store');
    if (!key.scopes.includes('coupons:redeem')) throw forbidden('API key lacks the coupons:redeem scope');
    await ctx.db.query(`update store_api_keys set last_used_at = now() where id = $1`, [key.id]);
    return { kind: 'key', keyId: key.id, storeId };
  }
  const { actor: a } = await requireStorePermission(ctx.db, actor, storeId, 'coupons.redeem');
  return { kind: 'staff', actor: a, storeId };
}

const principalKey = (r: Redeemer) => (r.kind === 'key' ? `key:${r.keyId}` : `user:${r.actor.userId}`);

type CouponRow = {
  id: string; reward_id: string; owner_id: string; store_id: string; percent_off: number; max_discount_minor: number; min_spend_minor: number;
  currency: string; allowed_variant_ids: string[] | null; excluded_variant_ids: string[]; usage_limit: number; used_count: number;
  expires_at: Date; status: 'ACTIVE' | 'EXHAUSTED' | 'VOID'; terms: { exclusions?: string }; code_last4: string;
};

async function couponByCode(q: Q, code: string, forUpdate = false) {
  return q.maybeOne<CouponRow>(`select * from coupons where code_hash = $1 ${forUpdate ? 'for update' : ''}`, [hashCouponCode(code)]);
}

async function pendingHolds(q: Q, couponId: string) {
  return (await q.one<{ n: number }>(`select count(*)::int as n from coupon_redemptions where coupon_id = $1 and status = 'PENDING'`, [couponId])).n;
}

const terms = (c: CouponRow, pending: number) => ({
  storeId: c.store_id, percentOff: c.percent_off, maxDiscountMinor: c.max_discount_minor, minSpendMinor: c.min_spend_minor, currency: c.currency,
  allowedVariantIds: c.allowed_variant_ids, excludedVariantIds: c.excluded_variant_ids, usageLimit: c.usage_limit, usedCount: c.used_count,
  pendingCount: pending, expiresAt: new Date(c.expires_at), status: c.status,
});

/**
 * Check a code before ringing up the sale. Returns the coupon terms and, when a
 * purchase amount is given, the discount the server would apply.
 */
export async function lookupCoupon(ctx: ServiceContext, r: Redeemer, input: { code: string; purchaseMinor?: number; eligibleMinor?: number }) {
  await rateLimit(ctx.db, `coupon-lookup:${principalKey(r)}`, 60, 60, ctx.clock.now());
  const c = await couponByCode(ctx.db, input.code);
  // Codes from other stores are reported exactly like unknown codes (no cross-store disclosure).
  if (!c || c.store_id !== r.storeId) throw notFound('Coupon');
  const pending = await pendingHolds(ctx.db, c.id);
  const store = await ctx.db.one<{ currency: string }>(`select currency from stores where id = $1`, [r.storeId]);
  const info = await ctx.db.one<{ campaign_title: string; handle: string }>(
    `select ca.title as campaign_title, p.handle from rewards rw join campaigns ca on ca.id = rw.campaign_id join profiles p on p.id = rw.user_id where rw.id = $1`,
    [c.reward_id],
  );
  let valid = true;
  let reason: string | null = null;
  let discountMinor: number | null = null;
  try {
    const purchase = input.purchaseMinor ?? Math.max(c.min_spend_minor, 1);
    const d = evaluateDirectRedemption(terms(c, pending), { storeId: r.storeId, currency: store.currency, purchaseMinor: purchase, eligibleMinor: input.eligibleMinor ?? purchase, now: ctx.clock.now() });
    if (input.purchaseMinor !== undefined) discountMinor = d;
  } catch (e) {
    valid = false;
    reason = (e as Error).message;
  }
  return {
    valid, reason, discountMinor,
    coupon: {
      codeLast4: c.code_last4, percentOff: c.percent_off, maxDiscountMinor: c.max_discount_minor, minSpendMinor: c.min_spend_minor, currency: c.currency,
      expiresAt: iso(c.expires_at), usedCount: c.used_count, usageLimit: c.usage_limit, status: c.status, exclusions: c.terms.exclusions ?? '',
      campaignTitle: info.campaign_title,
      // Holder handle helps staff confirm identity in store; never exposed to API-key callers.
      holderHandle: r.kind === 'staff' ? info.handle : null,
    },
  };
}

/** Redeem a coupon for a purchase made directly with the business. Idempotent per (coupon, reference). */
export async function redeemDirect(ctx: ServiceContext, r: Redeemer, input: DirectRedeemInput) {
  const eligible = input.eligibleMinor ?? input.purchaseMinor;
  const result = await ctx.db.tx(async (q) => {
    await rateLimit(q, `coupon-redeem:${principalKey(r)}`, 60, 60, ctx.clock.now());
    const c = await couponByCode(q, input.code, true);
    if (!c || c.store_id !== r.storeId) throw notFound('Coupon');
    const prior = await q.maybeOne<{ id: string; discount_minor: number; purchase_minor: number; created_at: Date }>(
      `select id, discount_minor, purchase_minor, created_at from coupon_redemptions where coupon_id = $1 and channel = 'STORE_DIRECT' and external_reference = $2`,
      [c.id, input.reference],
    );
    if (prior) {
      if (prior.purchase_minor !== input.purchaseMinor) throw conflict('This receipt reference was already redeemed with a different amount');
      return { redemptionId: prior.id, discountMinor: prior.discount_minor, payableMinor: input.purchaseMinor - prior.discount_minor, currency: c.currency, replay: true, ownerId: c.owner_id, redeemedAt: iso(prior.created_at) };
    }
    const store = await q.one<{ currency: string }>(`select currency from stores where id = $1`, [r.storeId]);
    const discount = evaluateDirectRedemption(terms(c, await pendingHolds(q, c.id)), {
      storeId: r.storeId, currency: store.currency, purchaseMinor: input.purchaseMinor, eligibleMinor: eligible, now: ctx.clock.now(),
    });
    const row = await q.one<{ id: string; created_at: Date }>(
      `insert into coupon_redemptions (coupon_id, discount_minor, status, channel, store_id, external_reference, purchase_minor, redeemed_by, redeemed_via_key, created_at)
       values ($1,$2,'REDEEMED','STORE_DIRECT',$3,$4,$5,$6,$7,$8) returning id, created_at`,
      [c.id, discount, r.storeId, input.reference, input.purchaseMinor, r.kind === 'staff' ? r.actor.userId : null, r.kind === 'key' ? r.keyId : null, ctx.clock.now()],
    );
    await q.query(
      `update coupons set used_count = used_count + 1, status = case when used_count + 1 >= usage_limit then 'EXHAUSTED' else status end where id = $1`,
      [c.id],
    );
    await audit(q, {
      actorId: r.kind === 'staff' ? r.actor.userId : null, action: 'coupon.redeemed_direct', targetType: 'coupon', targetId: c.id,
      metadata: { reference: input.reference, purchaseMinor: input.purchaseMinor, discountMinor: discount, via: r.kind === 'key' ? `api_key:${r.keyId}` : 'console' },
    });
    await notify(q, c.owner_id, 'coupon.redeemed', { storeId: r.storeId, discountMinor: discount, currency: c.currency }, `coupon-direct:${row.id}`);
    return { redemptionId: row.id, discountMinor: discount, payableMinor: input.purchaseMinor - discount, currency: c.currency, replay: false, ownerId: c.owner_id, redeemedAt: iso(row.created_at) };
  });
  const { ownerId: _owner, ...publicResult } = result;
  return publicResult;
}

export async function listDirectRedemptions(ctx: ServiceContext, actor: Actor | null, storeId: string) {
  await requireStoreMember(ctx.db, actor, storeId);
  const rows = await ctx.db.query<{ id: string; external_reference: string; purchase_minor: number; discount_minor: number; created_at: Date; code_last4: string; currency: string; staff: string | null; key_name: string | null; campaign_title: string }>(
    `select cr.id, cr.external_reference, cr.purchase_minor, cr.discount_minor, cr.created_at, co.code_last4, co.currency,
            p.handle as staff, k.name as key_name, ca.title as campaign_title
     from coupon_redemptions cr join coupons co on co.id = cr.coupon_id join rewards rw on rw.id = co.reward_id join campaigns ca on ca.id = rw.campaign_id
     left join profiles p on p.id = cr.redeemed_by left join store_api_keys k on k.id = cr.redeemed_via_key
     where cr.store_id = $1 and cr.channel = 'STORE_DIRECT' order by cr.created_at desc limit 100`,
    [storeId],
  );
  return rows.map((x) => ({
    id: x.id, reference: x.external_reference, purchaseMinor: x.purchase_minor, discountMinor: x.discount_minor, currency: x.currency,
    codeLast4: x.code_last4, campaignTitle: x.campaign_title, redeemedAt: iso(x.created_at), redeemedBy: x.staff ? `@${x.staff}` : `API key: ${x.key_name}`,
  }));
}

// ---------------------------------------------------------------------------
// Store API keys (for the business's own website / POS integration)
// ---------------------------------------------------------------------------
export async function createStoreApiKey(ctx: ServiceContext, actor: Actor | null, storeId: string, name: string) {
  const { actor: a } = await requireStorePermission(ctx.db, actor, storeId, 'apikeys.manage');
  const secret = `${STORE_KEY_PREFIX}${ctx.config.SANDBOX_MODE ? 'test' : 'live'}_${randomToken(24)}`;
  const row = await ctx.db.tx(async (q) => {
    const k = await q.one<{ id: string; created_at: Date }>(
      `insert into store_api_keys (store_id, name, key_prefix, key_hash, created_by) values ($1,$2,$3,$4,$5) returning id, created_at`,
      [storeId, name, secret.slice(0, 12), sha256Hex(secret), a.userId],
    );
    await audit(q, { actorId: a.userId, action: 'store_api_key.created', targetType: 'store', targetId: storeId, metadata: { keyId: k.id, name } });
    return k;
  });
  // The plaintext key is returned exactly once.
  return { id: row.id, name, key: secret, prefix: secret.slice(0, 12), createdAt: iso(row.created_at) };
}

export async function listStoreApiKeys(ctx: ServiceContext, actor: Actor | null, storeId: string) {
  await requireStorePermission(ctx.db, actor, storeId, 'apikeys.manage');
  const rows = await ctx.db.query<{ id: string; name: string; key_prefix: string; last_used_at: Date | null; revoked_at: Date | null; created_at: Date }>(
    `select id, name, key_prefix, last_used_at, revoked_at, created_at from store_api_keys where store_id = $1 order by created_at desc`,
    [storeId],
  );
  return rows.map((k) => ({ id: k.id, name: k.name, prefix: k.key_prefix, lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at), createdAt: iso(k.created_at) }));
}

export async function revokeStoreApiKey(ctx: ServiceContext, actor: Actor | null, keyId: string) {
  const k = await ctx.db.maybeOne<{ store_id: string; revoked_at: Date | null }>(`select store_id, revoked_at from store_api_keys where id = $1`, [keyId]);
  if (!k) throw notFound('API key');
  const { actor: a } = await requireStorePermission(ctx.db, actor, k.store_id, 'apikeys.manage');
  if (k.revoked_at) throw conflict('Key is already revoked');
  await ctx.db.tx(async (q) => {
    await q.query(`update store_api_keys set revoked_at = now() where id = $1`, [keyId]);
    await audit(q, { actorId: a.userId, action: 'store_api_key.revoked', targetType: 'store', targetId: k.store_id, metadata: { keyId } });
  });
  return { revoked: true };
}

