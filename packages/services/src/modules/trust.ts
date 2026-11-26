import { conflict, forbidden, ineligible, notFound, invalid } from '@trendora/contracts';
import type { Actor, ServiceContext } from '../context';
import { audit, iso, notify, rateLimit, setSetting, getSetting } from '../ops';
import { requireActor, requirePlatform } from './identity';
import { loadCampaign } from './campaign-data';

// ---------------------------------------------------------------------------
// Reports & blocks
// ---------------------------------------------------------------------------
export async function fileReport(ctx: ServiceContext, actor: Actor | null, input: { targetType: string; targetId: string; reason: string; details: string }) {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `report:${a.userId}`, 20, 3600, ctx.clock.now());
    const r = await q.one<{ id: string }>(`insert into reports (reporter_id, target_type, target_id, reason, details) values ($1,$2,$3,$4,$5) returning id`, [a.userId, input.targetType, input.targetId, input.reason, input.details]);
    return { reportId: r.id, status: 'OPEN' };
  });
}

export async function blockUser(ctx: ServiceContext, actor: Actor | null, handle: string) {
  const a = requireActor(actor);
  const u = await ctx.db.maybeOne<{ id: string }>(`select id from profiles where handle = $1`, [handle]);
  if (!u) throw notFound('User');
  if (u.id === a.userId) throw invalid('You cannot block yourself');
  await ctx.db.query(`insert into blocks (user_id, blocked_user_id) values ($1,$2) on conflict do nothing`, [a.userId, u.id]);
  return { blocked: true };
}

export async function listReports(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'moderation');
  return ctx.db.query(
    `select r.id, r.target_type as "targetType", r.target_id as "targetId", r.reason, r.details, r.status, r.created_at as "createdAt", p.handle as "reporterHandle"
     from reports r join profiles p on p.id = r.reporter_id where r.status = 'OPEN' order by r.created_at limit 100`,
  );
}

/** ACTIONED reports on entries reject the entry (an appeal remains available). */
export async function decideReport(ctx: ServiceContext, actor: Actor | null, reportId: string, decision: 'ACTIONED' | 'DISMISSED', resolution: string) {
  const a = requirePlatform(ctx, actor, 'moderation');
  return ctx.db.tx(async (q) => {
    const r = await q.maybeOne<{ id: string; status: string; target_type: string; target_id: string }>(`select * from reports where id = $1 for update`, [reportId]);
    if (!r) throw notFound('Report');
    if (r.status !== 'OPEN') throw conflict('Report already resolved');
    await q.query(`update reports set status = $2, resolution = $3, resolved_by = $4 where id = $1`, [reportId, decision, resolution, a.userId]);
    if (decision === 'ACTIONED' && r.target_type === 'ENTRY') {
      const e = await q.maybeOne<{ id: string; user_id: string; status: string }>(`update entries set status = 'REJECTED', rejection_reason = $2 where id = $1 and status in ('APPROVED','REVIEW') returning id, user_id, status`, [r.target_id, `Report upheld: ${resolution}`]);
      if (e) await notify(q, e.user_id, 'entry.rejected', { entryId: e.id, reason: resolution, appealable: true });
    }
    if (decision === 'ACTIONED' && r.target_type === 'COMMENT') await q.query(`update comments set status = 'HIDDEN' where id = $1`, [r.target_id]);
    await audit(q, { actorId: a.userId, action: `report.${decision.toLowerCase()}`, targetType: 'report', targetId: reportId, reason: resolution });
    return { status: decision };
  });
}

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------
export async function fileAppeal(ctx: ServiceContext, actor: Actor | null, input: { entryId: string; reason: string }) {
  const a = requireActor(actor);
  const e = await ctx.db.maybeOne<{ user_id: string; campaign_id: string }>(`select user_id, campaign_id from entries where id = $1`, [input.entryId]);
  if (!e || e.user_id !== a.userId) throw notFound('Entry');
  const c = await loadCampaign(ctx.db, e.campaign_id);
  if (ctx.clock.now() > new Date(c.appeal_deadline)) throw ineligible('The appeal deadline has passed');
  if (['FINALIZED', 'FULFILLED'].includes(c.status)) throw ineligible('Results are final');
  try {
    const r = await ctx.db.one<{ id: string }>(`insert into appeals (entry_id, user_id, reason) values ($1,$2,$3) returning id`, [input.entryId, a.userId, input.reason]);
    return { appealId: r.id, status: 'OPEN' };
  } catch {
    throw conflict('An appeal for this entry is already open');
  }
}

