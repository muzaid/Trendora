import { campaignContribution, sensitivity } from '@trendora/core';
import type { Actor, ServiceContext } from '../context';
import { requireStoreMember } from './identity';
import { loadCampaign } from './campaign-data';
import { tiersOf } from './campaigns';

/** Merchant analytics (spec §5): funnel, attributed revenue, repeat purchase, fraud flags, contribution margin. */
export async function campaignAnalytics(ctx: ServiceContext, actor: Actor | null, campaignId: string) {
  const c = await loadCampaign(ctx.db, campaignId);
  await requireStoreMember(ctx.db, actor, c.store_id);
  const q = ctx.db;
  const one = async (sql: string, params: unknown[] = [campaignId]) => (await q.one<{ n: number }>(sql, params)).n;
  const impressions = await one(`select count(*)::int as n from engagement_events ev join entries e on e.id = ev.entry_id where e.campaign_id = $1 and ev.type = 'IMPRESSION'`);
  const organicImpressions = await one(`select count(*)::int as n from engagement_events ev join entries e on e.id = ev.entry_id where e.campaign_id = $1 and ev.type = 'IMPRESSION' and ev.exposure_source <> 'PAID'`);
  const paidOrders = await one(`select count(distinct o.id)::int as n from orders o join order_items oi on oi.order_id = o.id where oi.campaign_id = $1 and o.status in ('PAID','FULFILLING','SHIPPED','DELIVERED')`);
  const delivered = await one(`select count(distinct o.id)::int as n from orders o join order_items oi on oi.order_id = o.id where oi.campaign_id = $1 and o.status = 'DELIVERED'`);
  const units = await one(`select coalesce(sum(oi.qty),0)::int as n from orders o join order_items oi on oi.order_id = o.id where oi.campaign_id = $1 and o.status in ('PAID','FULFILLING','SHIPPED','DELIVERED')`);
  const gross = await one(`select coalesce(sum(oi.qty * oi.unit_minor),0)::bigint as n from orders o join order_items oi on oi.order_id = o.id where oi.campaign_id = $1 and o.status in ('PAID','FULFILLING','SHIPPED','DELIVERED')`);
  const refunded = await one(`select coalesce(sum(r.amount_minor),0)::bigint as n from refunds r where r.status = 'SUCCEEDED' and r.order_id in (select oi.order_id from order_items oi where oi.campaign_id = $1)`);
  const entitlements = await one(`select count(*)::int as n from entitlements where campaign_id = $1`);
  const entries = await one(`select count(*)::int as n from entries where campaign_id = $1 and status in ('REVIEW','APPROVED')`);
  const approved = await one(`select count(*)::int as n from entries where campaign_id = $1 and status = 'APPROVED'`);
  const shares = await one(`select count(*)::int as n from engagement_events ev join entries e on e.id = ev.entry_id where e.campaign_id = $1 and ev.type = 'SHARE_VISIT' and ev.validity = 'VALID'`);
  const invalidEvents = await one(`select count(*)::int as n from engagement_events ev join entries e on e.id = ev.entry_id where e.campaign_id = $1 and ev.validity = 'INVALID'`);
  const flags = await one(`select count(*)::int as n from fraud_flags where campaign_id = $1`);
  const repeatBuyers = await one(
    `select count(*)::int as n from (select o.buyer_id from orders o where o.store_id = $2 and o.status in ('PAID','FULFILLING','SHIPPED','DELIVERED')
       and o.buyer_id in (select o2.buyer_id from orders o2 join order_items oi on oi.order_id = o2.id where oi.campaign_id = $1) group by o.buyer_id having count(*) > 1) x`,
    [campaignId, c.store_id],
  );
  const reuseConsent = await one(`select count(*)::int as n from entries where campaign_id = $1 and status = 'APPROVED' and commercial_reuse_consent`);
  const couponRedemptions = await one(`select count(*)::int as n from coupon_redemptions cr join coupons co on co.id = cr.coupon_id join rewards r on r.id = co.reward_id where r.campaign_id = $1 and cr.status = 'REDEEMED'`);
  const couponRevenue = await one(`select coalesce(sum(o.total_minor),0)::bigint as n from coupon_redemptions cr join coupons co on co.id = cr.coupon_id join rewards r on r.id = co.reward_id join orders o on o.id = cr.order_id where r.campaign_id = $1 and cr.status = 'REDEEMED'`);
  const tiers = await tiersOf(q, campaignId);
  const prizes = tiers.filter((t) => t.type === 'PRIZE').reduce((s, t) => s + t.valueMinor * ((t.rankTo ?? t.rankFrom) - t.rankFrom + 1), 0);
  const commission = Math.floor((gross * ctx.config.PLATFORM_COMMISSION_BPS + 5000) / 10_000);
  return {
    currency: c.currency,
    funnel: { impressions, organicImpressions, paidImpressions: impressions - organicImpressions, paidOrders, delivered, entitlements, entries, approved },
    rates: {
      deliveredToEntry: delivered ? entries / delivered : 0,
      sharesPerEntry: approved ? shares / approved : 0,
      fraudRate: impressions + invalidEvents ? invalidEvents / (impressions + invalidEvents) : 0,
      repeatPurchaseRate: paidOrders ? repeatBuyers / paidOrders : 0,
    },
    revenue: { units, grossMinor: gross, refundedMinor: refunded, commissionMinor: commission, prizesMinor: prizes, contributionBeforeCogsMinor: gross - refunded - commission - prizes, couponRedemptions, couponAttributedRevenueMinor: couponRevenue },
    trust: { invalidEvents, fraudFlags: flags },
    videoRights: { approvedEntries: approved, commercialReuseConsents: reuseConsent },
  };
}

/** Pre-launch sensitivity model (illustrative; merchant supplies unit cost). */
export async function campaignModel(ctx: ServiceContext, actor: Actor | null, campaignId: string, unitCostMinor: number, otherCostsMinor: number) {
  const c = await loadCampaign(ctx.db, campaignId);
  await requireStoreMember(ctx.db, actor, c.store_id);
  const sku = await ctx.db.maybeOne<{ offer_minor: number }>(`select offer_minor from campaign_skus where campaign_id = $1 order by offer_minor limit 1`, [campaignId]);
  const tiers = await tiersOf(ctx.db, campaignId);
  const prizes = tiers.filter((t) => t.type === 'PRIZE').reduce((s, t) => s + t.valueMinor * ((t.rankTo ?? t.rankFrom) - t.rankFrom + 1), 0);
  const base = { units: c.inventory_cap, offerMinor: sku?.offer_minor ?? 0, unitCostMinor, prizesMinor: prizes, commissionBps: ctx.config.PLATFORM_COMMISSION_BPS, otherCostsMinor };
  return { base: campaignContribution(base), sensitivity: sensitivity(base, [0.25, 0.5, 0.75, 1].map((f) => Math.round(c.inventory_cap * f))) };
}
