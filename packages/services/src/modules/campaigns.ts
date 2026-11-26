import { conflict, forbidden, ineligible, invalid, notFound, CampaignRulesSchema, type CampaignDraftInput, type CampaignDto, type PrizeTierInputT } from '@trendora/contracts';
import { campaignMachine, canonicalJson, requiredPrizeFunding, sha256Hex, timeDrivenStatus, validateTiers, participantIneligibility, INELIGIBLE_MESSAGES } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, enqueue, iso, notify } from '../ops';
import { requireActor, requirePlatform, requireStoreMember, requireStorePermission, storeOrg } from './identity';
import { loadCampaign, times, type CampaignRow } from './campaign-data';

function validateDates(i: { startsAt: string; submissionEnd: string; voteEnd: string; appealDeadline: string }) {
  const [s, se, ve, ad] = [i.startsAt, i.submissionEnd, i.voteEnd, i.appealDeadline].map((d) => new Date(d).getTime()) as [number, number, number, number];
  if (!(s < se && se <= ve && ve <= ad)) throw invalid('Dates must satisfy start < submission end ≤ vote end ≤ appeal deadline');
}

async function validateSkus(q: Q, storeId: string, skus: { variantId: string; offerMinor: number }[]) {
  const rows = await q.query<{ id: string; price_minor: number }>(
    `select v.id, v.price_minor from variants v join products p on p.id = v.product_id where v.id = any($1) and p.store_id = $2`,
    [skus.map((s) => s.variantId), storeId],
  );
  if (rows.length !== new Set(skus.map((s) => s.variantId)).size) throw invalid('All campaign SKUs must belong to this store');
  for (const s of skus) {
    const v = rows.find((r) => r.id === s.variantId)!;
    if (s.offerMinor > v.price_minor) throw invalid('Campaign offer price cannot exceed the regular price');
  }
}

async function writeChildren(q: Q, campaignId: string, input: { skus: CampaignDraftInput['skus']; prizeTiers: PrizeTierInputT[] }) {
  await q.query(`delete from campaign_skus where campaign_id = $1`, [campaignId]);
  await q.query(`delete from prize_tiers where campaign_id = $1`, [campaignId]);
  for (const s of input.skus) await q.query(`insert into campaign_skus (campaign_id, variant_id, required_qty, offer_minor) values ($1,$2,$3,$4)`, [campaignId, s.variantId, s.requiredQty, s.offerMinor]);
  for (const t of input.prizeTiers) {
    await q.query(
      `insert into prize_tiers (campaign_id, rank_from, rank_to, type, title, value_minor, percent_off) values ($1,$2,$3,$4,$5,$6,$7)`,
      [campaignId, t.rankFrom, t.rankTo, t.type, t.title, t.valueMinor, t.percentOff],
    );
  }
}

