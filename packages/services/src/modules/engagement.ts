import { randomUUID } from 'node:crypto';
import { ineligible, notFound, conflict, type FeedItem, type Page } from '@trendora/contracts';
import { clusterAnomaly, eventInvalidReason, isMeaningfulComment, randomToken, sha256Hex, windows } from '@trendora/core';
import type { Actor, Q, RequestMeta, ServiceContext } from '../context';
import { rateLimit } from '../ops';
import { requireActor } from './identity';
import { loadCampaign, times, type CampaignRow } from './campaign-data';
import { playbackUrl } from './entries';

/**
 * Engagement events (spec §7): unique authenticated eligible voters, one like per
 * user/entry, qualified shares need a distinct recipient visit via a signed link,
 * repeat views capped, self-votes prohibited. Every event is logged (valid or not)
 * with an exclusion reason so ranking snapshots are reproducible and auditable.
 */
async function liveEntry(q: Q, entryId: string, now: Date): Promise<{ entry: { id: string; user_id: string; campaign_id: string }; campaign: CampaignRow }> {
  const entry = await q.maybeOne<{ id: string; user_id: string; campaign_id: string; status: string }>(`select id, user_id, campaign_id, status from entries where id = $1`, [entryId]);
  if (!entry || entry.status !== 'APPROVED') throw notFound('Entry');
  const campaign = await loadCampaign(q, entry.campaign_id);
  if (campaign.frozen) throw ineligible('This campaign is paused');
  if (!['OPEN', 'SUBMISSION_CLOSED'].includes(campaign.status) || !windows.canVote(times(campaign), now)) throw ineligible('Voting is closed for this campaign');
  return { entry, campaign };
}

const hashOf = (v: string | null | undefined) => (v ? sha256Hex(`trendora:${v}`).slice(0, 32) : null);

async function recordEvent(
  q: Q,
  a: { type: string; entryId: string; creatorId: string; campaign: CampaignRow; actor: Actor | null; visitorHash?: string | null; dedupeKey: string; now: Date; meta: RequestMeta; shareLinkId?: string | null; source?: string; metadata?: Record<string, unknown>; forcedInvalid?: string | null },
) {
  const policy = a.campaign.rules.voting;
  const recent = a.actor
    ? (await q.one<{ n: number }>(`select count(*)::int as n from engagement_events where actor_id = $1 and type = $2 and occurred_at > $3::timestamptz - interval '1 minute'`, [a.actor.userId, a.type, a.now])).n
    : 0;
  const prior = (await q.one<{ n: number }>(
    `select count(*)::int as n from engagement_events where entry_id = $1 and type = $2 and validity = 'VALID' and (actor_id = $3 or ($3::uuid is null and visitor_hash = $4))`,
    [a.entryId, a.type, a.actor?.userId ?? null, a.visitorHash ?? null],
  )).n;
  const reason =
    a.forcedInvalid ??
    eventInvalidReason(
      { type: a.type, actorId: a.actor?.userId ?? null, creatorId: a.creatorId, actorCreatedAt: a.actor?.createdAt ?? null, actorRisk: a.actor?.riskScore ?? 0, occurredAt: a.now, recentActorEventsSameType: recent, priorSameTypeForEntry: prior },
      policy,
    );
  const device = hashOf(a.meta.deviceId);
  const network = hashOf(a.meta.ip);
  const row = await q.maybeOne<{ id: string }>(
    `insert into engagement_events (entry_id, actor_id, visitor_hash, type, dedupe_key, occurred_at, validity, invalid_reason, share_link_id, exposure_source, device_hash, network_hash, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (dedupe_key) do nothing returning id`,
    [a.entryId, a.actor?.userId ?? null, a.visitorHash ?? null, a.type, a.dedupeKey, a.now, reason ? 'INVALID' : 'VALID', reason, a.shareLinkId ?? null, a.source ?? 'ORGANIC', device, network, JSON.stringify(a.metadata ?? {})],
  );
  // Device/network anomaly review: many accounts liking one entry from one device.
  if (row && a.type === 'LIKE' && device) {
    const cluster = await q.one<{ n: number }>(`select count(distinct actor_id)::int as n from engagement_events where entry_id = $1 and type = 'LIKE' and device_hash = $2`, [a.entryId, device]);
    if (clusterAnomaly(cluster.n)) {
      await q.query(
        `insert into fraud_flags (campaign_id, entry_id, kind, source, evidence, confidence, dedupe_key) values ($1,$2,'DEVICE_CLUSTER','RULE',$3,0.7,$4) on conflict (dedupe_key) do nothing`,
        [a.campaign.id, a.entryId, JSON.stringify({ deviceHash: device, distinctAccounts: cluster.n }), `device:${a.entryId}:${device}`],
      );
    }
  }
  return { recorded: !!row, valid: !reason, reason };
}

