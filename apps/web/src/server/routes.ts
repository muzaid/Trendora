import 'server-only';
import { z } from 'zod';
import * as api from '@trendora/contracts';
import { AppError, buildOpenApi } from '@trendora/contracts';
import {
  identity, catalog, checkout, payments, orders, campaigns, entries, engagement, ranking, rewards, trust, analytics, agents, coupons,
  issueToken, tick, drainOutbox,
} from '@trendora/services';
import { fixtureId, SEED_USERS } from '@trendora/services/seed-fixtures';
import { services, settleJobs } from './runtime';
import { SESSION_COOKIE } from './session';
import type { RouteCtx } from './http';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Route { method: Method; pattern: string; handler: (c: RouteCtx) => Promise<unknown>; csrf?: boolean }

const S = () => services();
const idemKey = (c: RouteCtx) => c.req.headers.get('idempotency-key');
const Id = z.uuid();
const p = (c: RouteCtx, k: string) => Id.parse(c.params[k]);

/** Store API key (Bearer trk_…) for the merchant's own systems, else the signed-in staff member. */
async function redeemer(c: RouteCtx) {
  const bearer = c.req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const storeId = p(c, 'storeId');
  if (!bearer?.startsWith('trk_') && c.actor === null) throw new AppError('UNAUTHENTICATED', 'Sign in or use a store API key');
  if (!bearer?.startsWith('trk_')) {
    // Cookie-authenticated staff: same-origin check (CSRF) since this route opts out globally for API-key callers.
    const origin = c.req.headers.get('origin');
    const host = c.req.headers.get('x-forwarded-host') ?? c.req.headers.get('host');
    if (!c.req.headers.get('authorization') && (!origin || new URL(origin).host !== host)) throw new AppError('FORBIDDEN', 'Cross-site request blocked');
  }
  return coupons.resolveRedeemer(S(), c.actor, bearer, storeId);
}

async function runTick(c: RouteCtx) {
  const s = S();
  const secret = process.env.CRON_SECRET;
  const ok = (secret && c.req.headers.get('authorization') === `Bearer ${secret}`) || c.actor?.platformRoles.includes('ADMIN');
  if (!ok) throw new AppError('FORBIDDEN', 'Not allowed');
  const r = await tick(s);
  const processed = await drainOutbox(s);
  return { ...r, processed };
}