export async function createCampaignDraft(ctx: ServiceContext, actor: Actor | null, input: CampaignDraftInput) {
  const { actor: a, store } = await requireStorePermission(ctx.db, actor, input.storeId, 'campaigns.write');
  validateDates(input);
  validateTiers(input.prizeTiers);
  return ctx.db.tx(async (q) => {
    await validateSkus(q, input.storeId, input.skus);
    const c = await q.one<{ id: string }>(
      `insert into campaigns (store_id, title, tagline, description, starts_at, submission_end, vote_end, appeal_deadline, display_timezone, currency, inventory_cap, rules, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [input.storeId, input.title, input.tagline, input.description, input.startsAt, input.submissionEnd, input.voteEnd, input.appealDeadline, input.displayTimezone, store.currency, input.inventoryCap, JSON.stringify(input.rules), a.userId],
    );
    await writeChildren(q, c.id, input);
    await enqueue(q, 'campaign.draft.created', { campaignId: c.id }, { dedupeKey: `campaign.draft.created:${c.id}` });
    await audit(q, { actorId: a.userId, action: 'campaign.draft_created', targetType: 'campaign', targetId: c.id });
    return { campaignId: c.id, version: 1 };
  });
}

/** PATCH with optimistic concurrency (expectedVersion). Only DRAFT campaigns are editable. */
export async function updateCampaignDraft(ctx: ServiceContext, actor: Actor | null, campaignId: string, patch: Partial<Omit<CampaignDraftInput, 'storeId'>> & { expectedVersion: number }) {
  const cur = await loadCampaign(ctx.db, campaignId);
  const { actor: a } = await requireStorePermission(ctx.db, actor, cur.store_id, 'campaigns.write');
  return ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    if (c.version !== patch.expectedVersion) throw conflict('Campaign was modified by someone else; reload and retry', { currentVersion: c.version });
    if (c.status !== 'DRAFT') throw conflict('Published campaign rules are immutable; request an amendment instead');
    const merged = {
      startsAt: patch.startsAt ?? iso(c.starts_at)!, submissionEnd: patch.submissionEnd ?? iso(c.submission_end)!,
      voteEnd: patch.voteEnd ?? iso(c.vote_end)!, appealDeadline: patch.appealDeadline ?? iso(c.appeal_deadline)!,
    };
    validateDates(merged);
    if (patch.prizeTiers) validateTiers(patch.prizeTiers);
    if (patch.skus) await validateSkus(q, c.store_id, patch.skus);
    await q.query(
      `update campaigns set title = coalesce($2,title), tagline = coalesce($3,tagline), description = coalesce($4,description),
         starts_at = $5, submission_end = $6, vote_end = $7, appeal_deadline = $8, display_timezone = coalesce($9,display_timezone),
         inventory_cap = coalesce($10,inventory_cap), rules = coalesce($11::jsonb, rules), version = version + 1, updated_at = now()
       where id = $1`,
      [campaignId, patch.title ?? null, patch.tagline ?? null, patch.description ?? null, merged.startsAt, merged.submissionEnd, merged.voteEnd, merged.appealDeadline, patch.displayTimezone ?? null, patch.inventoryCap ?? null, patch.rules ? JSON.stringify(patch.rules) : null],
    );
    if (patch.skus || patch.prizeTiers) {
      const skus = patch.skus ?? (await q.query<{ variant_id: string; required_qty: number; offer_minor: number }>(`select * from campaign_skus where campaign_id = $1`, [campaignId])).map((s) => ({ variantId: s.variant_id, requiredQty: s.required_qty, offerMinor: s.offer_minor }));
      const tiers = patch.prizeTiers ?? (await tiersOf(q, campaignId)).map((t) => ({ rankFrom: t.rankFrom, rankTo: t.rankTo, type: t.type, title: t.title, valueMinor: t.valueMinor, percentOff: t.percentOff }));
      await writeChildren(q, campaignId, { skus, prizeTiers: tiers });
    }
    await audit(q, { actorId: a.userId, action: 'campaign.draft_updated', targetType: 'campaign', targetId: campaignId });
    return { campaignId, version: c.version + 1 };
  });
}

export async function tiersOf(q: Q, campaignId: string) {
  const rows = await q.query<{ id: string; rank_from: number; rank_to: number | null; type: 'PRIZE' | 'COUPON'; title: string; value_minor: number; percent_off: number | null }>(
    `select id, rank_from, rank_to, type, title, value_minor, percent_off from prize_tiers where campaign_id = $1 order by rank_from`,
    [campaignId],
  );
  return rows.map((t) => ({ id: t.id, rankFrom: t.rank_from, rankTo: t.rank_to, type: t.type, title: t.title, valueMinor: t.value_minor, percentOff: t.percent_off }));
}

/** Deterministic publish checks (spec §5 launch checklist, §14 campaign.draft.created). */
export async function launchChecklist(q: Q, c: CampaignRow, now: Date) {
  const store = await storeOrg(q, c.store_id);
  const tiers = await tiersOf(q, c.id);
  const skus = await q.query<{ variant_id: string; available: number; active: boolean }>(
    `select cs.variant_id, coalesce(i.available,0) as available, (v.status = 'ACTIVE' and p.status = 'ACTIVE') as active
     from campaign_skus cs join variants v on v.id = cs.variant_id join products p on p.id = v.product_id left join inventory i on i.variant_id = v.id where cs.campaign_id = $1`,
    [c.id],
  );
  const rulesOk = CampaignRulesSchema.safeParse(c.rules).success;
  let tiersOk = true;
  try { validateTiers(tiers); } catch { tiersOk = false; }
  const totalStock = skus.reduce((s, k) => s + k.available, 0);
  const items = [
    { key: 'org_verified', label: 'Merchant business is verified', ok: store.verification === 'VERIFIED' },
    { key: 'store_active', label: 'Store is active', ok: store.status === 'ACTIVE' },
    { key: 'skus_active', label: 'Campaign SKUs are active', ok: skus.length > 0 && skus.every((s) => s.active) },
    { key: 'inventory', label: `Inventory covers the cap (${totalStock} available / cap ${c.inventory_cap})`, ok: totalStock >= c.inventory_cap },
    { key: 'tiers', label: 'Prize tiers are contiguous and valid', ok: tiersOk },
    { key: 'funding', label: `Prize funding verified (${requiredPrizeFunding(tiers)} minor units required)`, ok: c.funding_status === 'VERIFIED' },
    { key: 'rules', label: 'Rules, scoring weights and disclosures are complete', ok: rulesOk },
    { key: 'dates', label: 'Start date is in the future', ok: new Date(c.starts_at) > now || c.status !== 'DRAFT' },
    { key: 'free_entry', label: 'Free alternative entry offered', ok: c.rules.eligibility?.alternativeEntry === true },
  ];
  return { ready: items.every((i) => i.ok), items };
}

/** POST /v1/merchant/campaigns/:id/publish — requests platform review. */
export async function submitForReview(ctx: ServiceContext, actor: Actor | null, campaignId: string) {
  const cur = await loadCampaign(ctx.db, campaignId);
  const { actor: a } = await requireStorePermission(ctx.db, actor, cur.store_id, 'campaigns.publish');
  return ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    campaignMachine.assert(c.status, 'REVIEW');
    const check = await launchChecklist(q, c, ctx.clock.now());
    const blocking = check.items.filter((i) => !i.ok && i.key !== 'org_verified' && i.key !== 'funding');
    if (blocking.length) throw ineligible('Launch checklist incomplete', { failing: blocking.map((b) => b.key) });
    await q.query(`update campaigns set status = 'REVIEW', version = version + 1, updated_at = now() where id = $1`, [campaignId]);
    await audit(q, { actorId: a.userId, action: 'campaign.submitted_for_review', targetType: 'campaign', targetId: campaignId });
    return { status: 'REVIEW' };
  });
}

/** Merchant submits prize funding evidence; finance verifies it. */
export async function submitFunding(ctx: ServiceContext, actor: Actor | null, campaignId: string, input: { method: string; reference: string; amountMinor: number }) {
  const cur = await loadCampaign(ctx.db, campaignId);
  const { actor: a } = await requireStorePermission(ctx.db, actor, cur.store_id, 'campaigns.publish');
  const required = requiredPrizeFunding(await tiersOf(ctx.db, campaignId));
  if (input.amountMinor < required) throw invalid(`Funding must cover the total prize value (${required})`);
  await ctx.db.tx(async (q) => {
    await q.query(`update campaigns set funding_status = 'PENDING', funding_evidence = $2 where id = $1 and status in ('DRAFT','REVIEW')`, [campaignId, JSON.stringify({ ...input, submittedBy: a.userId })]);
    await audit(q, { actorId: a.userId, action: 'campaign.funding_submitted', targetType: 'campaign', targetId: campaignId, metadata: input });
  });
  return { fundingStatus: 'PENDING', requiredMinor: required };
}

export async function verifyFunding(ctx: ServiceContext, actor: Actor | null, campaignId: string, verified: boolean, reason: string) {
  const a = requirePlatform(ctx, actor, 'finance');
  await ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    if (c.funding_status !== 'PENDING') throw conflict('No funding evidence pending');
    await q.query(`update campaigns set funding_status = $2 where id = $1`, [campaignId, verified ? 'VERIFIED' : 'FAILED']);
    await audit(q, { actorId: a.userId, action: verified ? 'campaign.funding_verified' : 'campaign.funding_failed', targetType: 'campaign', targetId: campaignId, reason });
  });
  return { fundingStatus: verified ? 'VERIFIED' : 'FAILED' };
}

export function rulesSnapshot(c: CampaignRow, tiers: Awaited<ReturnType<typeof tiersOf>>, skus: unknown[]) {
  const doc = {
    rules: c.rules, prizeTiers: tiers.map(({ id: _id, ...t }) => t), skus,
    dates: { startsAt: iso(c.starts_at), submissionEnd: iso(c.submission_end), voteEnd: iso(c.vote_end), appealDeadline: iso(c.appeal_deadline) },
    inventoryCap: c.inventory_cap,
  };
  return { doc, hash: sha256Hex(canonicalJson(doc)) };
}

/** Platform review: approval freezes an immutable hashed rules version and schedules the campaign. */
export async function reviewCampaign(ctx: ServiceContext, actor: Actor | null, campaignId: string, decision: 'APPROVE' | 'REJECT', notes: string) {
  const a = requirePlatform(ctx, actor, 'admin');
  const result = await ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    if (c.status !== 'REVIEW') throw conflict('Campaign is not awaiting review');
    if (decision === 'REJECT') {
      await q.query(`update campaigns set status = 'DRAFT', review_notes = $2, version = version + 1 where id = $1`, [campaignId, notes]);
      await audit(q, { actorId: a.userId, action: 'campaign.review_rejected', targetType: 'campaign', targetId: campaignId, reason: notes });
      return { status: 'DRAFT' };
    }
    const check = await launchChecklist(q, c, ctx.clock.now());
    if (!check.ready) throw ineligible('Campaign cannot launch: delay until inventory and prize funding are verified', { failing: check.items.filter((i) => !i.ok).map((i) => i.key) });
    const tiers = await tiersOf(q, campaignId);
    const skus = await q.query(`select variant_id, required_qty, offer_minor from campaign_skus where campaign_id = $1 order by variant_id`, [campaignId]);
    const { doc, hash } = rulesSnapshot(c, tiers, skus);
    await q.query(`insert into campaign_rule_versions (campaign_id, version, rules, rules_hash, reason, approved_by) values ($1,1,$2,$3,$4,$5)`, [campaignId, JSON.stringify(doc), hash, notes, a.userId]);
    const next = timeDrivenStatus('SCHEDULED', times(c), ctx.clock.now());
    await q.query(`update campaigns set status = $2, rules_version = 1, rules_hash = $3, published_at = now(), review_notes = $4, version = version + 1 where id = $1`, [campaignId, next, hash, notes]);
    await audit(q, { actorId: a.userId, action: 'campaign.published', targetType: 'campaign', targetId: campaignId, reason: notes, metadata: { rulesHash: hash } });
    return { status: next, rulesHash: hash };
  });
  return result;
}

/**
 * Material amendments after publication need platform approval and a documented
 * participant remedy. Only deadline extensions are supported (never shortening).
 */
export async function amendCampaign(ctx: ServiceContext, actor: Actor | null, campaignId: string, input: { reason: string; participantRemedy: string; submissionEnd?: string; voteEnd?: string; appealDeadline?: string }) {
  const a = requirePlatform(ctx, actor, 'admin');
  return ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    if (!['SCHEDULED', 'OPEN', 'SUBMISSION_CLOSED'].includes(c.status)) throw conflict('Only live campaigns before voting closes can be amended');
    const next = { submissionEnd: input.submissionEnd ?? iso(c.submission_end)!, voteEnd: input.voteEnd ?? iso(c.vote_end)!, appealDeadline: input.appealDeadline ?? iso(c.appeal_deadline)! };
    if (new Date(next.submissionEnd) < new Date(c.submission_end) || new Date(next.voteEnd) < new Date(c.vote_end)) throw invalid('Amendments may only extend deadlines');
    validateDates({ startsAt: iso(c.starts_at)!, ...next });
    await q.query(`update campaigns set submission_end = $2, vote_end = $3, appeal_deadline = $4, version = version + 1 where id = $1`, [campaignId, next.submissionEnd, next.voteEnd, next.appealDeadline]);
    const updated = await loadCampaign(q, campaignId);
    const tiers = await tiersOf(q, campaignId);
    const skus = await q.query(`select variant_id, required_qty, offer_minor from campaign_skus where campaign_id = $1 order by variant_id`, [campaignId]);
    const { doc, hash } = rulesSnapshot(updated, tiers, skus);
    const version = c.rules_version + 1;
    await q.query(`insert into campaign_rule_versions (campaign_id, version, rules, rules_hash, reason, participant_remedy, approved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [campaignId, version, JSON.stringify(doc), hash, input.reason, input.participantRemedy, a.userId]);
    await q.query(`update campaigns set rules_version = $2, rules_hash = $3 where id = $1`, [campaignId, version, hash]);
    const participants = await q.query<{ user_id: string }>(`select distinct user_id from entitlements where campaign_id = $1`, [campaignId]);
    for (const p of participants) await notify(q, p.user_id, 'campaign.amended', { campaignId, reason: input.reason, remedy: input.participantRemedy });
    await audit(q, { actorId: a.userId, action: 'campaign.amended', targetType: 'campaign', targetId: campaignId, reason: input.reason, metadata: { version, remedy: input.participantRemedy } });
    return { rulesVersion: version, rulesHash: hash };
  });
}

/** Cancel requires a reason; participants are notified and published remedies apply. */
export async function cancelCampaign(ctx: ServiceContext, actor: Actor | null, campaignId: string, reason: string) {
  const cur = await loadCampaign(ctx.db, campaignId);
  let actorId: string;
  if (actor && actor.platformRoles.includes('ADMIN')) actorId = requirePlatform(ctx, actor, 'admin').userId;
  else {
    const { actor: a } = await requireStorePermission(ctx.db, actor, cur.store_id, 'campaigns.publish');
    if (!['DRAFT', 'REVIEW', 'SCHEDULED'].includes(cur.status)) throw forbidden('A live campaign can only be canceled by the platform');
    actorId = a.userId;
  }
  await ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    campaignMachine.assert(c.status, 'CANCELED');
    await q.query(`update campaigns set status = 'CANCELED', cancel_reason = $2, version = version + 1 where id = $1`, [campaignId, reason]);
    const participants = await q.query<{ user_id: string }>(`select distinct user_id from entitlements where campaign_id = $1`, [campaignId]);
    for (const p of participants) await notify(q, p.user_id, 'campaign.canceled', { campaignId, reason, remedy: 'Statutory refund rights apply; contact the store to return your order.' });
    await audit(q, { actorId, action: 'campaign.canceled', targetType: 'campaign', targetId: campaignId, reason });
  });
  return { status: 'CANCELED' };
}