/** PUT /v1/entries/:id/like {active} — idempotent upsert. */
export async function setLike(ctx: ServiceContext, actor: Actor | null, entryId: string, active: boolean, meta: RequestMeta) {
  const a = requireActor(actor);
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `like:${a.userId}`, 120, 60, now);
    const { entry, campaign } = await liveEntry(q, entryId, now);
    const cur = await q.maybeOne<{ active: boolean }>(`select active from likes where entry_id = $1 and user_id = $2 for update`, [entryId, a.userId]);
    if (cur?.active === active || (!cur && !active)) return { active, changed: false, counted: null as boolean | null };
    if (cur) await q.query(`update likes set active = $3, updated_at = now() where entry_id = $1 and user_id = $2`, [entryId, a.userId, active]);
    else await q.query(`insert into likes (entry_id, user_id, active) values ($1,$2,$3)`, [entryId, a.userId, active]);
    const r = await recordEvent(q, { type: active ? 'LIKE' : 'UNLIKE', entryId, creatorId: entry.user_id, campaign, actor: a, dedupeKey: `like:${entryId}:${a.userId}:${randomUUID()}`, now, meta });
    return { active, changed: true, counted: r.valid };
  });
}

/** POST /v1/entries/:id/share — creates a signed share link for the sharer. */
export async function createShareLink(ctx: ServiceContext, actor: Actor | null, entryId: string) {
  const a = requireActor(actor);
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `share:${a.userId}`, 30, 3600, now);
    await liveEntry(q, entryId, now);
    const token = randomToken(18);
    await q.query(`insert into share_links (entry_id, sharer_id, token_hash) values ($1,$2,$3)`, [entryId, a.userId, sha256Hex(token)]);
    return { url: `${ctx.config.APP_URL}/s/${token}`, token };
  });
}

