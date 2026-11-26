import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultRules } from '@trendora/contracts';
import type { ServiceContext } from '../context';
import { FixedClock } from '../clock';
import { drainOutbox } from '../jobs';
import { loadActor } from '../modules/identity';
import * as catalog from '../modules/catalog';
import * as checkout from '../modules/checkout';
import * as payments from '../modules/payments';
import * as orders from '../modules/orders';
import * as campaigns from '../modules/campaigns';
import * as entries from '../modules/entries';
import * as engagement from '../modules/engagement';
import * as ranking from '../modules/ranking';
import * as trust from '../modules/trust';
import { advanceCampaignPhases } from '../modules/campaigns';
import { SEED_USERS, CREATOR_CAPTIONS, fixtureId, productSvg } from './fixtures';

const run = promisify(execFile);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Generate a short vertical test clip (ffmpeg); falls back to a minimal MP4 header if unavailable. */
async function makeClip(i: number, salt: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'trendora-clip-'));
  const out = join(dir, 'clip.mp4');
  try {
    const hue = (i * 36) % 360;
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=24:duration=4`, '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-metadata', `title=${salt}-${i}`, '-movflags', '+faststart', out], { timeout: 60_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SeedResult {
  storeSlug: string;
  campaignId: string;
  pastCampaignId: string;
  users: Record<string, string>;
}

/**
 * Local seed fixture (spec §18): one merchant, three products, a Glow Up campaign,
 * ten entries, three prize tiers plus participation coupons — produced by driving
 * the real service flows (sandbox checkout, signed webhooks, entitlement, upload,
 * transcode, moderation, engagement, rubric scoring, snapshot). A second, already
 * finalized campaign demonstrates rewards and coupons.
 */
export async function seed(base: ServiceContext, log: (m: string) => void = () => undefined): Promise<SeedResult> {
  const realNow = Date.now();
  const clock = new FixedClock(new Date(realNow - 20 * DAY));
  const ctx: ServiceContext = { ...base, clock, kickJobs: undefined };
  const drain = () => drainOutbox(ctx, { maxRounds: 50 });

  // Users (auth.users + profiles + platform roles)
  const users: Record<string, string> = {};
  for (const u of SEED_USERS) {
    const id = fixtureId(u.handle);
    users[u.handle] = id;
    await ctx.db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [id, `${u.handle}@example.test`]);
    await ctx.db.query(
      `insert into profiles (id, display_name, handle, country, birth_year, created_at) values ($1,$2,$3,'US',1994,$4) on conflict (id) do nothing`,
      [id, u.name, u.handle, new Date(realNow - 90 * DAY)],
    );
    for (const r of u.roles) await ctx.db.query(`insert into platform_roles (user_id, role) values ($1,$2) on conflict do nothing`, [id, r]);
  }
  const actor = async (h: string) => (await loadActor(ctx.db, users[h]!, 'aal2'))!;
  const admin = await actor('admin_alex');

  // Merchant onboarding + verification
  log('merchant + catalog');
  const onboard = await catalog.onboardMerchant(ctx, await actor('glow_owner'), {
    organizationName: 'GlowLab', legalName: 'GlowLab Cosmetics LLC', country: 'US',
    store: { name: 'GlowLab', slug: 'glowlab', description: 'Clean, dermatologist-tested skincare made for everyday glow.', currency: 'USD', country: 'US', shippingPolicy: 'Free standard shipping in the US (3–5 business days).', returnPolicy: '30-day returns on unopened items. Statutory rights apply.' },
  });
  await trust.decideOrganization(ctx, admin, onboard.orgId, 'VERIFIED', 'Seed fixture: documents verified');
  const owner = await actor('glow_owner');
  await catalog.addStaff(ctx, owner, onboard.orgId, { userHandle: 'glow_staff', role: 'FULFILLMENT' });
  const serum = await catalog.createProduct(ctx, owner, { storeId: onboard.storeId, title: 'Glow Serum', description: 'Vitamin C + niacinamide brightening serum, 30 ml.', imageUrls: [productSvg('Glow Serum', 270)], status: 'ACTIVE', variants: [{ sku: 'GS-30', title: '30 ml', priceMinor: 9900, stock: 2500, attributes: { size: '30 ml' } }] });
  const mist = await catalog.createProduct(ctx, owner, { storeId: onboard.storeId, title: 'Hydra Mist', description: 'Hyaluronic setting mist, 100 ml.', imageUrls: [productSvg('Hydra Mist', 190)], status: 'ACTIVE', variants: [{ sku: 'HM-100', title: '100 ml', priceMinor: 2900, stock: 800, attributes: { size: '100 ml' } }] });
  await catalog.createProduct(ctx, owner, { storeId: onboard.storeId, title: 'Silk Lip Oil', description: 'Nourishing lip oil in three shades.', imageUrls: [productSvg('Lip Oil', 330)], status: 'ACTIVE', variants: [
    { sku: 'LO-ROSE', title: 'Rose', priceMinor: 1900, stock: 400, attributes: { shade: 'Rose' } },
    { sku: 'LO-HONEY', title: 'Honey', priceMinor: 1900, stock: 400, attributes: { shade: 'Honey' } },
    { sku: 'LO-BERRY', title: 'Berry', priceMinor: 1900, stock: 0, attributes: { shade: 'Berry' } },
  ] });
  const serumVariant = serum.variantIds[0]!;
  void mist;

  const prizeTiers = [
    { rankFrom: 1, rankTo: 1, type: 'PRIZE' as const, title: 'Weekend getaway for two', valueMinor: 315_000, percentOff: null },
    { rankFrom: 2, rankTo: 2, type: 'PRIZE' as const, title: 'PlayStation 5', valueMinor: 50_000, percentOff: null },
    { rankFrom: 3, rankTo: 3, type: 'PRIZE' as const, title: 'Wireless noise-cancelling headphones', valueMinor: 35_000, percentOff: null },
    { rankFrom: 4, rankTo: 10, type: 'COUPON' as const, title: '50% off your next order', valueMinor: 0, percentOff: 50 },
    { rankFrom: 11, rankTo: 100, type: 'COUPON' as const, title: '35% off your next order', valueMinor: 0, percentOff: 35 },
    { rankFrom: 101, rankTo: null, type: 'COUPON' as const, title: '20% off your next order', valueMinor: 0, percentOff: 20 },
  ];
  const rules = defaultRules({ minEntries: 5 });

  async function scenario(label: string, t0: number, durations: { submitDays: number; voteDays: number; appealDays: number }, nCreators: number) {
    clock.set(new Date(t0));
    const startsAt = new Date(t0 + HOUR);
    const draft = await campaigns.createCampaignDraft(ctx, owner, {
      storeId: onboard.storeId, title: label, tagline: 'Show us your glow-up in 60 seconds. Top 3 win big; everyone eligible earns a coupon.',
      description: 'Buy the Glow Serum at the challenge price, film a creative demo, and compete on the published TrendScore. Prizes are funded by GlowLab.',
      startsAt: startsAt.toISOString(), submissionEnd: new Date(t0 + durations.submitDays * DAY).toISOString(), voteEnd: new Date(t0 + durations.voteDays * DAY).toISOString(),
      appealDeadline: new Date(t0 + durations.appealDays * DAY).toISOString(), displayTimezone: 'America/New_York', inventoryCap: 2000,
      skus: [{ variantId: serumVariant, requiredQty: 1, offerMinor: 4900 }], prizeTiers, rules,
    });
    await campaigns.submitFunding(ctx, owner, draft.campaignId, { method: 'ESCROW_PROVIDER', reference: `SANDBOX-ESCROW-${label.replace(/\W/g, '').toUpperCase()}`, amountMinor: 400_000 });
    await campaigns.submitForReview(ctx, owner, draft.campaignId);
    await campaigns.verifyFunding(ctx, await actor('finance_fin'), draft.campaignId, true, 'Sandbox escrow confirmation received');
    await campaigns.reviewCampaign(ctx, admin, draft.campaignId, 'APPROVE', 'Rules, disclosures and funding verified (seed)');
    clock.set(new Date(startsAt.getTime() + 60_000));
    await advanceCampaignPhases(ctx);

    // Purchases → sandbox payment → shipped → delivered → entitlement
    const creators = SEED_USERS.filter((u) => u.handle.startsWith('creator_')).slice(0, nCreators).map((u) => u.handle);
    for (const [i, h] of creators.entries()) {
      const buyer = await actor(h);
      const co = await checkout.createCheckout(ctx, buyer, { campaignId: draft.campaignId, items: [{ variantId: serumVariant, qty: 1 }], shippingAddress: { name: buyer.displayName, line1: `${100 + i} Market St`, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' } }, `seed-${label}-${h}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 90));
      await payments.sandboxPay(ctx, buyer, co.checkoutId, 'succeeded');
      await drain();
      const staff = await actor('glow_staff');
      await orders.transitionOrder(ctx, staff, co.orderId, { to: 'SHIPPED', carrier: 'USPS', trackingNumber: `9400${i}${Date.now() % 100000}` });
      await orders.transitionOrder(ctx, staff, co.orderId, { to: 'DELIVERED' });
      await drain();
    }
    log(`${label}: uploads`);
    const entryIds: string[] = [];
    for (const [i, h] of creators.entries()) {
      const a = await actor(h);
      const ent = await ctx.db.one<{ id: string }>(`select id from entitlements where campaign_id = $1 and user_id = $2`, [draft.campaignId, a.userId]);
      const e = await entries.createEntry(ctx, a, { entitlementId: ent.id, caption: CREATOR_CAPTIONS[i % CREATOR_CAPTIONS.length]!, commercialReuseConsent: i % 3 !== 0 });
      const token = e.uploadUrl.split('/v1/uploads/')[1]!;
      await entries.receiveUpload(ctx, token, await makeClip(i, label), 'video/mp4');
      await drain();
      await entries.submitEntry(ctx, a, e.entryId);
      clock.advance(10 * 60_000);
      await entries.moderateEntry(ctx, await actor(i % 2 ? 'mod_ava' : 'mod_ben'), e.entryId, 'APPROVED', 'Meets rubric and safety policy');
      entryIds.push(e.entryId);
    }
    // Engagement: deterministic variety so the leaderboard is interesting.
    log(`${label}: engagement`);
    clock.advance(HOUR);
    const voters = SEED_USERS.filter((u) => u.handle.startsWith('viewer_') || u.handle.startsWith('creator_') || u.handle === 'buyer_bea').map((u) => u.handle);
    for (const [i, entryId] of entryIds.entries()) {
      const pop = (nCreators - i) / nCreators; // earlier creators are more popular
      for (const [j, vh] of voters.entries()) {
        const v = await actor(vh);
        const meta = { requestId: 'seed', ip: `10.0.${j}.1`, deviceId: `device-${vh}`, visitorId: `visitor-${vh}` };
        await engagement.recordView(ctx, v, entryId, { type: 'IMPRESSION', source: 'ORGANIC' }, meta).catch(() => undefined);
        if ((i * 7 + j * 3) % 10 < pop * 9) await engagement.recordView(ctx, v, entryId, { type: 'VIEW_COMPLETE', source: 'ORGANIC', watchedMs: 4000 }, meta).catch(() => undefined);
        if ((i * 5 + j * 11) % 10 < pop * 8) await engagement.setLike(ctx, v, entryId, true, meta).catch(() => undefined);
        if ((i + j) % 6 === 0) await engagement.addComment(ctx, v, entryId, j % 2 ? 'Love how you showed the texture and the finish here' : 'wow', meta).catch(() => undefined);
      }
      // Qualified shares: distinct anonymous recipients through signed links.
      const sharer = await actor(voters[i % voters.length]!);
      const link = await engagement.createShareLink(ctx, sharer, entryId).catch(() => null);
      if (link) for (let k = 0; k < Math.round(pop * 6); k++) await engagement.recordShareVisit(ctx, null, link.token, { requestId: 'seed', ip: `172.16.${i}.${k + 10}`, visitorId: `anon-${i}-${k}` });
      // Human creativity rubric — two independent reviewers.
      const base = 55 + ((i * 13) % 40);
      await ranking.scoreRubric(ctx, await actor('mod_ava'), entryId, { originality: base, productIntegration: Math.min(100, base + 5), execution: base - 3, notes: 'seed' });
      await ranking.scoreRubric(ctx, await actor('mod_ben'), entryId, { originality: Math.min(100, base + 4), productIntegration: base, execution: base, notes: 'seed' });
    }
    // A self-vote attempt to show excluded events in the breakdown.
    const self = await actor(creators[0]!);
    await engagement.setLike(ctx, self, entryIds[0]!, true, { requestId: 'seed', ip: '10.9.9.9', deviceId: 'device-self' }).catch(() => undefined);
    await ranking.createSnapshot(ctx, draft.campaignId);
    return { campaignId: draft.campaignId, entryIds };
  }

  // Past campaign: run fully through finalization and partial prize fulfilment.
  log('past campaign');
  const past = await scenario('Summer Shine Challenge', realNow - 40 * DAY, { submitDays: 10, voteDays: 20, appealDays: 22 }, 6);
  clock.set(new Date(realNow - 19 * DAY));
  await advanceCampaignPhases(ctx);
  await drain();
  const snap = await ranking.startReview(ctx, admin, past.campaignId);
  await ranking.finalizeCampaign(ctx, admin, past.campaignId, { expectedSnapshotId: snap.snapshotId, reason: 'Seed: provisional results confirmed, no open appeals' }, `seed-finalize-${past.campaignId}`);
  await drain();

  // Live campaign: Glow Up (voting open now).
  log('live campaign');
  const live = await scenario('Glow Up Challenge', realNow - 3 * DAY, { submitDays: 7, voteDays: 14, appealDays: 16 }, 10);
  clock.set(new Date(realNow));
  await advanceCampaignPhases(ctx);
  await ranking.createSnapshot(ctx, live.campaignId);
  await drain();
  return { storeSlug: 'glowlab', campaignId: live.campaignId, pastCampaignId: past.campaignId, users };
}