/** Time-driven transitions (job). Lock new actions at the server timestamp. */
export async function advanceCampaignPhases(ctx: ServiceContext): Promise<{ id: string; from: string; to: string }[]> {
  const now = ctx.clock.now();
  const rows = await ctx.db.query<{ id: string }>(`select id from campaigns where status in ('SCHEDULED','OPEN','SUBMISSION_CLOSED')`);
  const changed: { id: string; from: string; to: string }[] = [];
  for (const r of rows) {
    await ctx.db.tx(async (q) => {
      const c = await loadCampaign(q, r.id, { forUpdate: true });
      const target = timeDrivenStatus(c.status, times(c), now);
      if (target === c.status) return;
      await q.query(`update campaigns set status = $2, version = version + 1 where id = $1`, [c.id, target]);
      if (target === 'VOTING_CLOSED') await enqueue(q, 'campaign.voting_closed', { campaignId: c.id }, { dedupeKey: `voting_closed:${c.id}` });
      await audit(q, { actorId: null, action: 'campaign.phase', targetType: 'campaign', targetId: c.id, metadata: { from: c.status, to: target } });
      changed.push({ id: c.id, from: c.status, to: target });
    });
  }
  return changed;
}

export async function campaignDto(q: Q, c: CampaignRow): Promise<CampaignDto> {
  const store = await q.one<{ id: string; slug: string; name: string }>(`select id, slug, name from stores where id = $1`, [c.store_id]);
  const tiers = await tiersOf(q, c.id);
  const skus = await q.query<{ variant_id: string; product_id: string; product_title: string; variant_title: string; required_qty: number; offer_minor: number; price_minor: number }>(
    `select cs.variant_id, p.id as product_id, p.title as product_title, v.title as variant_title, cs.required_qty, cs.offer_minor, v.price_minor
     from campaign_skus cs join variants v on v.id = cs.variant_id join products p on p.id = v.product_id where cs.campaign_id = $1`,
    [c.id],
  );
  const count = await q.one<{ n: number }>(`select count(*)::int as n from entries where campaign_id = $1 and status = 'APPROVED'`, [c.id]);
  return {
    id: c.id, title: c.title, tagline: c.tagline, description: c.description, status: c.status, storeId: c.store_id,
    startsAt: iso(c.starts_at)!, submissionEnd: iso(c.submission_end)!, voteEnd: iso(c.vote_end)!, appealDeadline: iso(c.appeal_deadline)!,
    displayTimezone: c.display_timezone, currency: c.currency, rules: c.rules, rulesVersion: c.rules_version, rulesHash: c.rules_hash,
    prizeTiers: tiers, store, entryCount: count.n, frozen: c.frozen, inventoryCap: c.inventory_cap,
    skus: skus.map((s) => ({ variantId: s.variant_id, productId: s.product_id, productTitle: s.product_title, variantTitle: s.variant_title, requiredQty: s.required_qty, offerMinor: s.offer_minor, regularMinor: s.price_minor })),
  };
}