/** A recipient opens a share link. Counts once per distinct recipient; sharer/creator visits never count. */
export async function recordShareVisit(ctx: ServiceContext, actor: Actor | null, token: string, meta: RequestMeta & { visitorId: string }) {
  const now = ctx.clock.now();
  const link = await ctx.db.maybeOne<{ id: string; entry_id: string; sharer_id: string }>(`select id, entry_id, sharer_id from share_links where token_hash = $1`, [sha256Hex(token)]);
  if (!link) throw notFound('Share link');
  try {
    return await ctx.db.tx(async (q) => {
      const { entry, campaign } = await liveEntry(q, link.entry_id, now);
      const visitorKey = actor?.userId ?? `v:${hashOf(meta.visitorId)}`;
      let forced: string | null = null;
      if (actor && (actor.userId === link.sharer_id || actor.userId === entry.user_id)) forced = 'SELF_REFERRAL';
      // Referral self-dealing: recipient on the same network as the sharer's own visits.
      const sharerNet = await q.maybeOne<{ network_hash: string | null }>(`select network_hash from engagement_events where actor_id = $1 and network_hash is not null order by occurred_at desc limit 1`, [link.sharer_id]);
      if (!forced && sharerNet?.network_hash && sharerNet.network_hash === hashOf(meta.ip) && !actor) forced = 'SAME_NETWORK_AS_SHARER';
      const r = await recordEvent(q, {
        type: 'SHARE_VISIT', entryId: entry.id, creatorId: entry.user_id, campaign, actor, visitorHash: actor ? null : hashOf(meta.visitorId),
        dedupeKey: `share:${entry.id}:${visitorKey}`, now, meta, shareLinkId: link.id, forcedInvalid: forced,
      });
      return { entryId: entry.id, campaignId: entry.campaign_id, counted: r.recorded && r.valid };
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'INELIGIBLE') return { entryId: link.entry_id, campaignId: null, counted: false };
    throw e;
  }
}

/** Impressions / view completions from the player. Paid exposure is recorded but excluded from ranking. */
export async function recordView(ctx: ServiceContext, actor: Actor | null, entryId: string, input: { type: 'IMPRESSION' | 'VIEW_COMPLETE'; source: 'ORGANIC' | 'EXPLORATION' | 'PAID'; watchedMs?: number }, meta: RequestMeta & { visitorId: string }) {
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `view:${actor?.userId ?? hashOf(meta.visitorId)}`, 300, 60, now);
    const { entry, campaign } = await liveEntry(q, entryId, now);
    const visitorHash = actor ? null : hashOf(meta.visitorId);
    const r = await recordEvent(q, {
      type: input.type, entryId, creatorId: entry.user_id, campaign, actor, visitorHash, dedupeKey: `${input.type}:${entryId}:${actor?.userId ?? visitorHash}:${randomUUID()}`,
      now, meta, source: input.source, metadata: input.watchedMs ? { watchedMs: input.watchedMs } : {},
      forcedInvalid: actor ? null : input.type === 'VIEW_COMPLETE' ? 'ANONYMOUS' : null,
    });
    return { counted: r.valid };
  });
}

export async function addComment(ctx: ServiceContext, actor: Actor | null, entryId: string, body: string, meta: RequestMeta) {
  const a = requireActor(actor);
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    await rateLimit(q, `comment:${a.userId}`, 20, 600, now);
    const { entry, campaign } = await liveEntry(q, entryId, now);
    const blocked = await q.maybeOne(`select 1 from blocks where user_id = $1 and blocked_user_id = $2`, [entry.user_id, a.userId]);
    if (blocked) throw ineligible('You cannot comment on this entry');
    const c = await q.one<{ id: string }>(`insert into comments (entry_id, author_id, body) values ($1,$2,$3) returning id`, [entryId, a.userId, body]);
    const meaningful = isMeaningfulComment(body, campaign.rules.scoring.meaningfulCommentMinWords);
    await recordEvent(q, { type: 'COMMENT', entryId, creatorId: entry.user_id, campaign, actor: a, dedupeKey: `comment:${c.id}`, now, meta, metadata: { meaningful, commentId: c.id }, forcedInvalid: meaningful ? null : 'NOT_MEANINGFUL' });
    return { commentId: c.id, meaningful };
  });
}

export async function listComments(ctx: ServiceContext, entryId: string) {
  return ctx.db.query(
    `select c.id, c.body, c.created_at as "createdAt", p.handle as "authorHandle" from comments c join profiles p on p.id = c.author_id
     where c.entry_id = $1 and c.status = 'VISIBLE' order by c.created_at desc limit 50`,
    [entryId],
  );
}

export async function followCreator(ctx: ServiceContext, actor: Actor | null, entryId: string, meta: RequestMeta) {
  const a = requireActor(actor);
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const { entry, campaign } = await liveEntry(q, entryId, now);
    if (entry.user_id === a.userId) throw conflict('You cannot follow yourself');
    const ins = await q.maybeOne(`insert into follows (follower_id, creator_id, via_entry_id) values ($1,$2,$3) on conflict do nothing returning 1`, [a.userId, entry.user_id, entryId]);
    if (ins) await recordEvent(q, { type: 'FOLLOW', entryId, creatorId: entry.user_id, campaign, actor: a, dedupeKey: `follow:${a.userId}:${entry.user_id}`, now, meta });
    return { following: true };
  });
}