export async function myAppeals(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  return ctx.db.query(`select id, entry_id as "entryId", reason, status, resolution, created_at as "createdAt" from appeals where user_id = $1 order by created_at desc`, [a.userId]);
}

export async function listAppeals(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'moderation');
  return ctx.db.query(
    `select a.id, a.entry_id as "entryId", a.reason, a.created_at as "createdAt", e.status as "entryStatus", e.rejection_reason as "rejectionReason", p.handle, c.title as "campaignTitle"
     from appeals a join entries e on e.id = a.entry_id join profiles p on p.id = a.user_id join campaigns c on c.id = e.campaign_id where a.status = 'OPEN' order by a.created_at`,
  );
}

export async function decideAppeal(ctx: ServiceContext, actor: Actor | null, appealId: string, decision: 'UPHELD' | 'DENIED', resolution: string) {
  const a = requirePlatform(ctx, actor, 'moderation');
  return ctx.db.tx(async (q) => {
    const ap = await q.maybeOne<{ id: string; status: string; entry_id: string; user_id: string }>(`select * from appeals where id = $1 for update`, [appealId]);
    if (!ap) throw notFound('Appeal');
    if (ap.status !== 'OPEN') throw conflict('Appeal already resolved');
    if (ap.user_id === a.userId) throw forbidden('You cannot decide your own appeal');
    await q.query(`update appeals set status = $2, resolution = $3, resolved_by = $4 where id = $1`, [appealId, decision, resolution, a.userId]);
    if (decision === 'UPHELD') {
      await q.query(`update entries set status = 'APPROVED', approved_at = coalesce(approved_at, $2::timestamptz), rejection_reason = null where id = $1 and status = 'REJECTED'`, [ap.entry_id, ctx.clock.now()]);
      await q.query(`update videos set moderation_status = 'APPROVED' where id = (select video_id from entries where id = $1)`, [ap.entry_id]);
    }
    await notify(q, ap.user_id, `appeal.${decision.toLowerCase()}`, { appealId, resolution });
    await audit(q, { actorId: a.userId, action: `appeal.${decision.toLowerCase()}`, targetType: 'appeal', targetId: appealId, reason: resolution });
    return { status: decision };
  });
}

// ---------------------------------------------------------------------------
// Fraud flags (rule + advisory agent); humans decide.
// ---------------------------------------------------------------------------
export async function listFlags(ctx: ServiceContext, actor: Actor | null, campaignId?: string) {
  requirePlatform(ctx, actor, 'moderation');
  return ctx.db.query(
    `select f.id, f.campaign_id as "campaignId", c.title as "campaignTitle", f.entry_id as "entryId", f.kind, f.source, f.evidence, f.confidence, f.status, f.created_at as "createdAt", p.handle as "actorHandle"
     from fraud_flags f join campaigns c on c.id = f.campaign_id left join profiles p on p.id = f.actor_id
     where f.status = 'OPEN' and ($1::uuid is null or f.campaign_id = $1) order by f.created_at`,
    [campaignId ?? null],
  );
}