/** GET /v1/campaigns/:id — public rules and prize tiers (published campaigns only). */
export async function publicCampaign(ctx: ServiceContext, campaignId: string, actor: Actor | null) {
  const pub = await ctx.db.maybeOne(`select id from app_public.campaigns where id = $1`, [campaignId]);
  if (!pub) throw notFound('Campaign');
  const c = await loadCampaign(ctx.db, campaignId);
  const dto = await campaignDto(ctx.db, c);
  let viewer: unknown = null;
  if (actor) {
    const ents = await ctx.db.query<{ id: string; source: string; status: string; entry_id: string | null; entry_status: string | null }>(
      `select e.id, e.source, e.status, en.id as entry_id, en.status as entry_status from entitlements e left join entries en on en.entitlement_id = e.id
       where e.campaign_id = $1 and e.user_id = $2 order by e.created_at`,
      [campaignId, actor.userId],
    );
    const alt = await ctx.db.maybeOne<{ status: string }>(`select status from alternative_entry_requests where campaign_id = $1 and user_id = $2`, [campaignId, actor.userId]);
    const reason = participantIneligibility(actor, c.rules, ctx.clock.now());
    viewer = {
      eligible: reason === null, ineligibleReason: reason ? INELIGIBLE_MESSAGES[reason] : null,
      entitlements: ents.map((e) => ({ id: e.id, source: e.source, status: e.status, entryId: e.entry_id, entryStatus: e.entry_status })),
      alternativeEntryStatus: alt?.status ?? null,
    };
  }
  return { ...dto, viewer, serverTime: ctx.clock.now().toISOString() };
}

