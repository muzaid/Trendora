import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog, checkout, coupons, engagement, ranking, rewards, campaigns } from '@trendora/services';
import { createWorld, createMarket, approvedEntry, meta, SHIP, DAY, type World, type Market } from '../support/world';

/** Shoppers redeem TRENDORA reward coupons when buying directly from the business. */
let w: World;
let m: Market;
let code: string;
let holder: Awaited<ReturnType<World['user']>>;
let secondCode: string;

beforeAll(async () => {
  w = await createWorld();
  m = await createMarket(w, { stock: 200 });
  const creators = await Promise.all(Array.from({ length: 5 }, (_, i) => w.user(`dc${i}`)));
  const ids: string[] = [];
  for (const [i, c] of creators.entries()) ids.push((await approvedEntry(w, m, c, `dc${i}`)).entryId);
  const voters = await Promise.all(Array.from({ length: 4 }, (_, i) => w.user(`dv${i}`)));
  for (const [i, id] of ids.entries()) for (const [j, v] of voters.entries()) if (j <= i) await engagement.setLike(w.s, v, id, true, meta(`${i}-${j}`));
  for (const id of ids) {
    await ranking.scoreRubric(w.s, m.modA, id, { originality: 70, productIntegration: 70, execution: 70, notes: '' });
    await ranking.scoreRubric(w.s, m.modB, id, { originality: 72, productIntegration: 70, execution: 70, notes: '' });
  }
  w.clock.advance(15 * DAY);
  await campaigns.advanceCampaignPhases(w.s);
  await w.drain();
  const snap = await ranking.startReview(w.s, m.modA, m.campaignId);
  await ranking.finalizeCampaign(w.s, m.admin, m.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'final' }, 'dc-final-1');
  // Ranks 4 and 5 hold 50% coupons.
  const holders = await w.db.query<{ user_id: string }>(`select user_id from rewards where campaign_id = $1 and type = 'COUPON' order by rank`, [m.campaignId]);
  holder = creators.find((c) => c.userId === holders[0]!.user_id)!;
  code = (await rewards.myRewards(w.s, holder))[0]!.coupon!.code;
  const second = creators.find((c) => c.userId === holders[1]!.user_id)!;
  secondCode = (await rewards.myRewards(w.s, second))[0]!.coupon!.code;
});
afterAll(async () => w?.drop());

const staff = () => coupons.resolveRedeemer(w.s, m.staff, null, m.storeId);