export async function resolveFlag(ctx: ServiceContext, actor: Actor | null, flagId: string, decision: 'CONFIRMED' | 'DISMISSED', reason: string) {
  const a = requirePlatform(ctx, actor, 'moderation');
  if (reason.trim().length < 5) throw invalid('A reason is required');
  return ctx.db.tx(async (q) => {
    const f = await q.maybeOne<{ id: string; status: string; kind: string; entry_id: string | null; actor_id: string | null; campaign_id: string }>(`select * from fraud_flags where id = $1 for update`, [flagId]);
    if (!f) throw notFound('Flag');
    if (f.status !== 'OPEN') throw conflict('Flag already resolved');
    await q.query(`update fraud_flags set status = $2, resolved_by = $3 where id = $1`, [flagId, decision, a.userId]);
    if (f.kind === 'REFUND_ELIGIBILITY_REVIEW' && f.entry_id) {
      const ent = await q.one<{ id: string }>(`select entitlement_id as id from entries where id = $1`, [f.entry_id]);
      if (decision === 'CONFIRMED') {
        await q.query(`update entitlements set status = 'REVOKED', status_reason = $2 where id = $1`, [ent.id, reason]);
        await q.query(`update rewards set status = 'FORFEITED' where entry_id = $1 and status = 'UNDER_REVIEW'`, [f.entry_id]);
      } else {
        await q.query(`update entitlements set status = 'LOCKED', status_reason = null where id = $1`, [ent.id]);
        await q.query(`update rewards set status = case when claimed_at is null then 'ISSUED' else 'CLAIMED' end where entry_id = $1 and status = 'UNDER_REVIEW'`, [f.entry_id]);
      }
      if (f.actor_id) await notify(q, f.actor_id, 'eligibility.reviewed', { decision, reason });
    } else if (f.kind === 'DUPLICATE_MEDIA' && decision === 'CONFIRMED' && f.entry_id) {
      await q.query(`update entries set status = 'REJECTED', rejection_reason = $2 where id = $1 and status in ('REVIEW','APPROVED')`, [f.entry_id, `Duplicate media: ${reason}`]);
    }
    await audit(q, { actorId: a.userId, action: `fraud_flag.${decision.toLowerCase()}`, targetType: 'fraud_flag', targetId: flagId, reason });
    return { status: decision };
  });
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
export async function pendingOrganizations(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'admin');
  return ctx.db.query(`select id, name, legal_name as "legalName", country, verification_status as "verificationStatus", created_at as "createdAt" from organizations order by (verification_status = 'PENDING') desc, created_at desc limit 100`);
}

export async function decideOrganization(ctx: ServiceContext, actor: Actor | null, orgId: string, decision: 'VERIFIED' | 'REJECTED' | 'SUSPENDED', notes: string) {
  const a = requirePlatform(ctx, actor, 'admin');
  await ctx.db.tx(async (q) => {
    const o = await q.maybeOne(`update organizations set verification_status = $2, verification_notes = $3 where id = $1 returning id`, [orgId, decision, notes]);
    if (!o) throw notFound('Organization');
    const owners = await q.query<{ user_id: string }>(`select user_id from memberships where org_id = $1 and role = 'OWNER'`, [orgId]);
    for (const ow of owners) await notify(q, ow.user_id, 'organization.verification', { decision, notes });
    await audit(q, { actorId: a.userId, action: `organization.${decision.toLowerCase()}`, targetType: 'organization', targetId: orgId, reason: notes });
  });
  return { verificationStatus: decision };
}

export async function campaignAdminQueue(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'moderation');
  return ctx.db.query(
    `select c.id, c.title, c.status, c.funding_status as "fundingStatus", c.funding_evidence as "fundingEvidence", c.frozen, c.starts_at as "startsAt", c.vote_end as "voteEnd", s.name as "storeName", o.verification_status as "orgVerification",
       (select count(*)::int from entries e where e.campaign_id = c.id and e.status = 'APPROVED') as "approvedEntries"
     from campaigns c join stores s on s.id = c.store_id join organizations o on o.id = s.org_id where c.status <> 'DRAFT' order by c.created_at desc limit 100`,
  );
}

/** Privileged kill switch (spec §15): freeze a campaign, or platform-wide commerce / payouts. */
export async function setCampaignFrozen(ctx: ServiceContext, actor: Actor | null, campaignId: string, frozen: boolean, reason: string) {
  const a = requirePlatform(ctx, actor, 'admin');
  await ctx.db.tx(async (q) => {
    await loadCampaign(q, campaignId, { forUpdate: true });
    await q.query(`update campaigns set frozen = $2, frozen_reason = $3 where id = $1`, [campaignId, frozen, frozen ? reason : null]);
    await audit(q, { actorId: a.userId, action: frozen ? 'campaign.frozen' : 'campaign.unfrozen', targetType: 'campaign', targetId: campaignId, reason });
  });
  return { frozen };
}