export async function merchantCampaigns(ctx: ServiceContext, actor: Actor | null, storeId: string) {
  await requireStoreMember(ctx.db, actor, storeId);
  const rows = await ctx.db.query<CampaignRow>(`select * from campaigns where store_id = $1 order by created_at desc`, [storeId]);
  return Promise.all(rows.map(async (c) => ({ ...(await campaignDto(ctx.db, c)), version: c.version, fundingStatus: c.funding_status, reviewNotes: c.review_notes })));
}

export async function merchantCampaign(ctx: ServiceContext, actor: Actor | null, campaignId: string) {
  const c = await loadCampaign(ctx.db, campaignId);
  await requireStoreMember(ctx.db, actor, c.store_id);
  const versions = await ctx.db.query(`select version, rules_hash as "rulesHash", reason, participant_remedy as "participantRemedy", created_at as "createdAt" from campaign_rule_versions where campaign_id = $1 order by version`, [campaignId]);
  return {
    ...(await campaignDto(ctx.db, c)), version: c.version, fundingStatus: c.funding_status, fundingEvidence: c.funding_evidence, reviewNotes: c.review_notes,
    cancelReason: c.cancel_reason, checklist: await launchChecklist(ctx.db, c, ctx.clock.now()), ruleVersions: versions,
  };
}

