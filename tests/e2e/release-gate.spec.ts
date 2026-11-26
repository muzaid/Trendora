import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Spec §17 E2E gate: merchant drafts and publishes; buyer completes sandbox
 * checkout; uploads; entry approved; second user votes; leaderboard closes; top
 * prize and non-winner coupon issued; coupon redeemed.
 */
const DAY = 86_400_000;

function clip(salt: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const out = join(dir, `${salt}.mp4`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10:duration=2', '-metadata', `title=${salt}-${Date.now()}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', out]);
  if (!existsSync(out)) throw new Error('ffmpeg failed');
  return out;
}

async function session(browser: Browser, handle: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId(`login-${handle}`).click();
  await page.waitForURL('/');
  return { page, req: context.request, context };
}

async function api<T>(req: APIRequestContext, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await req[method](path, { data, headers: { origin: 'http://localhost:3000', ...headers } });
  const body = await res.json();
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()} ${JSON.stringify(body)}`);
  return body as T;
}

const SHIP = { name: 'E2E Buyer', line1: '1 Test St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' };

async function fillShipping(page: Page) {
  await page.getByLabel('Full name').fill(SHIP.name);
  await page.getByLabel('Address').fill(SHIP.line1);
  await page.getByLabel('City').fill(SHIP.city);
  await page.getByLabel('Postal code').fill(SHIP.postalCode);
}

test('purchase-to-reward vertical slice', async ({ browser }) => {
  const admin = await session(browser, 'admin_alex');
  await api(admin.req, 'post', '/v1/admin/sandbox/clock', { offsetMs: 0 });
  const owner = await session(browser, 'glow_owner');
  const ctx = await api<{ organizations: { stores: { id: string }[] }[] }>(owner.req, 'get', '/v1/merchant/context');
  const storeId = ctx.organizations[0]!.stores[0]!.id;
  const catalog = await api<{ title: string; variants: { id: string }[] }[]>(owner.req, 'get', `/v1/merchant/stores/${storeId}/catalog`);
  const lip = catalog.find((p) => p.title === 'Silk Lip Oil')!.variants[0]!.id;
  // A fresh product per run keeps the test independent of earlier data.
  const stamp = Date.now();
  const created = await api<{ productId: string; variantIds: string[] }>(owner.req, 'post', '/v1/merchant/products', { storeId, title: `E2E Mist ${stamp}`, description: 'E2E', status: 'ACTIVE', variants: [{ sku: `E2E-${stamp}`, title: '100 ml', priceMinor: 2900, stock: 50 }] });
  const mist = created.variantIds[0]!;

  // 1. Merchant drafts a campaign (API) and publishes it through the console UI.
  const now = Date.now();
  const rules = (await api<{ rules: unknown }>(owner.req, 'get', `/v1/campaigns/${(await api<{ activeCampaigns: { id: string }[] }>(owner.req, 'get', '/v1/stores/glowlab')).activeCampaigns[0]!.id}`)).rules as Record<string, Record<string, unknown>>;
  const title = `E2E Mist Challenge ${now}`;
  const draft = await api<{ campaignId: string }>(owner.req, 'post', '/v1/merchant/campaigns', {
    storeId, title, tagline: 'E2E', description: 'E2E', displayTimezone: 'UTC', inventoryCap: 20,
    startsAt: new Date(now + 3_600_000).toISOString(), submissionEnd: new Date(now + 2 * DAY).toISOString(), voteEnd: new Date(now + 3 * DAY).toISOString(), appealDeadline: new Date(now + 4 * DAY).toISOString(),
    skus: [{ variantId: mist, requiredQty: 1, offerMinor: 1500 }],
    prizeTiers: [
      { rankFrom: 1, rankTo: 1, type: 'PRIZE', title: 'Grand prize', valueMinor: 20_000, percentOff: null },
      { rankFrom: 2, rankTo: null, type: 'COUPON', title: '50% off', valueMinor: 0, percentOff: 50 },
    ],
    rules: { ...rules, minEntries: 2, eligibility: { ...rules.eligibility, entitlementMilestone: 'DELIVERED' } },
  });
  const cid = draft.campaignId;
  await owner.page.goto(`/merchant/campaigns/${cid}`);
  await owner.page.getByLabel('Reference').fill('ESCROW-E2E-1');
  await owner.page.getByRole('button', { name: 'Submit evidence' }).click();
  await expect(owner.page.getByText('Funding PENDING')).toBeVisible();
  await owner.page.getByRole('button', { name: 'Submit for platform review' }).click();
  await expect(owner.page.getByText('Awaiting platform review')).toBeVisible();

  const finance = await session(browser, 'finance_fin');
  await finance.page.goto('/admin?tab=finance');
  await expect(finance.page.getByText('BALANCED', { exact: true })).toBeVisible();
  await finance.page.locator('.card', { hasText: title }).getByRole('button', { name: 'Verify funding' }).click();
  await expect(finance.page.getByText(title)).toHaveCount(0);
  await admin.page.goto('/admin?tab=campaigns');
  await admin.page.getByTestId(`admin-campaign-${cid}`).getByRole('button', { name: 'Approve & publish' }).click();
  await expect(admin.page.getByTestId(`admin-campaign-${cid}`).getByText('SCHEDULED')).toBeVisible();
  await api(admin.req, 'post', '/v1/admin/sandbox/clock', { offsetMs: 2 * 3_600_000 });

  // 2. Buyer completes the sandbox checkout through the storefront.
  const bea = await session(browser, 'buyer_bea');
  const product = await api<{ activeCampaigns: unknown[]; products: { id: string; title: string }[] }>(bea.req, 'get', '/v1/stores/glowlab');
  await bea.page.goto(`/campaigns/${cid}`);
  await bea.page.getByRole('link', { name: 'Buy & enter' }).click();
  await bea.page.waitForURL(new RegExp(`/products/${created.productId}`));
  await expect(bea.page.getByText('Buy at the challenge price')).toBeVisible();
  await fillShipping(bea.page);
  await bea.page.getByTestId('checkout-button').click();
  await bea.page.waitForURL(/\/sandbox\/checkout\//);
  await bea.page.getByRole('button', { name: /^Pay \$15\.00/ }).click();
  await bea.page.waitForURL(/\/me\?tab=orders/);
  await expect(bea.page.getByTestId('order-row').first()).toContainText('PAID');

  // Merchant ships and marks delivered → entitlement unlocked.
  await owner.page.goto(`/merchant?store=${storeId}&tab=orders`);
  const beaRow = owner.page.locator('tr', { hasText: `E2E Mist ${stamp}` });
  await beaRow.getByRole('button', { name: 'Mark shipped' }).click();
  await beaRow.getByRole('button', { name: 'Mark delivered' }).click();
  await expect(beaRow.getByText('DELIVERED')).toBeVisible();

  // 3. Buyer uploads and submits an entry from the arena.
  await bea.page.goto(`/campaigns/${cid}`);
  await expect(bea.page.getByText('Entry unlocked', { exact: true })).toBeVisible();
  await bea.page.getByLabel('Caption').fill('E2E glow demo');
  await bea.page.getByTestId('video-input').setInputFiles(clip('bea'));
  await bea.page.getByRole('button', { name: 'Upload entry' }).click();
  await bea.page.getByTestId('submit-entry').click();
  await expect(bea.page.getByText('A moderator is reviewing your video')).toBeVisible();

  // A second creator enters via the API (same server paths).
  const c2 = await session(browser, 'creator_09');
  const co = await api<{ checkoutId: string; orderId: string }>(c2.req, 'post', '/v1/checkouts', { campaignId: cid, items: [{ variantId: mist, qty: 1 }], shippingAddress: SHIP }, { 'idempotency-key': `e2e${now}c2` });
  await api(c2.req, 'post', `/v1/sandbox/checkouts/${co.checkoutId}/pay`, { outcome: 'succeeded' });
  await api(owner.req, 'post', `/v1/merchant/orders/${co.orderId}/transition`, { to: 'SHIPPED' });
  await api(owner.req, 'post', `/v1/merchant/orders/${co.orderId}/transition`, { to: 'DELIVERED' });
  const ents = await api<{ id: string; campaignId: string }[]>(c2.req, 'get', '/v1/me/entitlements');
  const e2 = await api<{ entryId: string; uploadUrl: string }>(c2.req, 'post', '/v1/entries', { entitlementId: ents.find((e) => e.campaignId === cid)!.id, caption: 'second', commercialReuseConsent: false });
  const up = await c2.req.put(e2.uploadUrl.replace(/^https?:\/\/[^/]+/, ''), { data: readFileSync(clip('c2')), headers: { 'content-type': 'video/mp4' } });
  expect(up.ok()).toBeTruthy();
  await api(c2.req, 'post', `/v1/entries/${e2.entryId}/submit`, {});

  // 4. Moderator approves both entries in the moderation queue.
  const mod = await session(browser, 'mod_ava');
  await mod.page.goto('/admin?tab=moderation');
  for (let i = 0; i < 2; i++) {
    await mod.page.getByTestId('moderation-item').filter({ hasText: title.slice(0, 0) }).filter({ hasText: /E2E glow demo|second/ }).first().getByRole('button', { name: 'Approve' }).click();
    await mod.page.waitForTimeout(500);
  }
  await expect(mod.page.getByTestId('moderation-item').filter({ hasText: /E2E glow demo|second/ })).toHaveCount(0);

  // 5. A second user votes on Bea's entry from the arena feed.
  const voter = await session(browser, 'viewer_01');
  await voter.page.goto(`/campaigns/${cid}`);
  const beaCard = voter.page.getByTestId('video-card').filter({ hasText: '@buyer_bea' });
  await beaCard.getByTestId('like-button').click();
  await expect(beaCard.getByTestId('like-button')).toHaveAttribute('aria-pressed', 'true');
  const share = await api<{ url: string }>(voter.req, 'post', `/v1/entries/${(await api<{ items: { entryId: string; creatorHandle: string }[] }>(voter.req, 'get', `/v1/feed?campaignId=${cid}`)).items.find((i) => i.creatorHandle === 'buyer_bea')!.entryId}/share`, {});
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(share.url.replace(/^https?:\/\/[^/]+/, ''));
  await anonPage.waitForURL(/\/entries\//);

  // 6. Creativity rubric (two independent reviewers).
  const ben = await session(browser, 'mod_ben');
  const feed = await api<{ items: { entryId: string }[] }>(ben.req, 'get', `/v1/feed?campaignId=${cid}`);
  for (const it of feed.items) {
    await api(mod.req, 'post', `/v1/admin/entries/${it.entryId}/rubric`, { originality: 80, productIntegration: 80, execution: 80 });
    await api(ben.req, 'post', `/v1/admin/entries/${it.entryId}/rubric`, { originality: 78, productIntegration: 80, execution: 80 });
  }

  // 7. Voting closes → results review → finalize.
  await api(admin.req, 'post', '/v1/admin/sandbox/clock', { offsetMs: 3 * DAY + 3_600_000 });
  await admin.page.goto('/admin?tab=campaigns');
  const card = admin.page.getByTestId(`admin-campaign-${cid}`);
  await card.getByRole('button', { name: /Start results review/ }).click();
  await expect(card.getByText('Ready to finalize')).toBeVisible();
  admin.page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: 'Finalize & issue rewards' }).click();
  await expect(card.getByText('FINALIZED')).toBeVisible();
  const board = await api<{ status: string; rows: { rank: number; creatorHandle: string }[] }>(admin.req, 'get', `/v1/campaigns/${cid}/leaderboard`);
  expect(board.status).toBe('FINAL');
  expect(board.rows[0]!.creatorHandle).toBe('buyer_bea');

  // 8. Top prize issued to Bea; the non-winner receives a coupon and redeems it.
  await bea.page.goto('/me?tab=rewards');
  await expect(bea.page.getByTestId('reward-card').filter({ hasText: title })).toContainText('Grand prize');
  await c2.page.goto('/me?tab=rewards');
  const couponCard = c2.page.getByTestId('reward-card').filter({ hasText: title });
  const code = (await couponCard.getByTestId('coupon-code').innerText()).trim();
  expect(code).toMatch(/^TR-/);
  const lipProduct = product.products.find((p) => p.title === 'Silk Lip Oil')!;
  await c2.page.goto(`/products/${lipProduct.id}`);
  await c2.page.getByLabel('Coupon code (optional)').fill(code);
  await fillShipping(c2.page);
  await c2.page.getByTestId('checkout-button').click();
  await c2.page.waitForURL(/\/sandbox\/checkout\//);
  await expect(c2.page.getByText('Coupon discount')).toBeVisible();
  await c2.page.getByRole('button', { name: /^Pay \$9\.50/ }).click();
  await c2.page.waitForURL(/\/me\?tab=orders/);
  await expect(c2.page.getByTestId('order-row').first()).toContainText('coupon');
  await c2.page.goto('/me?tab=rewards');
  await expect(c2.page.getByTestId('reward-card').filter({ hasText: title })).toContainText('EXHAUSTED');
  void lip;

  await api(admin.req, 'post', '/v1/admin/sandbox/clock', { offsetMs: 0 });
});