export async function setPlatformKillSwitch(ctx: ServiceContext, actor: Actor | null, input: { commerceFrozen?: boolean; payoutsFrozen?: boolean; reason: string }) {
  const a = requirePlatform(ctx, actor, 'admin');
  return ctx.db.tx(async (q) => {
    const cur = (await getSetting<{ commerceFrozen: boolean; payoutsFrozen: boolean }>(q, 'kill_switch')) ?? { commerceFrozen: false, payoutsFrozen: false };
    const next = { commerceFrozen: input.commerceFrozen ?? cur.commerceFrozen, payoutsFrozen: input.payoutsFrozen ?? cur.payoutsFrozen };
    await setSetting(q, 'kill_switch', next, a.userId);
    await audit(q, { actorId: a.userId, action: 'platform.kill_switch', targetType: 'platform', targetId: 'kill_switch', reason: input.reason, metadata: next });
    return next;
  });
}

export async function auditLog(ctx: ServiceContext, actor: Actor | null, opts: { targetId?: string; limit?: number } = {}) {
  requirePlatform(ctx, actor, 'admin');
  const rows = await ctx.db.query<{ id: string; action: string; target_type: string; target_id: string; reason: string | null; metadata: unknown; at: Date; handle: string | null }>(
    `select a.id, a.action, a.target_type, a.target_id, a.reason, a.metadata, a.at, p.handle from audit_log a left join profiles p on p.id = a.actor_id
     where ($1::text is null or a.target_id = $1) order by a.at desc limit $2`,
    [opts.targetId ?? null, Math.min(opts.limit ?? 100, 500)],
  );
  return rows.map((r) => ({ id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id, reason: r.reason, metadata: r.metadata, at: iso(r.at), actorHandle: r.handle ?? 'system' }));
}

export async function suspendUser(ctx: ServiceContext, actor: Actor | null, handle: string, suspended: boolean, reason: string) {
  const a = requirePlatform(ctx, actor, 'admin');
  return ctx.db.tx(async (q) => {
    const u = await q.maybeOne<{ id: string }>(`update profiles set status = $2 where handle = $1 returning id`, [handle, suspended ? 'SUSPENDED' : 'ACTIVE']);
    if (!u) throw notFound('User');
    await audit(q, { actorId: a.userId, action: suspended ? 'user.suspended' : 'user.reinstated', targetType: 'profile', targetId: u.id, reason });
    return { status: suspended ? 'SUSPENDED' : 'ACTIVE' };
  });
}

/** SANDBOX ONLY: move the server clock forward to demo campaign phases. */
export async function setSandboxClock(ctx: ServiceContext, actor: Actor | null, offsetMs: number) {
  const a = requirePlatform(ctx, actor, 'admin');
  if (!ctx.config.SANDBOX_MODE) throw forbidden('Clock control is only available in sandbox mode');
  await ctx.db.tx(async (q) => {
    await setSetting(q, 'sandbox_clock', { offsetMs }, a.userId);
    await audit(q, { actorId: a.userId, action: 'sandbox.clock', targetType: 'platform', targetId: 'clock', metadata: { offsetMs } });
  });
  return { offsetMs };
}

export async function pendingAlternativeEntries(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'moderation');
  return ctx.db.query(
    `select r.id, r.statement, r.created_at as "createdAt", p.handle, c.title as "campaignTitle" from alternative_entry_requests r join profiles p on p.id = r.user_id join campaigns c on c.id = r.campaign_id where r.status = 'PENDING' order by r.created_at`,
  );
}

/** Finance: campaigns with prize-funding evidence awaiting verification. */
export async function fundingQueue(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'finance');
  return ctx.db.query(
    `select c.id, c.title, c.funding_status as "fundingStatus", c.funding_evidence as "fundingEvidence", s.name as "storeName"
     from campaigns c join stores s on s.id = c.store_id where c.funding_status = 'PENDING' order by c.updated_at`,
  );
}