// ---------------------------------------------------------------------------
// Free alternative entry (no purchase necessary)
// ---------------------------------------------------------------------------
export async function requestAlternativeEntry(ctx: ServiceContext, actor: Actor | null, campaignId: string, statement: string) {
  const a = requireActor(actor);
  const c = await loadCampaign(ctx.db, campaignId);
  if (!c.rules.eligibility.alternativeEntry) throw ineligible('This campaign does not offer an alternative entry');
  if (c.status !== 'OPEN' || ctx.clock.now() >= new Date(c.submission_end)) throw ineligible('Entries are closed');
  const reason = participantIneligibility(a, c.rules, ctx.clock.now());
  if (reason) throw ineligible(INELIGIBLE_MESSAGES[reason]);
  try {
    await ctx.db.query(`insert into alternative_entry_requests (campaign_id, user_id, statement) values ($1,$2,$3)`, [campaignId, a.userId, statement]);
  } catch {
    throw conflict('You already requested an alternative entry for this campaign');
  }
  return { status: 'PENDING' };
}

export async function decideAlternativeEntry(ctx: ServiceContext, actor: Actor | null, requestId: string, decision: 'APPROVED' | 'REJECTED') {
  const a = requirePlatform(ctx, actor, 'moderation');
  return ctx.db.tx(async (q) => {
    const r = await q.maybeOne<{ id: string; campaign_id: string; user_id: string; status: string }>(`select * from alternative_entry_requests where id = $1 for update`, [requestId]);
    if (!r) throw notFound('Request');
    if (r.status !== 'PENDING') throw conflict('Already decided');
    await q.query(`update alternative_entry_requests set status = $2, reviewed_by = $3 where id = $1`, [requestId, decision, a.userId]);
    if (decision === 'APPROVED') {
      await q.query(`insert into entitlements (campaign_id, user_id, source) values ($1,$2,'ALTERNATIVE') on conflict do nothing`, [r.campaign_id, r.user_id]);
      await notify(q, r.user_id, 'entitlement.granted', { campaignId: r.campaign_id, source: 'ALTERNATIVE' });
    }
    await audit(q, { actorId: a.userId, action: `alternative_entry.${decision.toLowerCase()}`, targetType: 'alternative_entry', targetId: requestId });
    return { status: decision };
  });
}
