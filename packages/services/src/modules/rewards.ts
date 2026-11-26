import { conflict, forbidden, ineligible, notFound, type RewardDto } from '@trendora/contracts';
import { couponCodeFor } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, iso, notify } from '../ops';
import { requireActor, requireStoreMember, requireStorePermission } from './identity';
import { killSwitches, loadCampaign } from './campaign-data';

type RewardRow = { id: string; campaign_id: string; campaign_title: string; rank: number; type: 'PRIZE' | 'COUPON'; title: string; status: RewardDto['status']; value_minor: number; delivery_deadline: Date | null; fulfillment_evidence: unknown; claim: unknown; user_handle?: string; claimed_at: Date | null };

async function couponFor(ctx: ServiceContext, q: Q, rewardId: string, revealCode: boolean) {
  const c = await q.maybeOne<{ id: string; percent_off: number; max_discount_minor: number; min_spend_minor: number; currency: string; expires_at: Date; status: string; slug: string; used_count: number; usage_limit: number; terms: { exclusions?: string }; code_last4: string }>(
    `select c.*, s.slug from coupons c join stores s on s.id = c.store_id where c.reward_id = $1`,
    [rewardId],
  );
  if (!c) return null;
  const expired = new Date(c.expires_at) <= ctx.clock.now();
  return {
    id: c.id, code: revealCode ? couponCodeFor(ctx.config.COUPON_SECRET, rewardId) : `••••${c.code_last4}`, percentOff: c.percent_off, maxDiscountMinor: c.max_discount_minor,
    minSpendMinor: c.min_spend_minor, currency: c.currency, expiresAt: iso(c.expires_at)!, status: expired && c.status === 'ACTIVE' ? 'EXPIRED' : c.status,
    storeSlug: c.slug, usedCount: c.used_count, usageLimit: c.usage_limit, exclusions: c.terms.exclusions ?? '',
  };
}

/** GET /v1/me/rewards — own rewards and coupons. */
export async function myRewards(ctx: ServiceContext, actor: Actor | null): Promise<RewardDto[]> {
  const a = requireActor(actor);
  const rows = await ctx.db.query<RewardRow>(
    `select r.*, c.title as campaign_title, t.title from rewards r join campaigns c on c.id = r.campaign_id join prize_tiers t on t.id = r.tier_id where r.user_id = $1 order by r.created_at desc`,
    [a.userId],
  );
  return Promise.all(rows.map(async (r) => ({
    id: r.id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, rank: r.rank, type: r.type, title: r.title, status: r.status, valueMinor: r.value_minor,
    deliveryDeadline: iso(r.delivery_deadline), coupon: r.type === 'COUPON' ? await couponFor(ctx, ctx.db, r.id, true) : null, fulfillment: r.fulfillment_evidence,
  })));
}

/** POST /v1/rewards/:id/claim — winner provides shipping details. No fee is ever charged to claim. */
export async function claimReward(ctx: ServiceContext, actor: Actor | null, rewardId: string, input: { shippingAddress: Record<string, unknown> }) {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    const r = await q.maybeOne<{ id: string; user_id: string; type: string; status: string; campaign_id: string; created_at: Date }>(`select * from rewards where id = $1 for update`, [rewardId]);
    if (!r || r.user_id !== a.userId) throw notFound('Reward');
    if (r.type !== 'PRIZE') throw conflict('Coupons are delivered automatically');
    if (r.status !== 'ISSUED') throw conflict(`Reward is ${r.status.toLowerCase()}`);
    const c = await loadCampaign(q, r.campaign_id);
    const deadline = new Date(new Date(r.created_at).getTime() + c.rules.prizes.claimWindowDays * 86_400_000);
    if (ctx.clock.now() > deadline) throw ineligible('The claim window for this prize has closed');
    await q.query(`update rewards set status = 'CLAIMED', claim = $2, claimed_at = now() where id = $1`, [rewardId, JSON.stringify({ shippingAddress: input.shippingAddress, acceptedTermsAt: new Date().toISOString() })]);
    const store = await q.one<{ org_id: string }>(`select org_id from stores where id = $1`, [c.store_id]);
    const staff = await q.query<{ user_id: string }>(`select user_id from memberships where org_id = $1 and role in ('OWNER','MANAGER','FULFILLMENT')`, [store.org_id]);
    for (const s of staff) await notify(q, s.user_id, 'reward.claimed', { rewardId, campaignId: r.campaign_id });
    await audit(q, { actorId: a.userId, action: 'reward.claimed', targetType: 'reward', targetId: rewardId });
    return { status: 'CLAIMED' };
  });
}