const routes: Route[] = [
  // ---- Platform -------------------------------------------------------------
  { method: 'GET', pattern: '/v1/health', handler: async () => ({ ok: true, sandbox: S().config.SANDBOX_MODE, time: S().clock.now().toISOString() }) },
  { method: 'GET', pattern: '/v1/openapi.json', handler: async () => buildOpenApi() },

  // ---- Auth -----------------------------------------------------------------
  {
    method: 'GET', pattern: '/v1/auth/sandbox-users',
    handler: async () => {
      if (!S().config.SANDBOX_MODE) throw new AppError('NOT_FOUND', 'Not available');
      return SEED_USERS.map((u) => ({ handle: u.handle, name: u.name, roles: u.roles }));
    },
  },
  {
    method: 'POST', pattern: '/v1/auth/sandbox-login',
    handler: async (c) => {
      const s = S();
      if (!s.config.SANDBOX_MODE) throw new AppError('NOT_FOUND', 'Not available');
      const { handle } = await c.body(api.SandboxLoginBody);
      const id = fixtureId(handle);
      const actor = await identity.loadActor(s.db, id);
      if (!actor) throw new AppError('NOT_FOUND', 'Sandbox user not found — run pnpm db:seed');
      const token = await issueToken(s.config.AUTH_JWT_SECRET, s.config.AUTH_JWT_ISSUER, { sub: id, aal: 'aal2' });
      c.setCookie = { name: SESSION_COOKIE, value: token, maxAge: 43_200 };
      return { token, user: { id, handle: actor.handle, displayName: actor.displayName }, sandbox: true };
    },
  },
  { method: 'POST', pattern: '/v1/auth/logout', handler: async (c) => { c.setCookie = { name: SESSION_COOKIE, value: '', maxAge: 0 }; return { ok: true }; } },
  {
    method: 'POST', pattern: '/v1/auth/profile',
    handler: async (c) => {
      // First sign-in with Supabase Auth: create the profile row for the authenticated user.
      const bearer = c.req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      const s = S();
      const { verifyToken } = await import('@trendora/services');
      const claims = bearer ? await verifyToken(bearer, { secret: s.config.AUTH_JWT_SECRET, issuer: s.config.AUTH_JWT_ISSUER, supabaseSecret: s.config.SUPABASE_JWT_SECRET, supabaseUrl: s.config.SUPABASE_URL }) : null;
      if (!claims) throw new AppError('UNAUTHENTICATED', 'Sign in required');
      const body = await c.body(z.object({ handle: z.string().regex(/^[a-z0-9_]{3,30}$/), displayName: z.string().min(1).max(80), country: z.string().length(2), birthYear: z.number().int().min(1900).max(2100) }));
      await identity.bootstrapProfile(s, claims.sub, body);
      return { ok: true };
    },
  },

  // ---- Public discovery -----------------------------------------------------
  { method: 'GET', pattern: '/v1/feed', handler: async (c) => { const q = c.query(api.CursorQuery.extend({ campaignId: z.uuid().optional() })); return engagement.feed(S(), c.actor, q.cursor, q.limit, q.campaignId); } },
  { method: 'GET', pattern: '/v1/stores/:slug', handler: async (c) => catalog.publicStore(S(), z.string().max(60).parse(c.params.slug)) },
  { method: 'GET', pattern: '/v1/products/:id', handler: async (c) => catalog.publicProduct(S(), p(c, 'id')) },
  { method: 'GET', pattern: '/v1/campaigns/:id', handler: async (c) => campaigns.publicCampaign(S(), p(c, 'id'), c.actor) },
  { method: 'GET', pattern: '/v1/campaigns/:id/leaderboard', handler: async (c) => { const q = c.query(api.CursorQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) })); return ranking.leaderboard(S(), p(c, 'id'), q.cursor, q.limit); } },
  { method: 'POST', pattern: '/v1/campaigns/:id/alternative-entry', handler: async (c) => campaigns.requestAlternativeEntry(S(), c.actor, p(c, 'id'), (await c.body(api.AlternativeEntryBody)).statement) },
  { method: 'GET', pattern: '/v1/entries/:id', handler: async (c) => engagement.entryDetail(S(), c.actor, p(c, 'id')) },

  // ---- Commerce -------------------------------------------------------------
  { method: 'POST', pattern: '/v1/checkouts', handler: async (c) => checkout.createCheckout(S(), c.actor, await c.body(api.CreateCheckoutBody), idemKey(c)) },
  { method: 'POST', pattern: '/v1/webhooks/:provider', csrf: false, handler: async (c) => payments.ingestWebhook(S(), z.string().max(40).parse(c.params.provider), await c.req.text(), c.req.headers) },
  { method: 'GET', pattern: '/v1/sandbox/checkouts/:id', handler: async (c) => checkout.sandboxCheckoutView(S(), c.actor, p(c, 'id')) },
  {
    method: 'POST', pattern: '/v1/sandbox/checkouts/:id/pay',
    handler: async (c) => {
      const r = await payments.sandboxPay(S(), c.actor, p(c, 'id'), (await c.body(api.SandboxPayBody)).outcome);
      await settleJobs();
      return r;
    },
  },

  // ---- Creator --------------------------------------------------------------
  { method: 'POST', pattern: '/v1/entries', handler: async (c) => entries.createEntry(S(), c.actor, await c.body(api.CreateEntryBody)) },
  { method: 'POST', pattern: '/v1/entries/:id/upload-url', handler: async (c) => entries.renewUploadUrl(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/entries/:id/submit', handler: async (c) => entries.submitEntry(S(), c.actor, p(c, 'id'), (await c.body(api.SubmitEntryBody)).caption) },
  { method: 'PATCH', pattern: '/v1/entries/:id', handler: async (c) => entries.editEntry(S(), c.actor, p(c, 'id'), (await c.body(z.object({ caption: z.string().max(300) }))).caption) },
  { method: 'POST', pattern: '/v1/entries/:id/withdraw', handler: async (c) => entries.withdrawEntry(S(), c.actor, p(c, 'id')) },
  {
    method: 'PUT', pattern: '/v1/uploads/:token', csrf: false,
    handler: async (c) => {
      const len = Number(c.req.headers.get('content-length') ?? 0);
      if (len > 250 * 1024 * 1024) throw new AppError('INVALID_INPUT', 'Upload too large');
      const r = await entries.receiveUpload(S(), z.string().max(400).parse(c.params.token), Buffer.from(await c.req.arrayBuffer()), c.req.headers.get('content-type') ?? 'application/octet-stream');
      await settleJobs();
      return r;
    },
  },
  {
    method: 'GET', pattern: '/v1/media/:token',
    handler: async (c) => {
      const media = await entries.readPlayback(S(), z.string().max(400).parse(c.params.token));
      const range = c.req.headers.get('range');
      const total = media.data.length;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m?.[1] ? Number(m[1]) : 0;
        const end = m?.[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        return new Response(new Uint8Array(media.data.subarray(start, end + 1)), { status: 206, headers: { 'content-type': media.contentType, 'content-range': `bytes ${start}-${end}/${total}`, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'cache-control': 'private, max-age=3600' } });
      }
      return new Response(new Uint8Array(media.data), { headers: { 'content-type': media.contentType, 'accept-ranges': 'bytes', 'content-length': String(total), 'cache-control': 'private, max-age=3600' } });
    },
  },

  // ---- Engagement -----------------------------------------------------------
  { method: 'PUT', pattern: '/v1/entries/:id/like', handler: async (c) => engagement.setLike(S(), c.actor, p(c, 'id'), (await c.body(api.LikeBody)).active, c.meta) },
  { method: 'POST', pattern: '/v1/entries/:id/share', handler: async (c) => { const r = await engagement.createShareLink(S(), c.actor, p(c, 'id')); return { url: r.url }; } },
  { method: 'POST', pattern: '/v1/entries/:id/events', handler: async (c) => engagement.recordView(S(), c.actor, p(c, 'id'), await c.body(api.EngagementBody), c.meta) },
  { method: 'POST', pattern: '/v1/entries/:id/comments', handler: async (c) => engagement.addComment(S(), c.actor, p(c, 'id'), (await c.body(api.CommentBody)).body, c.meta) },
  { method: 'POST', pattern: '/v1/entries/:id/follow', handler: async (c) => engagement.followCreator(S(), c.actor, p(c, 'id'), c.meta) },
  { method: 'POST', pattern: '/v1/share-visits', handler: async (c) => engagement.recordShareVisit(S(), c.actor, (await c.body(api.ShareVisitBody)).token, c.meta) },

  // ---- Me -------------------------------------------------------------------
  { method: 'GET', pattern: '/v1/me', handler: async (c) => identity.me(S(), c.actor) },
  { method: 'PATCH', pattern: '/v1/me', handler: async (c) => identity.updateProfile(S(), c.actor, await c.body(api.ProfilePatchBody)) },
  { method: 'GET', pattern: '/v1/me/orders', handler: async (c) => orders.myOrders(S(), c.actor) },
  { method: 'GET', pattern: '/v1/me/entitlements', handler: async (c) => entries.myEntitlements(S(), c.actor) },
  { method: 'GET', pattern: '/v1/me/entries', handler: async (c) => entries.myEntries(S(), c.actor) },
  { method: 'GET', pattern: '/v1/me/rewards', handler: async (c) => rewards.myRewards(S(), c.actor) },
  { method: 'GET', pattern: '/v1/me/notifications', handler: async (c) => identity.listNotifications(S(), c.actor) },
  { method: 'GET', pattern: '/v1/me/appeals', handler: async (c) => trust.myAppeals(S(), c.actor) },
  { method: 'POST', pattern: '/v1/rewards/:id/claim', handler: async (c) => rewards.claimReward(S(), c.actor, p(c, 'id'), await c.body(api.ClaimRewardBody)) },
  { method: 'POST', pattern: '/v1/appeals', handler: async (c) => trust.fileAppeal(S(), c.actor, await c.body(api.AppealBody)) },
  { method: 'POST', pattern: '/v1/reports', handler: async (c) => trust.fileReport(S(), c.actor, await c.body(api.ReportBody)) },
  { method: 'POST', pattern: '/v1/blocks', handler: async (c) => trust.blockUser(S(), c.actor, (await c.body(z.object({ handle: z.string().min(3).max(30) }))).handle) },

  // ---- Merchant -------------------------------------------------------------
  { method: 'GET', pattern: '/v1/merchant/context', handler: async (c) => catalog.merchantContext(S(), c.actor) },
  { method: 'POST', pattern: '/v1/merchant/onboard', handler: async (c) => catalog.onboardMerchant(S(), c.actor, await c.body(api.OnboardBody)) },
  { method: 'GET', pattern: '/v1/merchant/orgs/:id/staff', handler: async (c) => catalog.listStaff(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/orgs/:id/staff', handler: async (c) => catalog.addStaff(S(), c.actor, p(c, 'id'), await c.body(api.MembershipBody)) },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/catalog', handler: async (c) => catalog.merchantCatalog(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/products', handler: async (c) => catalog.createProduct(S(), c.actor, await c.body(api.ProductBody)) },
  { method: 'PATCH', pattern: '/v1/merchant/products/:id', handler: async (c) => catalog.setProductStatus(S(), c.actor, p(c, 'id'), (await c.body(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) }))).status) },
  { method: 'PUT', pattern: '/v1/merchant/variants/:id/price', handler: async (c) => catalog.updatePrice(S(), c.actor, p(c, 'id'), (await c.body(api.PriceBody)).priceMinor) },
  { method: 'POST', pattern: '/v1/merchant/variants/:id/inventory', handler: async (c) => { const b = await c.body(api.InventoryAdjustBody); return catalog.adjustInventory(S(), c.actor, p(c, 'id'), b.delta, b.expectedVersion); } },
  { method: 'POST', pattern: '/v1/merchant/catalog/import', handler: async (c) => { const b = await c.body(api.CsvImportBody); return catalog.importCsv(S(), c.actor, b.storeId, b.csv); } },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/orders', handler: async (c) => orders.merchantOrders(S(), c.actor, p(c, 'id'), c.url.searchParams.get('status') ?? undefined) },
  { method: 'POST', pattern: '/v1/merchant/orders/:id/transition', handler: async (c) => { const r = await orders.transitionOrder(S(), c.actor, p(c, 'id'), await c.body(api.OrderTransitionBody)); await settleJobs(); return r; } },
  { method: 'POST', pattern: '/v1/merchant/orders/:id/refunds', handler: async (c) => { const r = await payments.requestRefund(S(), c.actor, p(c, 'id'), await c.body(api.RefundBody)); await new Promise((res) => setTimeout(res, 50)); await settleJobs(); return r; } },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/campaigns', handler: async (c) => campaigns.merchantCampaigns(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/campaigns', handler: async (c) => campaigns.createCampaignDraft(S(), c.actor, await c.body(api.CampaignDraftBody)) },
  { method: 'GET', pattern: '/v1/merchant/campaigns/:id', handler: async (c) => campaigns.merchantCampaign(S(), c.actor, p(c, 'id')) },
  { method: 'PATCH', pattern: '/v1/merchant/campaigns/:id', handler: async (c) => campaigns.updateCampaignDraft(S(), c.actor, p(c, 'id'), await c.body(api.CampaignPatchBody)) },
  { method: 'POST', pattern: '/v1/merchant/campaigns/:id/publish', handler: async (c) => campaigns.submitForReview(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/campaigns/:id/cancel', handler: async (c) => campaigns.cancelCampaign(S(), c.actor, p(c, 'id'), (await c.body(api.ReasonBody)).reason) },
  { method: 'POST', pattern: '/v1/merchant/campaigns/:id/funding', handler: async (c) => campaigns.submitFunding(S(), c.actor, p(c, 'id'), await c.body(api.FundingBody)) },
  { method: 'GET', pattern: '/v1/merchant/campaigns/:id/analytics', handler: async (c) => analytics.campaignAnalytics(S(), c.actor, p(c, 'id')) },
  { method: 'GET', pattern: '/v1/merchant/campaigns/:id/model', handler: async (c) => { const q = c.query(z.object({ unitCostMinor: z.coerce.number().int().min(0).default(2000), otherCostsMinor: z.coerce.number().int().min(0).default(0) })); return analytics.campaignModel(S(), c.actor, p(c, 'id'), q.unitCostMinor, q.otherCostsMinor); } },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/rewards', handler: async (c) => rewards.merchantRewards(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/rewards/:id/fulfill', handler: async (c) => rewards.fulfillReward(S(), c.actor, p(c, 'id'), await c.body(api.FulfillRewardBody)) },

  // ---- Direct coupon redemption (store staff session or store API key `Bearer trk_…`) ----
  { method: 'POST', pattern: '/v1/stores/:storeId/coupons/lookup', csrf: false, handler: async (c) => { const r = await redeemer(c); const b = await c.body(api.CouponLookupBody.extend({ purchaseMinor: z.number().int().min(1).optional(), eligibleMinor: z.number().int().min(1).optional() })); return coupons.lookupCoupon(S(), r, b); } },
  { method: 'POST', pattern: '/v1/stores/:storeId/coupons/redeem', csrf: false, handler: async (c) => coupons.redeemDirect(S(), await redeemer(c), await c.body(api.DirectRedeemBody)) },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/coupon-redemptions', handler: async (c) => coupons.listDirectRedemptions(S(), c.actor, p(c, 'id')) },
  { method: 'GET', pattern: '/v1/merchant/stores/:id/api-keys', handler: async (c) => coupons.listStoreApiKeys(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/merchant/stores/:id/api-keys', handler: async (c) => coupons.createStoreApiKey(S(), c.actor, p(c, 'id'), (await c.body(api.StoreApiKeyBody)).name) },
  { method: 'POST', pattern: '/v1/merchant/api-keys/:id/revoke', handler: async (c) => coupons.revokeStoreApiKey(S(), c.actor, p(c, 'id')) },

  // ---- AI agents (optional, advisory) ----------------------------------------
  { method: 'POST', pattern: '/v1/agents/runs', handler: async (c) => agents.runAgent(S(), c.actor, await c.body(api.AgentRunBody)) },
  { method: 'GET', pattern: '/v1/agents/runs', handler: async (c) => agents.listAgentRuns(S(), c.actor, c.url.searchParams.get('orgId') ?? undefined) },
  { method: 'POST', pattern: '/v1/agents/runs/:id/decision', handler: async (c) => agents.decideAgentRun(S(), c.actor, p(c, 'id'), (await c.body(api.AgentDecisionBody)).decision) },

  // ---- Platform administration (server-authorized) ---------------------------
  { method: 'GET', pattern: '/v1/admin/organizations', handler: async (c) => trust.pendingOrganizations(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/organizations/:id/decision', handler: async (c) => { const b = await c.body(api.OrgDecisionBody); return trust.decideOrganization(S(), c.actor, p(c, 'id'), b.decision, b.notes); } },
  { method: 'GET', pattern: '/v1/admin/campaigns', handler: async (c) => trust.campaignAdminQueue(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/review', handler: async (c) => { const b = await c.body(api.CampaignReviewBody); return campaigns.reviewCampaign(S(), c.actor, p(c, 'id'), b.decision, b.notes); } },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/funding', handler: async (c) => { const b = await c.body(z.object({ verified: z.boolean(), reason: z.string().min(3).max(1000) })); return campaigns.verifyFunding(S(), c.actor, p(c, 'id'), b.verified, b.reason); } },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/freeze', handler: async (c) => { const b = await c.body(api.KillSwitchBody); return trust.setCampaignFrozen(S(), c.actor, p(c, 'id'), b.frozen, b.reason); } },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/amend', handler: async (c) => campaigns.amendCampaign(S(), c.actor, p(c, 'id'), await c.body(z.object({ reason: z.string().min(5).max(2000), participantRemedy: z.string().min(5).max(2000), submissionEnd: z.iso.datetime({ offset: true }).optional(), voteEnd: z.iso.datetime({ offset: true }).optional(), appealDeadline: z.iso.datetime({ offset: true }).optional() }))) },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/cancel', handler: async (c) => campaigns.cancelCampaign(S(), c.actor, p(c, 'id'), (await c.body(api.ReasonBody)).reason) },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/start-review', handler: async (c) => ranking.startReview(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/snapshots', handler: async (c) => { identity.requirePlatform(S(), c.actor, 'moderation'); const b = await c.body(api.SnapshotBody); return ranking.createSnapshot(S(), p(c, 'id'), { cutoff: b.cutoff ? new Date(b.cutoff) : undefined, actorId: c.actor!.userId }); } },
  { method: 'GET', pattern: '/v1/admin/campaigns/:id/readiness', handler: async (c) => ranking.finalizationReadiness(S(), c.actor, p(c, 'id')) },
  { method: 'POST', pattern: '/v1/admin/campaigns/:id/finalize', handler: async (c) => { const r = await ranking.finalizeCampaign(S(), c.actor, p(c, 'id'), await c.body(api.FinalizeBody), idemKey(c)); await settleJobs(); return r; } },
  { method: 'GET', pattern: '/v1/admin/moderation', handler: async (c) => entries.moderationQueue(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/entries/:id/moderate', handler: async (c) => { const b = await c.body(api.ModerationBody); return entries.moderateEntry(S(), c.actor, p(c, 'id'), b.decision, b.reason); } },
  { method: 'GET', pattern: '/v1/admin/rubric', handler: async (c) => ranking.rubricQueue(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/entries/:id/rubric', handler: async (c) => ranking.scoreRubric(S(), c.actor, p(c, 'id'), await c.body(api.RubricBody)) },
  { method: 'GET', pattern: '/v1/admin/reports', handler: async (c) => trust.listReports(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/reports/:id/decision', handler: async (c) => { const b = await c.body(api.ReportDecisionBody); return trust.decideReport(S(), c.actor, p(c, 'id'), b.decision, b.resolution); } },
  { method: 'GET', pattern: '/v1/admin/appeals', handler: async (c) => trust.listAppeals(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/appeals/:id/decision', handler: async (c) => { const b = await c.body(api.AppealDecisionBody); return trust.decideAppeal(S(), c.actor, p(c, 'id'), b.decision, b.resolution); } },
  { method: 'GET', pattern: '/v1/admin/flags', handler: async (c) => trust.listFlags(S(), c.actor, c.url.searchParams.get('campaignId') ?? undefined) },
  { method: 'POST', pattern: '/v1/admin/flags/:id/resolve', handler: async (c) => { const b = await c.body(z.object({ decision: z.enum(['CONFIRMED', 'DISMISSED']), reason: z.string().min(5).max(1000) })); return trust.resolveFlag(S(), c.actor, p(c, 'id'), b.decision, b.reason); } },
  { method: 'GET', pattern: '/v1/admin/alternative-entries', handler: async (c) => trust.pendingAlternativeEntries(S(), c.actor) },
  { method: 'POST', pattern: '/v1/admin/alternative-entries/:id/decision', handler: async (c) => campaigns.decideAlternativeEntry(S(), c.actor, p(c, 'id'), (await c.body(api.AlternativeDecisionBody)).decision) },
  { method: 'POST', pattern: '/v1/admin/kill-switch', handler: async (c) => trust.setPlatformKillSwitch(S(), c.actor, await c.body(z.object({ commerceFrozen: z.boolean().optional(), payoutsFrozen: z.boolean().optional(), reason: z.string().min(5).max(1000) }))) },
  { method: 'GET', pattern: '/v1/admin/audit', handler: async (c) => trust.auditLog(S(), c.actor, { targetId: c.url.searchParams.get('targetId') ?? undefined }) },
  { method: 'POST', pattern: '/v1/admin/users/:handle/suspend', handler: async (c) => { const b = await c.body(z.object({ suspended: z.boolean(), reason: z.string().min(5).max(1000) })); return trust.suspendUser(S(), c.actor, z.string().max(30).parse(c.params.handle), b.suspended, b.reason); } },
  { method: 'GET', pattern: '/v1/admin/reconciliation', handler: async (c) => payments.reconcile(S(), c.actor) },
  {
    method: 'POST', pattern: '/v1/admin/sandbox/clock',
    handler: async (c) => {
      const s = S();
      const r = await trust.setSandboxClock(s, c.actor, (await c.body(api.ClockBody)).offsetMs);
      await s.dbClock?.refresh(true);
      await tick(s);
      await drainOutbox(s);
      return r;
    },
  },
  // Cron entry point (Vercel Cron sends GET with CRON_SECRET; schedulers may POST). Requires CRON_SECRET or an admin session.
  { method: 'GET', pattern: '/v1/jobs/tick', csrf: false, handler: (c) => runTick(c) },
  { method: 'POST', pattern: '/v1/jobs/tick', csrf: false, handler: (c) => runTick(c) },
];

const compiled = routes.map((r) => {
  const keys: string[] = [];
  const re = new RegExp('^' + r.pattern.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { ...r, re, keys };
});

export function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
  const allowed: string[] = [];
  for (const r of compiled) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== method) { allowed.push(r.method); continue; }
    return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
  }
  return allowed.length ? { allowed } : null;
}
