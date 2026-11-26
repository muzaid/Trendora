import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout, payments, orders, entries, engagement, ranking, rewards, trust, campaigns } from '@trendora/services';
import { couponCodeFor } from '@trendora/core';
import { createWorld, createMarket, buyAndPay, approvedEntry, testClip, meta, SHIP, type World, type Market, DAY, HOUR } from '../support/world';

let w: World;
let m: Market;
beforeAll(async () => {
  w = await createWorld();
  m = await createMarket(w, { stock: 500, milestone: 'DELIVERED' });
});
afterAll(async () => w?.drop());

describe('entitlements', () => {
  it('are created only after the configured delivery milestone, once per order line', async () => {
    const b = await w.user('ent_buyer');
    const co = await buyAndPay(w, m, b);
    const count = async () => (await w.db.one<{ n: number }>(`select count(*)::int as n from entitlements where user_id = $1`, [b.userId])).n;
    expect(await count()).toBe(0); // PAID is not enough for a DELIVERED campaign
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'SHIPPED' });
    await w.drain();
    expect(await count()).toBe(0);
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'DELIVERED' });
    await w.drain();
    expect(await count()).toBe(1);
    await orders.grantEntitlementsForOrder(w.s, co.orderId); // re-run is harmless
    expect(await count()).toBe(1);
  });

  it('offers a free alternative entry after moderator approval', async () => {
    const free = await w.user('free_entrant');
    await campaigns.requestAlternativeEntry(w.s, free, m.campaignId, 'I would film a morning routine demo with the serum');
    await expect(campaigns.requestAlternativeEntry(w.s, free, m.campaignId, 'again please let me in')).rejects.toMatchObject({ code: 'CONFLICT' });
    const req = await w.db.one<{ id: string }>(`select id from alternative_entry_requests where user_id = $1`, [free.userId]);
    await campaigns.decideAlternativeEntry(w.s, m.modA, req.id, 'APPROVED');
    const ent = await w.db.one<{ source: string }>(`select source from entitlements where user_id = $1`, [free.userId]);
    expect(ent.source).toBe('ALTERNATIVE');
  });
});

