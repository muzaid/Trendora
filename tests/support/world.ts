import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '@trendora/db';
import { defaultRules, type CampaignRules } from '@trendora/contracts';
import {
  createServices, drainOutbox, FixedClock, identity, catalog, campaigns, checkout, payments, orders, entries, trust, type Actor, type Services,
} from '@trendora/services';
import { templateDb, adminUrl } from './global-setup';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `trendora_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`create database ${name} template ${templateDb()}`);
  await admin.end();
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface World {
  s: Services;
  db: Db;
  clock: FixedClock;
  drop: () => Promise<void>;
  user: (handle: string, opts?: { roles?: string[]; country?: string; birthYear?: number | null }) => Promise<Actor>;
  actor: (handle: string) => Promise<Actor>;
  drain: () => Promise<number>;
}

export async function createWorld(): Promise<World> {
  const { url, drop } = await freshDatabase();
  const db = createDb(url, { max: 12 });
  const clock = new FixedClock(new Date('2027-03-01T12:00:00Z'));
  const media = mkdtempSync(join(tmpdir(), 'trendora-media-'));
  const s = createServices({
    db, clock,
    env: {
      ...process.env, NODE_ENV: 'test', DATABASE_URL: url, SANDBOX_MODE: 'true', APP_URL: 'http://localhost:3000',
      AUTH_JWT_SECRET: 'test-auth-secret-0123456789abcdef0123', SIGNING_SECRET: 'test-signing-secret-0123456789abcdef', COUPON_SECRET: 'test-coupon-secret-0123456789abcdef0',
      MEDIA_DIR: media, CHECKOUT_TTL_SECONDS: '900', ANTHROPIC_API_KEY: '',
    } as NodeJS.ProcessEnv,
  });
  const handles = new Map<string, string>();
  const world: World = {
    s, db, clock,
    drop: async () => { await db.close(); await drop(); },
    async user(handle, opts = {}) {
      const id = randomUUID();
      handles.set(handle, id);
      await db.query(`insert into auth.users (id, email) values ($1,$2)`, [id, `${handle}@t.test`]);
      await db.query(`insert into profiles (id, handle, display_name, country, birth_year, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [id, handle, handle, opts.country ?? 'US', opts.birthYear === undefined ? 1990 : opts.birthYear, new Date(clock.now().getTime() - 400 * DAY)]);
      for (const r of opts.roles ?? []) await db.query(`insert into platform_roles (user_id, role) values ($1,$2)`, [id, r]);
      return (await identity.loadActor(db, id, 'aal2'))!;
    },
    async actor(handle) {
      return (await identity.loadActor(db, handles.get(handle)!, 'aal2'))!;
    },
    drain: () => drainOutbox(s, { maxRounds: 50 }),
  };
  return world;
}

let clipCache: Buffer | null = null;
/** A real 2-second MP4 (ffmpeg) so the sandbox transcoder's checks are exercised. */
export function testClip(salt = 'a'): Buffer {
  if (!clipCache) {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'));
    const out = join(dir, 'c.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', out]);
    if (!existsSync(out)) throw new Error('ffmpeg failed');
    clipCache = readFileSync(out);
  }
  // Append salt to make content hashes differ while keeping a valid container.
  return Buffer.concat([clipCache, Buffer.from(`\n${salt}`)]);
}

export interface Market {
  owner: Actor; staff: Actor; admin: Actor; modA: Actor; modB: Actor; finance: Actor;
  orgId: string; storeId: string; variantId: string; otherVariantId: string; campaignId: string;
}