/**
 * GET /v1/feed?cursor= — approved entries; stable ordering by (approved_at desc, id).
 * Fair exposure: entries still holding exploration slots are surfaced first and
 * flagged so the client reports their impressions with source=EXPLORATION.
 */
export async function feed(ctx: ServiceContext, actor: Actor | null, cursor: string | undefined, limit: number, campaignId?: string, entryId?: string): Promise<Page<FeedItem & { exploration: boolean }>> {
  let after: { t: string; id: string } | null = null;
  if (cursor) {
    try {
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      after = null;
    }
  }
  const rows = await ctx.db.query<{ entry_id: string; campaign_id: string; caption: string; approved_at: Date; playback_id: string | null; poster_url: string | null; duration_ms: number | null; creator_handle: string; creator_name: string; campaign_title: string; store_id: string; store_slug: string; store_name: string; likes: number; liked: boolean; impressions: number; boost: number; sponsor: string }>(
    `select f.*, s.slug as store_slug, s.name as store_name, c.rules->'disclosures'->>'sponsor' as sponsor, e.boost_exposure as boost,
       (select count(*)::int from likes l where l.entry_id = f.entry_id and l.active) as likes,
       coalesce((select l.active from likes l where l.entry_id = f.entry_id and l.user_id = $1), false) as liked,
       (select count(*)::int from engagement_events ev where ev.entry_id = f.entry_id and ev.type = 'IMPRESSION' and ev.validity = 'VALID') as impressions
     from app_public.feed f join app_public.stores s on s.id = f.store_id join campaigns c on c.id = f.campaign_id join entries e on e.id = f.entry_id
     where ($2::timestamptz is null or (f.approved_at, f.entry_id) < ($2::timestamptz, $3::uuid))
       and ($5::uuid is null or f.campaign_id = $5)
       and ($6::uuid is null or f.entry_id = $6)
     order by f.approved_at desc, f.entry_id desc limit $4`,
    [actor?.userId ?? null, after?.t ?? null, after?.id ?? null, limit + 1, campaignId ?? null, entryId ?? null],
  );
  const page = rows.slice(0, limit);
  const tags = page.length
    ? await ctx.db.query<{ campaign_id: string; product_id: string; title: string; offer_minor: number; price_minor: number; currency: string }>(
        `select cs.campaign_id, p.id as product_id, p.title, cs.offer_minor, v.price_minor, v.currency from campaign_skus cs join variants v on v.id = cs.variant_id
         join products p on p.id = v.product_id where cs.campaign_id = any($1)`,
        [[...new Set(page.map((r) => r.campaign_id))]],
      )
    : [];
  const last = page[page.length - 1];
  const items = page.map((r) => ({
    entryId: r.entry_id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, storeSlug: r.store_slug, storeName: r.store_name,
    creatorHandle: r.creator_handle, creatorName: r.creator_name, caption: r.caption, playbackUrl: playbackUrl(ctx, r.playback_id), posterUrl: r.poster_url,
    durationMs: r.duration_ms, likeCount: r.likes, likedByMe: r.liked, sponsorDisclosure: r.sponsor ?? 'Sponsored',
    exploration: r.impressions < r.boost,
    productTags: tags.filter((t) => t.campaign_id === r.campaign_id).map((t) => ({ productId: t.product_id, title: t.title, offerMinor: t.offer_minor, regularMinor: t.price_minor, currency: t.currency })),
  }));
  // Exploration-slot entries first within the page (randomized exposure for new entries).
  items.sort((x, y) => Number(y.exploration) - Number(x.exploration));
  return {
    items,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ t: new Date(last.approved_at).toISOString(), id: last.entry_id })).toString('base64url') : null,
  };
}

export async function entryDetail(ctx: ServiceContext, actor: Actor | null, entryId: string) {
  const page = await feed(ctx, actor, undefined, 1, undefined, entryId);
  const item = page.items[0];
  if (!item) throw notFound('Entry');
  return { ...item, comments: await listComments(ctx, entryId) };
}
