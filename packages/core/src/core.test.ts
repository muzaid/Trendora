import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING, type ScoringConfig } from '@trendora/contracts';
import {
  allocateMinor, bpsOfMinor, percentOfMinor, campaignMachine, entryMachine, orderMachine, timeDrivenStatus, windows,
  smoothedRate, normalizeRate, creativityScore, rankEntries, trendScore, isMeaningfulComment,
  validateTiers, planRewards, tierForRank, requiredPrizeFunding, evaluateCoupon, couponCodeFor, hashCouponCode,
  paymentJournal, refundJournal, assertBalanced, priceCart, reachedMilestone, participantIneligibility,
  eventInvalidReason, signWebhook, verifyWebhook, signToken, verifyToken, canonicalJson, campaignContribution, merchantCan, platformCan,
} from './index';
import { defaultRules } from '@trendora/contracts';

describe('money', () => {
  it('rounds percentages half-up in integer minor units', () => {
    expect(percentOfMinor(4900, 50)).toBe(2450);
    expect(percentOfMinor(999, 35)).toBe(350); // 349.65 → 350
    expect(percentOfMinor(1, 50)).toBe(1); // 0.5 → 1
    expect(percentOfMinor(1, 49)).toBe(0);
    expect(bpsOfMinor(98_000_00, 800)).toBe(7_840_00); // spec: 8% of $98,000 = $7,840
  });
  it('rejects non-integer or negative amounts', () => {
    expect(() => percentOfMinor(10.5, 10)).toThrow();
    expect(() => percentOfMinor(-1, 10)).toThrow();
    expect(() => percentOfMinor(100, 101)).toThrow();
  });
  it('allocates exactly, deterministically', () => {
    expect(allocateMinor(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateMinor(1, [1, 1])).toEqual([1, 0]);
    expect(allocateMinor(1000, [3, 7]).reduce((a, b) => a + b)).toBe(1000);
  });
});

describe('state machines', () => {
  it('follows the campaign lifecycle with explicit cancel', () => {
    expect(campaignMachine.can('DRAFT', 'REVIEW')).toBe(true);
    expect(campaignMachine.can('DRAFT', 'OPEN')).toBe(false);
    expect(campaignMachine.can('FINALIZED', 'CANCELED')).toBe(false);
    expect(campaignMachine.can('REVIEWING', 'FINALIZED')).toBe(true);
    expect(() => campaignMachine.assert('FULFILLED', 'OPEN')).toThrow(/Invalid campaign transition/);
  });
  it('entries and orders', () => {
    expect(entryMachine.can('REVIEW', 'APPROVED')).toBe(true);
    expect(entryMachine.can('WITHDRAWN', 'APPROVED')).toBe(false);
    expect(orderMachine.can('SHIPPED', 'CANCELED')).toBe(false);
    expect(orderMachine.can('PENDING', 'PAID')).toBe(true);
  });
  it('time-driven status respects exact deadline boundaries', () => {
    const t = { startsAt: new Date('2027-01-01T00:00:00Z'), submissionEnd: new Date('2027-01-08T00:00:00Z'), voteEnd: new Date('2027-01-15T00:00:00Z') };
    expect(timeDrivenStatus('SCHEDULED', t, new Date('2026-12-31T23:59:59.999Z'))).toBe('SCHEDULED');
    expect(timeDrivenStatus('SCHEDULED', t, t.startsAt)).toBe('OPEN');
    expect(timeDrivenStatus('OPEN', t, new Date(t.submissionEnd.getTime() - 1))).toBe('OPEN');
    expect(timeDrivenStatus('OPEN', t, t.submissionEnd)).toBe('SUBMISSION_CLOSED');
    expect(timeDrivenStatus('OPEN', t, t.voteEnd)).toBe('VOTING_CLOSED');
    expect(timeDrivenStatus('REVIEWING', t, t.voteEnd)).toBe('REVIEWING');
    expect(windows.canSubmit(t, new Date(t.submissionEnd.getTime() - 1))).toBe(true);
    expect(windows.canSubmit(t, t.submissionEnd)).toBe(false);
    expect(windows.canVote(t, t.voteEnd)).toBe(false);
  });
});

describe('TrendScore normalization', () => {
  const cfg: ScoringConfig = DEFAULT_SCORING;
  it('applies Bayesian smoothing with prior weight 100', () => {
    expect(smoothedRate(0, 0, 0.05, 100)).toBeCloseTo(0.05);
    expect(smoothedRate(50, 100, 0.05, 100)).toBeCloseTo((50 + 5) / 200);
  });
  it('scales against the reference rate and caps at 100', () => {
    expect(normalizeRate(0, 0, 0.05, 0.2, 100)).toBeCloseTo(25);
    expect(normalizeRate(1000, 1000, 0.05, 0.2, 100)).toBe(100);
    // events never exceed exposures
    expect(normalizeRate(10, 0, 0.05, 0.2, 100)).toBeLessThanOrEqual(100);
  });
  it('needs two rubric scores and adjudicates large gaps with the median', () => {
    const r = (o: number, adj = false) => ({ reviewerId: String(o) + adj, originality: o, productIntegration: o, execution: o, isAdjudication: adj });
    expect(creativityScore([r(80)], 20).status).toBe('NEEDS_SCORES');
    expect(creativityScore([r(80), r(70)], 20)).toMatchObject({ status: 'COMPLETE', score: 75 });
    expect(creativityScore([r(90), r(40)], 20).status).toBe('NEEDS_ADJUDICATION');
    expect(creativityScore([r(90), r(40), r(60, true)], 20)).toMatchObject({ status: 'COMPLETE', score: 60 });
  });
  it('weights sum to the published formula', () => {
    expect(trendScore({ likes: 100, shares: 100, creativity: 100, completion: 100, comments: 100, growth: 100 }, cfg)).toBe(100);
    expect(trendScore({ likes: 100, shares: 0, creativity: 0, completion: 0, comments: 0, growth: 0 }, cfg)).toBe(30);
  });
  it('resolves ties: creativity, then shares, then earlier approval', () => {
    const base = { exposures: 100, likes: 10, completions: 50, meaningfulComments: 1, follows: 1 };
    const rub = (n: number) => [{ reviewerId: 'a', originality: n, productIntegration: n, execution: n, isAdjudication: false }, { reviewerId: 'b', originality: n, productIntegration: n, execution: n, isAdjudication: false }];
    const zeroCfg = { ...cfg, weights: { likes: 100, shares: 0, creativity: 0, completion: 0, comments: 0, growth: 0 } };
    const ranked = rankEntries([
      { ...base, entryId: 'late', approvedAt: new Date(3000), qualifiedShares: 2, rubric: rub(50) },
      { ...base, entryId: 'early', approvedAt: new Date(1000), qualifiedShares: 2, rubric: rub(50) },
      { ...base, entryId: 'creative', approvedAt: new Date(5000), qualifiedShares: 0, rubric: rub(90) },
      { ...base, entryId: 'shared', approvedAt: new Date(4000), qualifiedShares: 9, rubric: rub(50) },
    ], zeroCfg);
    expect(ranked.map((r) => r.entryId)).toEqual(['creative', 'shared', 'early', 'late']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
  it('is reproducible', () => {
    const m = [{ entryId: 'x', approvedAt: new Date(1), exposures: 40, likes: 7, qualifiedShares: 2, completions: 20, meaningfulComments: 3, follows: 1, rubric: [] }];
    expect(rankEntries(m, cfg)).toEqual(rankEntries(m, cfg));
  });
  it('meaningful comments', () => {
    expect(isMeaningfulComment('wow', 4)).toBe(false);
    expect(isMeaningfulComment('love love love love', 4)).toBe(false);
    expect(isMeaningfulComment('Love how you showed the texture', 4)).toBe(true);
  });
});

describe('prize tiers and reward planning', () => {
  const tiers = [
    { id: 't1', rankFrom: 1, rankTo: 1, type: 'PRIZE' as const, title: 'Vacation', valueMinor: 300_000, percentOff: null },
    { id: 't2', rankFrom: 2, rankTo: 3, type: 'PRIZE' as const, title: 'PS5', valueMinor: 50_000, percentOff: null },
    { id: 't3', rankFrom: 4, rankTo: 10, type: 'COUPON' as const, title: '50%', valueMinor: 0, percentOff: 50 },
    { id: 't4', rankFrom: 11, rankTo: null, type: 'COUPON' as const, title: '20%', valueMinor: 0, percentOff: 20 },
  ];
  it('validates contiguity and shape', () => {
    expect(() => validateTiers(tiers)).not.toThrow();
    expect(() => validateTiers([{ ...tiers[0]!, rankFrom: 2 }])).toThrow(/contiguous/);
    expect(() => validateTiers([tiers[3]!, { ...tiers[0]!, rankFrom: 12, rankTo: 12 }].map((t, i) => ({ ...t, rankFrom: i === 0 ? 1 : t.rankFrom })))).toThrow();
    expect(() => validateTiers([{ ...tiers[2]!, rankFrom: 1, percentOff: null }])).toThrow();
  });
  it('maps ranks to tiers and plans one reward per entry', () => {
    expect(tierForRank(tiers, 3)?.id).toBe('t2');
    expect(tierForRank(tiers, 500)?.id).toBe('t4');
    const plan = planRewards(Array.from({ length: 12 }, (_, i) => ({ entryId: `e${i}`, userId: `u${i}`, rank: i + 1 })), tiers);
    expect(plan).toHaveLength(12);
    expect(plan.filter((p) => p.tier.type === 'COUPON')).toHaveLength(9);
    expect(() => planRewards([{ entryId: 'a', userId: 'u', rank: 1 }, { entryId: 'a', userId: 'u', rank: 2 }], tiers)).toThrow(/Duplicate/);
    expect(requiredPrizeFunding(tiers)).toBe(400_000);
  });
});

describe('coupons', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const base = { storeId: 's1', percentOff: 50, maxDiscountMinor: 3000, minSpendMinor: 2000, currency: 'USD', allowedVariantIds: null, excludedVariantIds: ['gift'], usageLimit: 1, usedCount: 0, pendingCount: 0, expiresAt: new Date('2027-02-01'), status: 'ACTIVE' as const, ownerId: 'u1' };
  const ctx = { storeId: 's1', buyerId: 'u1', currency: 'USD', lines: [{ variantId: 'v1', qty: 1, unitMinor: 4900 }], now };
  it('caps the discount and excludes SKUs', () => {
    expect(evaluateCoupon(base, ctx)).toBe(2450);
    expect(evaluateCoupon(base, { ...ctx, lines: [{ variantId: 'v1', qty: 2, unitMinor: 9900 }] })).toBe(3000);
    expect(evaluateCoupon(base, { ...ctx, lines: [...ctx.lines, { variantId: 'gift', qty: 1, unitMinor: 10000 }] })).toBe(2450);
  });
  it('enforces store, owner, expiry, min spend and usage limit', () => {
    expect(() => evaluateCoupon(base, { ...ctx, storeId: 's2' })).toThrow(/issuing store/);
    expect(() => evaluateCoupon(base, { ...ctx, buyerId: 'u2' })).toThrow(/another account/);
    expect(() => evaluateCoupon(base, { ...ctx, now: new Date('2027-02-01') })).toThrow(/expired/);
    expect(() => evaluateCoupon(base, { ...ctx, lines: [{ variantId: 'v1', qty: 1, unitMinor: 1500 }] })).toThrow(/minimum spend/);
    expect(() => evaluateCoupon({ ...base, pendingCount: 1 }, ctx)).toThrow(/usage limit/);
    expect(() => evaluateCoupon({ ...base, allowedVariantIds: ['v9'] }, ctx)).toThrow(/eligible/);
  });
  it('derives stable unguessable codes; only hashes are stored', () => {
    const c = couponCodeFor('secret', 'reward-1');
    expect(c).toMatch(/^TR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(couponCodeFor('secret', 'reward-1')).toBe(c);
    expect(couponCodeFor('other', 'reward-1')).not.toBe(c);
    expect(hashCouponCode(` ${c.toLowerCase()} `)).toBe(hashCouponCode(c));
  });
});

describe('ledger', () => {
  it('builds balanced payment and refund journals', () => {
    const p = paymentJournal({ eventId: 'e', orderId: 'o', storeId: 's', currency: 'USD', amountMinor: 4900, commissionBps: 800 });
    expect(p.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(0);
    expect(p.lines.find((l) => l.accountCode === 'revenue:platform_commission')!.amountMinor).toBe(-392);
    const r = refundJournal({ eventId: 'r', orderId: 'o', storeId: 's', currency: 'USD', amountMinor: 4900, commissionBps: 800 });
    expect(r.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(0);
    expect(() => assertBalanced([{ accountCode: 'a', amountMinor: 1 }, { accountCode: 'b', amountMinor: -2 }])).toThrow(/unbalanced/);
  });
  it('reproduces the illustrative campaign model', () => {
    const r = campaignContribution({ units: 2000, offerMinor: 4900, unitCostMinor: 2000, prizesMinor: 400_000, commissionBps: 800, otherCostsMinor: 500_000 });
    expect(r.grossMinor).toBe(9_800_000);
    expect(r.commissionMinor).toBe(784_000);
    expect(r.contributionMinor).toBe(4_116_000); // $41,160
  });
});

describe('checkout pricing', () => {
  const catalog = new Map([
    ['v1', { id: 'v1', storeId: 's1', priceMinor: 9900, currency: 'USD', active: true }],
    ['v2', { id: 'v2', storeId: 's1', priceMinor: 2900, currency: 'USD', active: true }],
    ['x', { id: 'x', storeId: 's2', priceMinor: 100, currency: 'USD', active: true }],
  ]);
  const campaign = { id: 'c1', storeId: 's1', currency: 'USD', offerOpen: true, offers: [{ variantId: 'v1', offerMinor: 4900, requiredQty: 1 }] };
  it('reprices from catalog + campaign and merges duplicate lines', () => {
    const r = priceCart([{ variantId: 'v1', qty: 1 }, { variantId: 'v2', qty: 1 }, { variantId: 'v1', qty: 1 }], catalog, campaign);
    expect(r.subtotalMinor).toBe(2 * 4900 + 2900);
    expect(r.lines.find((l) => l.variantId === 'v1')).toMatchObject({ qty: 2, unitMinor: 4900, campaignId: 'c1' });
  });
  it('rejects multi-store carts, closed offers and missing bundles', () => {
    expect(() => priceCart([{ variantId: 'v1', qty: 1 }, { variantId: 'x', qty: 1 }], catalog, null)).toThrow(/single store/);
    expect(() => priceCart([{ variantId: 'v1', qty: 1 }], catalog, { ...campaign, offerOpen: false })).toThrow(/not currently open/);
    expect(() => priceCart([{ variantId: 'v2', qty: 1 }], catalog, campaign)).toThrow(/qualifying bundle/);
    expect(() => priceCart([{ variantId: 'nope', qty: 1 }], catalog, null)).toThrow(/not available/);
  });
});

describe('eligibility & fraud rules', () => {
  const rules = defaultRules();
  const now = new Date('2027-06-01T00:00:00Z');
  it('entitlement milestones', () => {
    expect(reachedMilestone('PAID', 'PAID')).toBe(true);
    expect(reachedMilestone('PAID', 'DELIVERED')).toBe(false);
    expect(reachedMilestone('DELIVERED', 'DELIVERED')).toBe(true);
    expect(reachedMilestone('CANCELED', 'PAID')).toBe(false);
  });
  it('participant checks (country, conservative age)', () => {
    const p = { country: 'US', birthYear: 1990, status: 'ACTIVE', createdAt: now };
    expect(participantIneligibility(p, rules, now)).toBeNull();
    expect(participantIneligibility({ ...p, country: 'FR' }, rules, now)).toBe('COUNTRY');
    expect(participantIneligibility({ ...p, birthYear: 2009 }, rules, now)).toBe('UNDER_AGE'); // may be 17 on Jan 1
    expect(participantIneligibility({ ...p, birthYear: 2008 }, rules, now)).toBeNull();
    expect(participantIneligibility({ ...p, birthYear: null }, rules, now)).toBe('AGE_UNKNOWN');
  });
  it('event validity', () => {
    const e = { type: 'LIKE', actorId: 'a', creatorId: 'c', actorCreatedAt: new Date(0), actorRisk: 0, occurredAt: now, recentActorEventsSameType: 0, priorSameTypeForEntry: 0 };
    const policy = { minAccountAgeHours: 24, maxLikesPerMinute: 10, viewCapPerUser: 3 };
    expect(eventInvalidReason(e, policy)).toBeNull();
    expect(eventInvalidReason({ ...e, actorId: 'c' }, policy)).toBe('SELF_ENGAGEMENT');
    expect(eventInvalidReason({ ...e, actorCreatedAt: new Date(now.getTime() - 3_600_000) }, policy)).toBe('ACCOUNT_TOO_NEW');
    expect(eventInvalidReason({ ...e, recentActorEventsSameType: 10 }, policy)).toBe('RATE_LIMIT_BURST');
    expect(eventInvalidReason({ ...e, type: 'IMPRESSION', priorSameTypeForEntry: 3 }, policy)).toBe('VIEW_CAP');
    expect(eventInvalidReason({ ...e, actorRisk: 95 }, policy)).toBe('HIGH_RISK_ACCOUNT');
  });
});

describe('signing', () => {
  it('verifies webhook signatures and rejects tampering and replay', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const h = signWebhook('whsec', body, 1_000_000);
    expect(verifyWebhook('whsec', body, h, 1_000_010)).toBe(true);
    expect(verifyWebhook('whsec', body + ' ', h, 1_000_010)).toBe(false);
    expect(verifyWebhook('wrong', body, h, 1_000_010)).toBe(false);
    expect(verifyWebhook('whsec', body, h, 1_000_000 + 301)).toBe(false);
    expect(verifyWebhook('whsec', body, null, 1_000_000)).toBe(false);
  });
  it('signed tokens expire and resist forgery', () => {
    const t = signToken('k', { u: 'x', exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifyToken<{ u: string }>('k', t)?.u).toBe('x');
    expect(verifyToken('other', t)).toBeNull();
    expect(verifyToken('k', signToken('k', { u: 'x', exp: 1 }))).toBeNull();
    const [body] = t.split('.');
    expect(verifyToken('k', `${body}x.${t.split('.')[1]}`)).toBeNull();
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe(canonicalJson({ a: [{ c: 1, d: 2 }], b: 1 }));
  });
});

describe('permissions', () => {
  it('least privilege for merchant staff and platform roles', () => {
    expect(merchantCan('FULFILLMENT', 'orders.manage')).toBe(true);
    expect(merchantCan('FULFILLMENT', 'orders.refund')).toBe(false);
    expect(merchantCan('ANALYST', 'catalog.write')).toBe(false);
    expect(merchantCan('OWNER', 'campaigns.publish')).toBe(true);
    expect(platformCan(['MODERATOR'], 'finance')).toBe(false);
    expect(platformCan(['ADMIN'], 'finance')).toBe(true);
  });
});