export const SHIP = { name: 'Test Buyer', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' };

/** Verified merchant + product + approved, OPEN campaign (Glow Up style). */
export async function createMarket(w: World, opts: { stock?: number; cap?: number; rules?: Partial<CampaignRules>; milestone?: 'PAID' | 'DELIVERED' } = {}): Promise<Market> {
  const admin = await w.user('admin', { roles: ['ADMIN'] });
  const modA = await w.user('mod_a', { roles: ['MODERATOR'] });
  const modB = await w.user('mod_b', { roles: ['MODERATOR'] });
  const finance = await w.user('finance', { roles: ['FINANCE'] });
  let owner = await w.user('owner');
  const ob = await catalog.onboardMerchant(w.s, owner, { organizationName: 'GlowLab', legalName: 'GlowLab LLC', country: 'US', store: { name: 'GlowLab', slug: 'glowlab', description: '', currency: 'USD', country: 'US', shippingPolicy: '', returnPolicy: '' } });
  await trust.decideOrganization(w.s, admin, ob.orgId, 'VERIFIED', 'ok');
  owner = await w.actor('owner');
  let staff = await w.user('staff');
  await catalog.addStaff(w.s, owner, ob.orgId, { userHandle: 'staff', role: 'FULFILLMENT' });
  staff = await w.actor('staff');
  const p = await catalog.createProduct(w.s, owner, { storeId: ob.storeId, title: 'Glow Serum', description: '', imageUrls: [], status: 'ACTIVE', variants: [
    { sku: 'GS', title: '30ml', priceMinor: 9900, stock: opts.stock ?? 100, attributes: {} },
    { sku: 'GS2', title: '50ml', priceMinor: 14900, stock: 100, attributes: {} },
  ] });
  const t0 = w.clock.now().getTime();
  const rules = defaultRules({ minEntries: 2, ...opts.rules });
  rules.eligibility = { ...rules.eligibility, entitlementMilestone: opts.milestone ?? 'PAID' };
  const draft = await campaigns.createCampaignDraft(w.s, owner, {
    storeId: ob.storeId, title: 'Glow Up', tagline: '', description: '',
    startsAt: new Date(t0 + HOUR).toISOString(), submissionEnd: new Date(t0 + 7 * DAY).toISOString(), voteEnd: new Date(t0 + 14 * DAY).toISOString(), appealDeadline: new Date(t0 + 16 * DAY).toISOString(),
    displayTimezone: 'UTC', inventoryCap: opts.cap ?? Math.min(opts.stock ?? 100, 2000),
    skus: [{ variantId: p.variantIds[0]!, requiredQty: 1, offerMinor: 4900 }],
    prizeTiers: [
      { rankFrom: 1, rankTo: 1, type: 'PRIZE', title: 'Vacation', valueMinor: 300_000, percentOff: null },
      { rankFrom: 2, rankTo: 2, type: 'PRIZE', title: 'PS5', valueMinor: 50_000, percentOff: null },
      { rankFrom: 3, rankTo: 3, type: 'PRIZE', title: 'Headphones', valueMinor: 35_000, percentOff: null },
      { rankFrom: 4, rankTo: 10, type: 'COUPON', title: '50% off', valueMinor: 0, percentOff: 50 },
      { rankFrom: 11, rankTo: null, type: 'COUPON', title: '20% off', valueMinor: 0, percentOff: 20 },
    ],
    rules,
  });
  await campaigns.submitFunding(w.s, owner, draft.campaignId, { method: 'ESCROW_PROVIDER', reference: 'ESC-1', amountMinor: 385_000 });
  await campaigns.submitForReview(w.s, owner, draft.campaignId);
  await campaigns.verifyFunding(w.s, finance, draft.campaignId, true, 'confirmed');
  await campaigns.reviewCampaign(w.s, admin, draft.campaignId, 'APPROVE', 'approved');
  w.clock.advance(2 * HOUR);
  await campaigns.advanceCampaignPhases(w.s);
  return { owner, staff, admin, modA, modB, finance, orgId: ob.orgId, storeId: ob.storeId, variantId: p.variantIds[0]!, otherVariantId: p.variantIds[1]!, campaignId: draft.campaignId };
}

/** Buy the campaign SKU and pay in the sandbox; returns ids. */
export async function buyAndPay(w: World, m: Market, buyer: Actor, opts: { qty?: number; couponCode?: string; variantId?: string; campaign?: boolean } = {}) {
  const co = await checkout.createCheckout(w.s, buyer, {
    ...(opts.campaign === false ? {} : { campaignId: m.campaignId }),
    items: [{ variantId: opts.variantId ?? m.variantId, qty: opts.qty ?? 1 }],
    ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    shippingAddress: SHIP,
  }, `k-${randomUUID().replace(/-/g, '')}`);
  await payments.sandboxPay(w.s, buyer, co.checkoutId, 'succeeded');
  await w.drain();
  return co;
}

/** Full creator path: buy → paid → entitlement → upload → transcode → submit → approve. */
export async function approvedEntry(w: World, m: Market, creator: Actor, salt: string) {
  const co = await buyAndPay(w, m, creator);
  if ((await w.db.one<{ m: string }>(`select rules->'eligibility'->>'entitlementMilestone' as m from campaigns where id = $1`, [m.campaignId])).m === 'DELIVERED') {
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'SHIPPED' });
    await orders.transitionOrder(w.s, m.staff, co.orderId, { to: 'DELIVERED' });
    await w.drain();
  }
  const ent = await w.db.one<{ id: string }>(`select id from entitlements where user_id = $1 and campaign_id = $2`, [creator.userId, m.campaignId]);
  const e = await entries.createEntry(w.s, creator, { entitlementId: ent.id, caption: `entry ${salt}`, commercialReuseConsent: true });
  await entries.receiveUpload(w.s, e.uploadUrl.split('/v1/uploads/')[1]!, testClip(salt), 'video/mp4');
  await w.drain();
  await entries.submitEntry(w.s, creator, e.entryId);
  await entries.moderateEntry(w.s, m.modA, e.entryId, 'APPROVED', 'ok');
  return { entryId: e.entryId, orderId: co.orderId, checkoutId: co.checkoutId };
}

export const meta = (n: number | string) => ({ requestId: 't', ip: `10.1.0.${n}`, deviceId: `dev-${n}`, visitorId: `vis-${n}` });
