import { randomUUID } from 'node:crypto';
import { conflict, forbidden, ineligible, invalid, notFound, type CreateEntryDto, type EntryDto, type EntryStatus } from '@trendora/contracts';
import { entryMachine, signToken, verifyToken, windows } from '@trendora/core';
import type { Actor, ServiceContext } from '../context';
import { audit, enqueue, iso, notify, rateLimit } from '../ops';
import { requireActor, requirePlatform } from './identity';
import { loadCampaign, times } from './campaign-data';

const UPLOAD_TTL_SECONDS = 3600;

function uploadUrl(ctx: ServiceContext, uploadId: string) {
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const token = signToken(ctx.config.SIGNING_SECRET, { u: uploadId, exp });
  return { url: `${ctx.config.APP_URL}/v1/uploads/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function playbackUrl(ctx: ServiceContext, playbackId: string | null): string | null {
  if (!playbackId) return null;
  const token = signToken(ctx.config.SIGNING_SECRET, { p: playbackId, exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
  return `${ctx.config.APP_URL}/v1/media/${token}`;
}

/** POST /v1/entries {entitlementId} → entryId + signed upload URL. Locks the entitlement. */
export async function createEntry(ctx: ServiceContext, actor: Actor | null, input: { entitlementId: string; caption: string; commercialReuseConsent: boolean }): Promise<CreateEntryDto> {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `entry:${a.userId}`, 10, 3600, ctx.clock.now());
    const ent = await q.maybeOne<{ id: string; campaign_id: string; user_id: string; status: string }>(`select * from entitlements where id = $1 for update`, [input.entitlementId]);
    if (!ent || ent.user_id !== a.userId) throw notFound('Entitlement');
    if (ent.status !== 'ACTIVE') throw ineligible(`Entitlement is ${ent.status.toLowerCase().replace('_', ' ')}`);
    const c = await loadCampaign(q, ent.campaign_id);
    if (c.status !== 'OPEN' || c.frozen || !windows.canSubmit(times(c), ctx.clock.now())) throw ineligible('Submissions are closed for this campaign');
    const uploadId = `up_${randomUUID().replace(/-/g, '')}`;
    const video = await q.one<{ id: string }>(`insert into videos (owner_id, provider, upload_id) values ($1,$2,$3) returning id`, [a.userId, ctx.video.name, uploadId]);
    const entry = await q.one<{ id: string }>(
      `insert into entries (campaign_id, entitlement_id, video_id, user_id, caption, commercial_reuse_consent) values ($1,$2,$3,$4,$5,$6) returning id`,
      [c.id, ent.id, video.id, a.userId, input.caption, input.commercialReuseConsent],
    );
    await q.query(`update entitlements set status = 'LOCKED' where id = $1`, [ent.id]);
    await audit(q, { actorId: a.userId, action: 'entry.created', targetType: 'entry', targetId: entry.id });
    const u = uploadUrl(ctx, uploadId);
    return { entryId: entry.id, uploadUrl: u.url, uploadExpiresAt: u.expiresAt, provider: ctx.video.name };
  });
}

/** New signed upload URL for a DRAFT entry (e.g. after a failed transcode). */
export async function renewUploadUrl(ctx: ServiceContext, actor: Actor | null, entryId: string) {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    const e = await q.maybeOne<{ id: string; user_id: string; status: EntryStatus; video_id: string; campaign_id: string }>(`select * from entries where id = $1 for update`, [entryId]);
    if (!e || e.user_id !== a.userId) throw notFound('Entry');
    if (e.status !== 'DRAFT') throw conflict('Video can only be replaced while the entry is a draft');
    const c = await loadCampaign(q, e.campaign_id);
    if (!windows.canSubmit(times(c), ctx.clock.now())) throw ineligible('Submission deadline has passed');
    const uploadId = `up_${randomUUID().replace(/-/g, '')}`;
    await q.query(`update videos set upload_id = $2, status = 'AWAITING_UPLOAD', failure_reason = null, provider_asset_id = null, playback_id = null where id = $1`, [e.video_id, uploadId]);
    const u = uploadUrl(ctx, uploadId);
    return { entryId, uploadUrl: u.url, uploadExpiresAt: u.expiresAt };
  });
}

/** Sandbox direct upload target (PUT /v1/uploads/:token). Real providers receive bytes directly. */
export async function receiveUpload(ctx: ServiceContext, token: string, data: Buffer, contentType: string) {
  const payload = verifyToken<{ u: string }>(ctx.config.SIGNING_SECRET, token);
  if (!payload?.u) throw forbidden('Upload URL is invalid or expired');
  const v = await ctx.db.maybeOne<{ id: string; status: string }>(`select id, status from videos where upload_id = $1`, [payload.u]);
  if (!v) throw notFound('Upload');
  if (v.status !== 'AWAITING_UPLOAD') throw conflict('Upload already received');
  if (data.length === 0) throw invalid('Empty upload');
  if (data.length > 250 * 1024 * 1024) throw invalid('Upload too large');
  await ctx.video.acceptUpload(payload.u, data, contentType);
  await ctx.db.tx(async (q) => {
    await q.query(`update videos set status = 'PROCESSING', content_type = $2, size_bytes = $3 where id = $1`, [v.id, contentType, data.length]);
    await q.query(`update entries set status = 'PROCESSING' where video_id = $1 and status = 'DRAFT'`, [v.id]);
    await enqueue(q, 'video.uploaded', { videoId: v.id, uploadId: payload.u }, { dedupeKey: `video.uploaded:${payload.u}` });
  });
  ctx.kickJobs?.();
  return { status: 'PROCESSING' };
}

/** Job: asynchronous transcode + deterministic moderation rules (duplicate media hash). */
export async function processVideo(ctx: ServiceContext, videoId: string, uploadId: string) {
  const v = await ctx.db.maybeOne<{ id: string; owner_id: string; upload_id: string; status: string }>(`select * from videos where id = $1`, [videoId]);
  if (!v || v.upload_id !== uploadId || v.status !== 'PROCESSING') return;
  const entry = await ctx.db.maybeOne<{ id: string; campaign_id: string; status: EntryStatus }>(`select id, campaign_id, status from entries where video_id = $1`, [videoId]);
  const rules = entry ? (await loadCampaign(ctx.db, entry.campaign_id)).rules.entry : { maxBytes: 200 * 1024 * 1024, minDurationMs: 1000, maxDurationMs: 180_000, allowedContentTypes: ['video/mp4', 'video/webm'] };
  const result = await ctx.video.transcode(uploadId, rules);
  await ctx.db.tx(async (q) => {
    if (!result.ok) {
      await q.query(`update videos set status = 'FAILED', failure_reason = $2 where id = $1`, [videoId, result.failureReason]);
      if (entry) await q.query(`update entries set status = 'DRAFT' where id = $1 and status = 'PROCESSING'`, [entry.id]);
      await notify(q, v.owner_id, 'video.failed', { entryId: entry?.id, reason: result.failureReason });
      return;
    }
    await q.query(
      `update videos set status = 'READY', duration_ms = $2, content_hash = $3, size_bytes = $4, playback_id = $5, provider_asset_id = $5, content_type = $6, poster_url = null where id = $1`,
      [videoId, result.durationMs, result.contentHash, result.sizeBytes, result.playbackId, result.contentType],
    );
    if (entry) {
      const dupe = await q.maybeOne<{ id: string; owner_id: string }>(`select id, owner_id from videos where content_hash = $1 and id <> $2 and status = 'READY' limit 1`, [result.contentHash, videoId]);
      if (dupe) {
        await q.query(
          `insert into fraud_flags (campaign_id, entry_id, actor_id, kind, source, evidence, confidence, dedupe_key) values ($1,$2,$3,'DUPLICATE_MEDIA','RULE',$4,0.95,$5) on conflict (dedupe_key) do nothing`,
          [entry.campaign_id, entry.id, v.owner_id, JSON.stringify({ matchesVideoId: dupe.id, sameOwner: dupe.owner_id === v.owner_id }), `dupe:${videoId}`],
        );
      }
      await enqueue(q, 'video.asset.ready', { videoId, entryId: entry.id }, { dedupeKey: `video.ready:${uploadId}` });
    }
    await notify(q, v.owner_id, 'video.ready', { entryId: entry?.id });
  });
}

/** POST /v1/entries/:id/submit after the asset is ready → moderation review. */
export async function submitEntry(ctx: ServiceContext, actor: Actor | null, entryId: string, caption?: string) {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    const e = await q.maybeOne<{ id: string; user_id: string; status: EntryStatus; video_id: string; campaign_id: string }>(`select * from entries where id = $1 for update`, [entryId]);
    if (!e || e.user_id !== a.userId) throw notFound('Entry');
    const c = await loadCampaign(q, e.campaign_id);
    if (c.frozen || !windows.canSubmit(times(c), ctx.clock.now())) throw ineligible('Submission deadline has passed');
    const v = await q.one<{ status: string }>(`select status from videos where id = $1`, [e.video_id]);
    if (v.status !== 'READY') throw conflict('Video is not ready yet');
    entryMachine.assert(e.status, 'REVIEW');
    await q.query(`update entries set status = 'REVIEW', submitted_at = $3, caption = coalesce($2, caption) where id = $1`, [entryId, caption ?? null, ctx.clock.now()]);
    await audit(q, { actorId: a.userId, action: 'entry.submitted', targetType: 'entry', targetId: entryId });
    return { status: 'REVIEW' };
  });
}

/** Caption edits only before the submission deadline. */
export async function editEntry(ctx: ServiceContext, actor: Actor | null, entryId: string, caption: string) {
  const a = requireActor(actor);
  const e = await ctx.db.maybeOne<{ user_id: string; campaign_id: string; status: string }>(`select user_id, campaign_id, status from entries where id = $1`, [entryId]);
  if (!e || e.user_id !== a.userId) throw notFound('Entry');
  const c = await loadCampaign(ctx.db, e.campaign_id);
  if (!windows.canSubmit(times(c), ctx.clock.now())) throw ineligible('Entries can only be edited before the submission deadline');
  if (e.status === 'WITHDRAWN' || e.status === 'REJECTED') throw conflict('Entry can no longer be edited');
  await ctx.db.query(`update entries set caption = $2 where id = $1`, [entryId, caption]);
  return { ok: true };
}

export async function withdrawEntry(ctx: ServiceContext, actor: Actor | null, entryId: string) {
  const a = requireActor(actor);
  return ctx.db.tx(async (q) => {
    const e = await q.maybeOne<{ id: string; user_id: string; status: EntryStatus; campaign_id: string }>(`select * from entries where id = $1 for update`, [entryId]);
    if (!e || e.user_id !== a.userId) throw notFound('Entry');
    const c = await loadCampaign(q, e.campaign_id);
    if (['REVIEWING', 'FINALIZED', 'FULFILLED'].includes(c.status)) throw conflict('Entries cannot be withdrawn after voting closes');
    entryMachine.assert(e.status, 'WITHDRAWN');
    await q.query(`update entries set status = 'WITHDRAWN' where id = $1`, [entryId]);
    await audit(q, { actorId: a.userId, action: 'entry.withdrawn', targetType: 'entry', targetId: entryId });
    return { status: 'WITHDRAWN' };
  });
}

export async function moderateEntry(ctx: ServiceContext, actor: Actor | null, entryId: string, decision: 'APPROVED' | 'REJECTED', reason: string) {
  const a = requirePlatform(ctx, actor, 'moderation');
  if (decision === 'REJECTED' && reason.trim().length < 3) throw invalid('A rejection reason is required');
  return ctx.db.tx(async (q) => {
    const e = await q.maybeOne<{ id: string; user_id: string; status: EntryStatus; video_id: string; campaign_id: string }>(`select * from entries where id = $1 for update`, [entryId]);
    if (!e) throw notFound('Entry');
    if (e.user_id === a.userId) throw forbidden('You cannot moderate your own entry');
    entryMachine.assert(e.status, decision);
    await q.query(
      `update entries set status = $2, approved_at = case when $2 = 'APPROVED' then $4::timestamptz else approved_at end, rejection_reason = case when $2 = 'REJECTED' then $3 else null end where id = $1`,
      [entryId, decision, reason || null, ctx.clock.now()],
    );
    await q.query(`update videos set moderation_status = $2 where id = $1`, [e.video_id, decision]);
    if (decision === 'APPROVED') await q.query(`update entries set boost_exposure = $2 where id = $1`, [entryId, (await loadCampaign(q, e.campaign_id)).rules.exposure.explorationImpressions]);
    await notify(q, e.user_id, `entry.${decision.toLowerCase()}`, { entryId, reason });
    await audit(q, { actorId: a.userId, action: `entry.${decision.toLowerCase()}`, targetType: 'entry', targetId: entryId, reason });
    if (decision === 'APPROVED') await enqueue(q, 'entry.approved', { entryId, campaignId: e.campaign_id });
    return { status: decision };
  });
}

type EntryRow = { id: string; campaign_id: string; status: EntryStatus; caption: string; submitted_at: Date | null; approved_at: Date | null; rejection_reason: string | null; created_at: Date; video_status: string; moderation_status: string; playback_id: string | null; failure_reason: string | null; campaign_title: string };

export async function myEntries(ctx: ServiceContext, actor: Actor | null): Promise<(EntryDto & { campaignTitle: string; videoFailure: string | null })[]> {
  const a = requireActor(actor);
  const rows = await ctx.db.query<EntryRow>(
    `select e.*, v.status as video_status, v.moderation_status, v.playback_id, v.failure_reason, c.title as campaign_title
     from entries e join videos v on v.id = e.video_id join campaigns c on c.id = e.campaign_id where e.user_id = $1 order by e.created_at desc`,
    [a.userId],
  );
  return rows.map((r) => ({
    id: r.id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, status: r.status, caption: r.caption, videoStatus: r.video_status,
    moderationStatus: r.moderation_status, playbackUrl: playbackUrl(ctx, r.playback_id), submittedAt: iso(r.submitted_at), approvedAt: iso(r.approved_at),
    rejectionReason: r.rejection_reason, createdAt: iso(r.created_at)!, videoFailure: r.failure_reason,
  }));
}

export async function myEntitlements(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  const rows = await ctx.db.query<{ id: string; campaign_id: string; title: string; source: 'PURCHASE' | 'ALTERNATIVE'; status: string; entry_id: string | null; created_at: Date }>(
    `select e.id, e.campaign_id, c.title, e.source, e.status, en.id as entry_id, e.created_at from entitlements e join campaigns c on c.id = e.campaign_id
     left join entries en on en.entitlement_id = e.id where e.user_id = $1 order by e.created_at desc`,
    [a.userId],
  );
  return rows.map((r) => ({ id: r.id, campaignId: r.campaign_id, campaignTitle: r.title, source: r.source, status: r.status, entryId: r.entry_id, createdAt: iso(r.created_at)! }));
}

export async function readPlayback(ctx: ServiceContext, token: string) {
  const payload = verifyToken<{ p: string }>(ctx.config.SIGNING_SECRET, token);
  if (!payload?.p) throw forbidden('Playback token invalid or expired');
  const media = await ctx.video.readPlayback(payload.p);
  if (!media) throw notFound('Media');
  return media;
}

export async function moderationQueue(ctx: ServiceContext, actor: Actor | null) {
  requirePlatform(ctx, actor, 'moderation');
  const rows = await ctx.db.query<{ id: string; campaign_id: string; campaign_title: string; caption: string; submitted_at: Date; handle: string; playback_id: string | null; duration_ms: number | null; flags: number; commercial_reuse_consent: boolean }>(
    `select e.id, e.campaign_id, c.title as campaign_title, e.caption, e.submitted_at, p.handle, v.playback_id, v.duration_ms, e.commercial_reuse_consent,
       (select count(*)::int from fraud_flags f where f.entry_id = e.id and f.status = 'OPEN') as flags
     from entries e join videos v on v.id = e.video_id join campaigns c on c.id = e.campaign_id join profiles p on p.id = e.user_id
     where e.status = 'REVIEW' order by e.submitted_at asc limit 100`,
  );
  return rows.map((r) => ({ entryId: r.id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, caption: r.caption, submittedAt: iso(r.submitted_at), creatorHandle: r.handle, playbackUrl: playbackUrl(ctx, r.playback_id), durationMs: r.duration_ms, openFlags: r.flags, commercialReuseConsent: r.commercial_reuse_consent }));
}