export async function merchantRewards(ctx: ServiceContext, actor: Actor | null, storeId: string) {
  const { role } = await requireStoreMember(ctx.db, actor, storeId);
  const rows = await ctx.db.query<RewardRow>(
    `select r.*, c.title as campaign_title, t.title, p.handle as user_handle from rewards r join campaigns c on c.id = r.campaign_id join prize_tiers t on t.id = r.tier_id
     join profiles p on p.id = r.user_id where c.store_id = $1 order by r.type desc, r.rank`,
    [storeId],
  );
  const canSeeAddress = ['OWNER', 'MANAGER', 'FULFILLMENT'].includes(role);
  const couponLiability = await ctx.db.one<{ n: number; outstanding: number }>(
    `select count(*)::int as n, coalesce(sum(co.max_discount_minor) filter (where co.status = 'ACTIVE' and co.expires_at > $2), 0)::bigint as outstanding
     from coupons co join rewards r on r.id = co.reward_id join campaigns c on c.id = r.campaign_id where c.store_id = $1`,
    [storeId, ctx.clock.now()],
  );
  return {
    couponLiability: { issued: couponLiability.n, maxOutstandingMinor: couponLiability.outstanding },
    rewards: rows.map((r) => ({
      id: r.id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, rank: r.rank, type: r.type, title: r.title, status: r.status, valueMinor: r.value_minor,
      winnerHandle: r.user_handle, deliveryDeadline: iso(r.delivery_deadline), claimedAt: iso(r.claimed_at), fulfillment: r.fulfillment_evidence,
      claim: canSeeAddress ? r.claim : null, overdue: r.type === 'PRIZE' && r.status !== 'FULFILLED' && r.delivery_deadline !== null && new Date(r.delivery_deadline) < ctx.clock.now(),
    })),
  };
}

/** Merchant records prize shipment evidence; campaign → FULFILLED when every prize is fulfilled. */
export async function fulfillReward(ctx: ServiceContext, actor: Actor | null, rewardId: string, input: { carrier: string; trackingNumber: string; notes: string }) {
  const r0 = await ctx.db.maybeOne<{ campaign_id: string }>(`select campaign_id from rewards where id = $1`, [rewardId]);
  if (!r0) throw notFound('Reward');
  const c0 = await loadCampaign(ctx.db, r0.campaign_id);
  const { actor: a } = await requireStorePermission(ctx.db, actor, c0.store_id, 'rewards.fulfill');
  return ctx.db.tx(async (q) => {
    if ((await killSwitches(q)).payoutsFrozen) throw forbidden('Reward fulfilment is frozen by the platform');
    const r = await q.one<{ id: string; status: string; type: string; user_id: string }>(`select id, status, type, user_id from rewards where id = $1 for update`, [rewardId]);
    if (r.type !== 'PRIZE') throw conflict('Only prizes need fulfilment');
    if (r.status !== 'CLAIMED' && r.status !== 'FULFILLING') throw conflict(`Reward is ${r.status.toLowerCase()}`);
    await q.query(`update rewards set status = 'FULFILLED', fulfilled_at = now(), fulfillment_evidence = $2 where id = $1`, [rewardId, JSON.stringify({ ...input, recordedBy: a.userId, at: new Date().toISOString() })]);
    await notify(q, r.user_id, 'reward.shipped', { rewardId, carrier: input.carrier, trackingNumber: input.trackingNumber });
    await audit(q, { actorId: a.userId, action: 'reward.fulfilled', targetType: 'reward', targetId: rewardId, metadata: input });
    const pending = await q.one<{ n: number }>(`select count(*)::int as n from rewards where campaign_id = $1 and type = 'PRIZE' and status not in ('FULFILLED','FORFEITED')`, [r0.campaign_id]);
    const c = await loadCampaign(q, r0.campaign_id, { forUpdate: true });
    if (pending.n === 0 && c.status === 'FINALIZED') {
      await q.query(`update campaigns set status = 'FULFILLED', version = version + 1 where id = $1`, [c.id]);
      await audit(q, { actorId: null, action: 'campaign.fulfilled', targetType: 'campaign', targetId: c.id });
    }
    return { status: 'FULFILLED' };
  });
}