describe('store staff redemption', () => {
  it('looks up a code, previews the discount and shows the holder to staff', async () => {
    const r = await coupons.lookupCoupon(w.s, await staff(), { code, purchaseMinor: 8000 });
    expect(r).toMatchObject({ valid: true, discountMinor: 4000, coupon: { percentOff: 50, holderHandle: holder.handle } });
    await expect(coupons.lookupCoupon(w.s, await staff(), { code: 'TR-NOPE-NOPE-NOPE' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('redeems once with a server-computed discount; same receipt is idempotent; reuse is refused', async () => {
    const r1 = await coupons.redeemDirect(w.s, await staff(), { code, purchaseMinor: 8000, reference: 'POS-1001' });
    expect(r1).toMatchObject({ discountMinor: 4000, payableMinor: 4000, replay: false });
    const again = await coupons.redeemDirect(w.s, await staff(), { code, purchaseMinor: 8000, reference: 'POS-1001' });
    expect(again).toMatchObject({ redemptionId: r1.redemptionId, replay: true });
    await expect(coupons.redeemDirect(w.s, await staff(), { code, purchaseMinor: 9000, reference: 'POS-1001' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(coupons.redeemDirect(w.s, await staff(), { code, purchaseMinor: 8000, reference: 'POS-1002' })).rejects.toMatchObject({ code: 'INELIGIBLE' });
    // It can no longer be used online either.
    await expect(checkout.createCheckout(w.s, holder, { items: [{ variantId: m.otherVariantId, qty: 1 }], couponCode: code, shippingAddress: SHIP }, 'after-direct-001')).rejects.toMatchObject({ code: 'INELIGIBLE' });
    const cp = await w.db.one<{ used_count: number; status: string }>(`select used_count, status from coupons where code_last4 = $1`, [code.slice(-4)]);
    expect(cp).toEqual({ used_count: 1, status: 'EXHAUSTED' });
    const hist = await coupons.listDirectRedemptions(w.s, m.owner, m.storeId);
    expect(hist[0]).toMatchObject({ reference: 'POS-1001', discountMinor: 4000, redeemedBy: '@staff' });
    const notes = await w.db.query(`select 1 from notifications where user_id = $1 and type = 'coupon.redeemed'`, [holder.userId]);
    expect(notes).toHaveLength(1);
  });

  it('an online checkout holding the coupon blocks in-store reuse, and concurrent in-store redemptions only succeed once', async () => {
    const second = await w.db.one<{ owner_id: string }>(`select owner_id from coupons where code_last4 = $1`, [secondCode.slice(-4)]);
    const owner = (await w.db.one<{ handle: string }>(`select handle from profiles where id = $1`, [second.owner_id])).handle;
    const ownerActor = await w.actor(owner);
    const hold = await checkout.createCheckout(w.s, ownerActor, { items: [{ variantId: m.otherVariantId, qty: 1 }], couponCode: secondCode, shippingAddress: SHIP }, 'hold-coupon-001');
    await expect(coupons.redeemDirect(w.s, await staff(), { code: secondCode, purchaseMinor: 5000, reference: 'POS-2000' })).rejects.toMatchObject({ code: 'INELIGIBLE' });
    await checkout.expireCheckout(w.s, hold.checkoutId, 'TEST');
    const results = await Promise.allSettled(['POS-2001', 'POS-2002', 'POS-2003'].map(async (ref) => coupons.redeemDirect(w.s, await staff(), { code: secondCode, purchaseMinor: 5000, reference: ref })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('authorization', () => {
  it('requires the coupons.redeem permission and the issuing store', async () => {
    const analyst = await w.user('analyst');
    await catalog.addStaff(w.s, m.owner, m.orgId, { userHandle: 'analyst', role: 'ANALYST' });
    await expect(coupons.resolveRedeemer(w.s, await w.actor('analyst'), null, m.storeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(coupons.resolveRedeemer(w.s, analyst, null, m.storeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rival = await w.user('rival_shop');
    const ob = await catalog.onboardMerchant(w.s, rival, { organizationName: 'Rival', legalName: 'Rival', country: 'US', store: { name: 'Rival', slug: 'rival-dc', description: '', currency: 'USD', country: 'US', shippingPolicy: '', returnPolicy: '' } });
    const rivalStaff = await coupons.resolveRedeemer(w.s, await w.actor('rival_shop'), null, ob.storeId);
    // Another store cannot see or redeem the code (reported as unknown).
    await expect(coupons.lookupCoupon(w.s, rivalStaff, { code: secondCode })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(coupons.redeemDirect(w.s, rivalStaff, { code: secondCode, purchaseMinor: 5000, reference: 'X-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('store API keys: owner-only creation, scoped to one store, revocable, hashed at rest', async () => {
    await expect(coupons.createStoreApiKey(w.s, m.staff, m.storeId, 'pos')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const k = await coupons.createStoreApiKey(w.s, m.owner, m.storeId, 'Website');
    expect(k.key).toMatch(/^trk_test_/);
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from store_api_keys where key_hash = $1`, [k.key])).n).toBe(0);
    const viaKey = await coupons.resolveRedeemer(w.s, null, k.key, m.storeId);
    expect(viaKey.kind).toBe('key');
    const look = await coupons.lookupCoupon(w.s, viaKey, { code: secondCode, purchaseMinor: 5000 });
    expect(look.coupon.holderHandle).toBeNull(); // no personal data for API callers
    await expect(coupons.resolveRedeemer(w.s, null, k.key, '00000000-0000-4000-a000-000000000000')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(coupons.resolveRedeemer(w.s, null, 'trk_test_forged', m.storeId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await coupons.revokeStoreApiKey(w.s, m.owner, k.id);
    await expect(coupons.resolveRedeemer(w.s, null, k.key, m.storeId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const keys = await coupons.listStoreApiKeys(w.s, m.owner, m.storeId);
    expect(keys[0]).toMatchObject({ name: 'Website', revokedAt: expect.any(String) });
  });

  it('database constraints reject malformed direct redemptions', async () => {
    const cp = await w.db.one<{ id: string }>(`select id from coupons limit 1`);
    await expect(w.db.query(`insert into coupon_redemptions (coupon_id, discount_minor, status, channel, store_id) values ($1, 100, 'REDEEMED', 'STORE_DIRECT', $2)`, [cp.id, m.storeId])).rejects.toThrow(/coupon_redemptions_channel_shape/);
  });
});