describe('video pipeline', () => {
  it('rejects a malicious/non-video upload, then accepts a re-upload', async () => {
    const c = await w.user('bad_uploader');
    const co = await buyAndPay(w, m, c);
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'SHIPPED' });
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'DELIVERED' });
    await w.drain();
    const ent = await w.db.one<{ id: string }>(`select id from entitlements where user_id = $1`, [c.userId]);
    const e = await entries.createEntry(w.s, c, { entitlementId: ent.id, caption: 'x', commercialReuseConsent: false });
    await expect(entries.receiveUpload(w.s, 'forged.token', Buffer.from('x'), 'video/mp4')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await entries.receiveUpload(w.s, e.uploadUrl.split('/v1/uploads/')[1]!, Buffer.from('<?php system($_GET["c"]); ?>'), 'video/mp4');
    await w.drain();
    let mine = (await entries.myEntries(w.s, c)).find((x) => x.id === e.entryId)!;
    expect(mine.videoStatus).toBe('FAILED');
    expect(mine.videoFailure).toBe('UNSUPPORTED_OR_MALICIOUS_FILE');
    expect(mine.status).toBe('DRAFT');
    await expect(entries.submitEntry(w.s, c, e.entryId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const again = await entries.renewUploadUrl(w.s, c, e.entryId);
    await entries.receiveUpload(w.s, again.uploadUrl.split('/v1/uploads/')[1]!, testClip('reupload'), 'video/mp4');
    await w.drain();
    mine = (await entries.myEntries(w.s, c)).find((x) => x.id === e.entryId)!;
    expect(mine.videoStatus).toBe('READY');
    await entries.submitEntry(w.s, c, e.entryId);
    await expect(entries.moderateEntry(w.s, c, e.entryId, 'APPROVED', '')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('flags copied videos (duplicate media hash) for human review', async () => {
    const a = await w.user('orig');
    const b = await w.user('copycat');
    await approvedEntry(w, m, a, 'same');
    const dup = await approvedEntry(w, m, b, 'same');
    const flag = await w.db.maybeOne<{ kind: string }>(`select kind from fraud_flags where entry_id = $1`, [dup.entryId]);
    expect(flag?.kind).toBe('DUPLICATE_MEDIA');
  });
});

describe('engagement validity', () => {
  it('one like per user, self-votes and anonymous votes do not count', async () => {
    const creator = await w.user('liked_creator');
    const { entryId } = await approvedEntry(w, m, creator, 'liked');
    const fan = await w.user('fan');
    const r1 = await engagement.setLike(w.s, fan, entryId, true, meta(1));
    const r2 = await engagement.setLike(w.s, fan, entryId, true, meta(1));
    expect(r1).toMatchObject({ changed: true, counted: true });
    expect(r2.changed).toBe(false);
    await Promise.allSettled([1, 2, 3].map(() => engagement.setLike(w.s, fan, entryId, false, meta(1))));
    expect((await w.db.one<{ n: number }>(`select count(*)::int as n from likes where entry_id = $1 and active`, [entryId])).n).toBe(0);
    const self = await engagement.setLike(w.s, creator, entryId, true, meta(2));
    expect(self.counted).toBe(false);
    await expect(engagement.setLike(w.s, null, entryId, true, meta(3))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('qualified shares require a distinct recipient; sharer/self visits do not count', async () => {
    const creator = await w.user('shared_creator');
    const { entryId } = await approvedEntry(w, m, creator, 'shared');
    const sharer = await w.user('sharer');
    const link = await engagement.createShareLink(w.s, sharer, entryId);
    expect((await engagement.recordShareVisit(w.s, null, link.token, { ...meta('x1'), visitorId: 'r1' })).counted).toBe(true);
    expect((await engagement.recordShareVisit(w.s, null, link.token, { ...meta('x1'), visitorId: 'r1' })).counted).toBe(false);
    expect((await engagement.recordShareVisit(w.s, sharer, link.token, meta('x2'))).counted).toBe(false);
    expect((await engagement.recordShareVisit(w.s, creator, link.token, meta('x3'))).counted).toBe(false);
    await expect(engagement.recordShareVisit(w.s, null, 'nope-nope-nope-nope', meta('x4'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('bot bursts are rate limited and excluded', async () => {
    const w2 = await createWorld();
    try {
      const m2 = await createMarket(w2, { rules: { voting: { minAccountAgeHours: 0, maxLikesPerMinute: 3, viewCapPerUser: 3 } } });
      const creators = await Promise.all([1, 2, 3, 4, 5].map((i) => w2.user(`burst_c${i}`)));
      const ids: string[] = [];
      for (const [i, c] of creators.entries()) ids.push((await approvedEntry(w2, m2, c, `burst${i}`)).entryId);
      const bot = await w2.user('bot');
      const results = [];
      for (const id of ids) results.push(await engagement.setLike(w2.s, bot, id, true, meta('bot')));
      expect(results.filter((r) => r.counted).length).toBe(3);
      const reasons = await w2.db.query<{ invalid_reason: string }>(`select invalid_reason from engagement_events where actor_id = $1 and validity = 'INVALID'`, [bot.userId]);
      expect(reasons.every((r) => r.invalid_reason === 'RATE_LIMIT_BURST')).toBe(true);
    } finally {
      await w2.drop();
    }
  });

  it('server timestamps lock actions at deadlines', async () => {
    const creator = await w.user('deadline_creator');
    const { entryId } = await approvedEntry(w, m, creator, 'deadline');
    const voter = await w.user('late_voter');
    const c = await w.db.one<{ submission_end: Date; vote_end: Date }>(`select submission_end, vote_end from campaigns where id = $1`, [m.campaignId]);
    const saved = w.clock.now();
    w.clock.set(new Date(c.vote_end));
    await expect(engagement.setLike(w.s, voter, entryId, true, meta(9))).rejects.toMatchObject({ code: 'INELIGIBLE' });
    w.clock.set(new Date(new Date(c.vote_end).getTime() - 1));
    await expect(engagement.setLike(w.s, voter, entryId, true, meta(9))).resolves.toMatchObject({ changed: true });
    w.clock.set(new Date(c.submission_end));
    await expect(entries.editEntry(w.s, creator, entryId, 'too late')).rejects.toMatchObject({ code: 'INELIGIBLE' });
    w.clock.set(saved);
  });
});

describe('refund eligibility review', () => {
  it('moves the entitlement to review instead of silently revoking', async () => {
    const c = await w.user('refunded_creator');
    const { entryId, orderId } = await approvedEntry(w, m, c, 'refund');
    await payments.requestRefund(w.s, m.owner, orderId, { amountMinor: 4900, reason: 'Return' });
    await new Promise((r) => setTimeout(r, 60));
    await w.drain();
    const ent = await w.db.one<{ status: string }>(`select en.status from entries e join entitlements en on en.id = e.entitlement_id where e.id = $1`, [entryId]);
    expect(ent.status).toBe('UNDER_REVIEW');
    const flag = await w.db.one<{ id: string; kind: string }>(`select id, kind from fraud_flags where entry_id = $1 and kind = 'REFUND_ELIGIBILITY_REVIEW'`, [entryId]);
    await trust.resolveFlag(w.s, m.modB, flag.id, 'DISMISSED', 'Returned item replaced; published rules keep eligibility');
    expect((await w.db.one<{ status: string }>(`select en.status from entries e join entitlements en on en.id = e.entitlement_id where e.id = $1`, [entryId])).status).toBe('LOCKED');
  });
});

describe('finalization & rewards', () => {
  it('finalizes once, issues one reward per entry, and coupons redeem atomically', async () => {
    const w4 = await createWorld();
    try {
      const m4 = await createMarket(w4, { stock: 200 });
      const creators = await Promise.all(Array.from({ length: 5 }, (_, i) => w4.user(`fc${i}`)));
      const ids: string[] = [];
      for (const [i, c] of creators.entries()) ids.push((await approvedEntry(w4, m4, c, `fin${i}`)).entryId);
      const voters = await Promise.all(Array.from({ length: 4 }, (_, i) => w4.user(`fv${i}`)));
      for (const [i, id] of ids.entries()) for (const [j, v] of voters.entries()) if (j <= i) await engagement.setLike(w4.s, v, id, true, meta(`${i}-${j}`));
      for (const id of ids) {
        await ranking.scoreRubric(w4.s, m4.modA, id, { originality: 70, productIntegration: 70, execution: 70, notes: '' });
        await ranking.scoreRubric(w4.s, m4.modB, id, { originality: 74, productIntegration: 70, execution: 70, notes: '' });
      }
      await expect(ranking.finalizeCampaign(w4.s, m4.admin, m4.campaignId, { expectedSnapshotId: '00000000-0000-4000-a000-000000000000', reason: 'too early' }, 'fin-key-0')).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|INELIGIBLE/) });
      w4.clock.advance(15 * DAY);
      await campaigns.advanceCampaignPhases(w4.s);
      await w4.drain();
      const snap = await ranking.startReview(w4.s, m4.modA, m4.campaignId);
      const ready = await ranking.finalizationReadiness(w4.s, m4.admin, m4.campaignId);
      expect(ready.blockers).toEqual([]);
      await expect(ranking.finalizeCampaign(w4.s, m4.modA, m4.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'moderator cannot' }, 'fin-key-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Simultaneous finalization with different keys: exactly one wins.
      const results = await Promise.allSettled([
        ranking.finalizeCampaign(w4.s, m4.admin, m4.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'final results' }, 'fin-key-A'),
        ranking.finalizeCampaign(w4.s, m4.admin, m4.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'final results' }, 'fin-key-B'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const winnerKey = results[0]!.status === 'fulfilled' ? 'fin-key-A' : 'fin-key-B';
      // Replay with the winning key returns the stored response; no duplicate rewards.
      await expect(ranking.finalizeCampaign(w4.s, m4.admin, m4.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'final results' }, winnerKey)).resolves.toMatchObject({ rewardsIssued: 5 });
      expect((await w4.db.one<{ n: number }>(`select count(*)::int as n from rewards where campaign_id = $1`, [m4.campaignId])).n).toBe(5);
      const board = await ranking.leaderboard(w4.s, m4.campaignId, undefined, 10);
      expect(board.status).toBe('FINAL');
      expect(board.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);

      // Top 3 receive prizes; rank 4–5 receive 50% coupons.
      const top = board.rows[0]!;
      const topOwner = await w4.db.one<{ user_id: string }>(`select user_id from entries where id = $1`, [top.entryId]);
      const winner = creators.find((c) => c.userId === topOwner.user_id)!;
      const myR = await rewards.myRewards(w4.s, winner);
      expect(myR[0]).toMatchObject({ type: 'PRIZE', rank: 1, status: 'ISSUED' });
      await rewards.claimReward(w4.s, winner, myR[0]!.id, { shippingAddress: SHIP });
      await rewards.fulfillReward(w4.s, m4.staff, myR[0]!.id, { carrier: 'UPS', trackingNumber: '1Z999', notes: '' });

      const fourth = await w4.db.one<{ user_id: string; reward_id: string }>(`select e.user_id, r.id as reward_id from entries e join rewards r on r.entry_id = e.id where r.rank = 4 and r.campaign_id = $1`, [m4.campaignId]);
      const couponOwner = creators.find((c) => c.userId === fourth.user_id)!;
      const code = (await rewards.myRewards(w4.s, couponOwner))[0]!.coupon!.code;
      expect(code).toBe(couponCodeFor('test-coupon-secret-0123456789abcdef0', fourth.reward_id));
      // Another user cannot use it.
      await expect(checkout.createCheckout(w4.s, creators.find((c) => c !== couponOwner)!, { items: [{ variantId: m4.otherVariantId, qty: 1 }], couponCode: code, shippingAddress: SHIP }, 'steal-key-0001')).rejects.toMatchObject({ code: 'INELIGIBLE' });
      // Two concurrent checkouts with the same single-use coupon: one wins.
      const both = await Promise.allSettled([1, 2].map((n) => checkout.createCheckout(w4.s, couponOwner, { items: [{ variantId: m4.otherVariantId, qty: 1 }], couponCode: code, shippingAddress: SHIP }, `coupon-key-${n}-xx`)));
      const won = both.filter((b) => b.status === 'fulfilled') as PromiseFulfilledResult<{ checkoutId: string; totalMinor: number; discountMinor: number }>[];
      expect(won).toHaveLength(1);
      expect(won[0]!.value.discountMinor).toBe(7450); // 50% of $149, under the $100 cap
      await payments.sandboxPay(w4.s, couponOwner, won[0]!.value.checkoutId, 'succeeded');
      await w4.drain();
      const cp = await w4.db.one<{ used_count: number; status: string }>(`select c.used_count, c.status from coupons c where c.reward_id = $1`, [fourth.reward_id]);
      expect(cp).toEqual({ used_count: 1, status: 'EXHAUSTED' });
      await expect(checkout.createCheckout(w4.s, couponOwner, { items: [{ variantId: m4.otherVariantId, qty: 1 }], couponCode: code, shippingAddress: SHIP }, 'coupon-key-3-xx')).rejects.toMatchObject({ code: 'INELIGIBLE' });
      void HOUR;
    } finally {
      await w4.drop();
    }
  });
});
