import { conflict, ineligible, notFound, forbidden, invalid, type LeaderboardDto } from '@trendora/contracts';
import { campaignMachine, couponCodeFor, hashCouponCode, planRewards, rankEntries, type EntryMetrics, type RubricScore } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { audit, enqueue, iso, notify, withIdempotency } from '../ops';
import { requirePlatform } from './identity';
import { killSwitches, loadCampaign, type CampaignRow } from './campaign-data';
import { tiersOf } from './campaigns';

/**
 * Ranking snapshots (spec §7 finalization contract): computed from the immutable
 * event set up to a cutoff with a pinned algorithm version. Score components and
 * excluded-event reasons are stored for every entry.
 */
export async function collectMetrics(q: Q, c: CampaignRow, cutoff: Date): Promise<{ metrics: (EntryMetrics & { userId: string })[]; excluded: Map<string, Record<string, number>>; eventCount: number; excludedCount: number }> {
  const entries = await q.query<{ id: string; user_id: string; approved_at: Date }>(
    `select e.id, e.user_id, e.approved_at from entries e join entitlements en on en.id = e.entitlement_id
     where e.campaign_id = $1 and e.status = 'APPROVED' and en.status <> 'REVOKED' and e.approved_at <= $2`,
    [c.id, cutoff],
  );
  // Actors with confirmed fraud in this campaign have all their events excluded.
  const tainted = new Set((await q.query<{ actor_id: string }>(`select actor_id from fraud_flags where campaign_id = $1 and status = 'CONFIRMED' and actor_id is not null`, [c.id])).map((r) => r.actor_id));
  const events = await q.query<{ entry_id: string; actor_id: string | null; visitor_hash: string | null; type: string; validity: string; invalid_reason: string | null; exposure_source: string; occurred_at: Date }>(
    `select entry_id, actor_id, visitor_hash, type, validity, invalid_reason, exposure_source, occurred_at from engagement_events
     where entry_id = any($1) and occurred_at <= $2 order by occurred_at, id`,
    [entries.map((e) => e.id), cutoff],
  );
  const rubric = await q.query<{ entry_id: string; reviewer_id: string; originality: number; product_integration: number; execution: number; is_adjudication: boolean }>(
    `select entry_id, reviewer_id, originality, product_integration, execution, is_adjudication from rubric_scores where entry_id = any($1) order by created_at`,
    [entries.map((e) => e.id)],
  );
  const excluded = new Map<string, Record<string, number>>();
  const bump = (entryId: string, reason: string) => {
    const m = excluded.get(entryId) ?? {};
    m[reason] = (m[reason] ?? 0) + 1;
    excluded.set(entryId, m);
  };
  const acc = new Map<string, { exposures: number; likeState: Map<string, boolean>; shares: Set<string>; completions: number; comments: Set<string>; follows: Set<string> }>();
  for (const e of entries) acc.set(e.id, { exposures: 0, likeState: new Map(), shares: new Set(), completions: 0, comments: new Set(), follows: new Set() });
  let excludedCount = 0;
  for (const ev of events) {
    const a = acc.get(ev.entry_id)!;
    let reason = ev.validity === 'INVALID' ? (ev.invalid_reason ?? 'INVALID') : null;
    if (!reason && ev.actor_id && tainted.has(ev.actor_id)) reason = 'FRAUD_CONFIRMED';
    if (!reason && ev.type === 'IMPRESSION' && ev.exposure_source === 'PAID') reason = 'PAID_EXPOSURE';
    if (reason) {
      excludedCount++;
      bump(ev.entry_id, `${ev.type}:${reason}`);
      continue;
    }
    const who = ev.actor_id ?? `v:${ev.visitor_hash}`;
    switch (ev.type) {
      case 'IMPRESSION': a.exposures++; break;
      case 'VIEW_COMPLETE': a.completions++; break;
      case 'LIKE': a.likeState.set(who, true); break;
      case 'UNLIKE': a.likeState.set(who, false); break;
      case 'SHARE_VISIT': a.shares.add(who); break;
      case 'COMMENT': a.comments.add(who); break;
      case 'FOLLOW': a.follows.add(who); break;
    }
  }
  const metrics = entries.map((e) => {
    const a = acc.get(e.id)!;
    return {
      entryId: e.id,
      userId: e.user_id,
      approvedAt: new Date(e.approved_at),
      exposures: a.exposures,
      likes: [...a.likeState.values()].filter(Boolean).length,
      qualifiedShares: a.shares.size,
      completions: a.completions,
      meaningfulComments: a.comments.size,
      follows: a.follows.size,
      rubric: rubric.filter((r) => r.entry_id === e.id).map<RubricScore>((r) => ({ reviewerId: r.reviewer_id, originality: r.originality, productIntegration: r.product_integration, execution: r.execution, isAdjudication: r.is_adjudication })),
    };
  });
  return { metrics, excluded, eventCount: events.length, excludedCount };
}

export async function createSnapshot(ctx: ServiceContext, campaignId: string, opts: { cutoff?: Date; actorId?: string | null; onlyIfChanged?: boolean } = {}) {
  return ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    if (!['OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED', 'REVIEWING'].includes(c.status)) throw conflict('Snapshots can only be computed for live or closed campaigns');
    const now = ctx.clock.now();
    const voteEnd = new Date(c.vote_end);
    const cutoff = opts.cutoff ?? (now < voteEnd ? now : voteEnd);
    if (cutoff > voteEnd) throw invalid('Cutoff cannot be after the voting deadline');
    const { metrics, excluded, eventCount, excludedCount } = await collectMetrics(q, c, cutoff);
    const prev = await q.maybeOne<{ id: string; version: number; event_count: number; cutoff: Date }>(`select id, version, event_count, cutoff from score_snapshots where campaign_id = $1 order by version desc limit 1`, [campaignId]);
    if (opts.onlyIfChanged && prev && prev.event_count === eventCount && metrics.length === (await q.one<{ n: number }>(`select count(*)::int as n from entry_scores where snapshot_id = $1`, [prev.id])).n) {
      return { snapshotId: prev.id, version: prev.version, unchanged: true };
    }
    const ranked = rankEntries(metrics, c.rules.scoring);
    const version = (prev?.version ?? 0) + 1;
    const snap = await q.one<{ id: string }>(
      `insert into score_snapshots (campaign_id, version, cutoff, algorithm_version, event_count, excluded_count, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [campaignId, version, cutoff, c.rules.scoring.algorithmVersion, eventCount, excludedCount, opts.actorId ?? null],
    );
    for (const r of ranked) {
      await q.query(
        `insert into entry_scores (snapshot_id, entry_id, components, excluded, score, rank) values ($1,$2,$3,$4,$5,$6)`,
        [snap.id, r.entryId, JSON.stringify({ ...r.components, creativityStatus: r.creativityStatus }), JSON.stringify(excluded.get(r.entryId) ?? {}), r.score, r.rank],
      );
    }
    await q.query(`update score_snapshots set status = 'SUPERSEDED' where campaign_id = $1 and status = 'PROVISIONAL' and id <> $2`, [campaignId, snap.id]);
    return { snapshotId: snap.id, version, unchanged: false };
  });
}

/** Admin: VOTING_CLOSED → REVIEWING with an immutable cutoff snapshot at vote_end. */
export async function startReview(ctx: ServiceContext, actor: Actor | null, campaignId: string) {
  const a = requirePlatform(ctx, actor, 'moderation');
  await ctx.db.tx(async (q) => {
    const c = await loadCampaign(q, campaignId, { forUpdate: true });
    campaignMachine.assert(c.status, 'REVIEWING');
    await q.query(`update campaigns set status = 'REVIEWING', version = version + 1 where id = $1`, [campaignId]);
    await audit(q, { actorId: a.userId, action: 'campaign.review_started', targetType: 'campaign', targetId: campaignId });
  });
  const c = await loadCampaign(ctx.db, campaignId);
  const snap = await createSnapshot(ctx, campaignId, { cutoff: new Date(c.vote_end), actorId: a.userId });
  const participants = await ctx.db.query<{ user_id: string }>(`select distinct user_id from entries where campaign_id = $1 and status = 'APPROVED'`, [campaignId]);
  for (const p of participants) await notify(ctx.db, p.user_id, 'campaign.provisional_results', { campaignId, appealDeadline: iso(c.appeal_deadline) });
  return snap;
}

export async function scoreRubric(ctx: ServiceContext, actor: Actor | null, entryId: string, input: { originality: number; productIntegration: number; execution: number; notes: string }) {
  const a = requirePlatform(ctx, actor, 'moderation');
  return ctx.db.tx(async (q) => {
    const e = await q.maybeOne<{ id: string; user_id: string; campaign_id: string; status: string }>(`select id, user_id, campaign_id, status from entries where id = $1`, [entryId]);
    if (!e) throw notFound('Entry');
    if (e.user_id === a.userId) throw forbidden('You cannot score your own entry');
    if (e.status !== 'APPROVED') throw conflict('Only approved entries are scored');
    const c = await loadCampaign(q, e.campaign_id);
    if (['FINALIZED', 'FULFILLED', 'CANCELED'].includes(c.status)) throw conflict('Campaign results are final');
    const existing = await q.query<{ reviewer_id: string; is_adjudication: boolean; originality: number; product_integration: number; execution: number }>(`select reviewer_id, is_adjudication, originality, product_integration, execution from rubric_scores where entry_id = $1`, [entryId]);
    if (existing.some((r) => r.reviewer_id === a.userId)) throw conflict('You already scored this entry');
    const independent = existing.filter((r) => !r.is_adjudication);
    let isAdjudication = false;
    if (independent.length >= 2) {
      const totals = independent.map((r) => (r.originality + r.product_integration + r.execution) / 3);
      if (Math.abs(totals[0]! - totals[1]!) <= c.rules.scoring.adjudicationThreshold) throw conflict('Entry already has two consistent rubric scores');
      if (existing.some((r) => r.is_adjudication)) throw conflict('Entry has already been adjudicated');
      isAdjudication = true;
    }
    await q.query(
      `insert into rubric_scores (entry_id, reviewer_id, originality, product_integration, execution, is_adjudication, notes) values ($1,$2,$3,$4,$5,$6,$7)`,
      [entryId, a.userId, input.originality, input.productIntegration, input.execution, isAdjudication, input.notes],
    );
    await audit(q, { actorId: a.userId, action: 'rubric.scored', targetType: 'entry', targetId: entryId, metadata: { isAdjudication } });
    return { isAdjudication };
  });
}

export async function rubricQueue(ctx: ServiceContext, actor: Actor | null) {
  const a = requirePlatform(ctx, actor, 'moderation');
  const rows = await ctx.db.query<{ id: string; campaign_title: string; handle: string; caption: string; playback_id: string | null; scores: number; mine: boolean; adjudication_needed: boolean }>(
    `select e.id, c.title as campaign_title, p.handle, e.caption, v.playback_id,
        (select count(*)::int from rubric_scores r where r.entry_id = e.id and not r.is_adjudication) as scores,
        exists(select 1 from rubric_scores r where r.entry_id = e.id and r.reviewer_id = $1) as mine,
        (select count(*) = 2 and max((r.originality + r.product_integration + r.execution)/3.0) - min((r.originality + r.product_integration + r.execution)/3.0) > (c.rules->'scoring'->>'adjudicationThreshold')::numeric
           and not exists(select 1 from rubric_scores r2 where r2.entry_id = e.id and r2.is_adjudication)
         from rubric_scores r where r.entry_id = e.id and not r.is_adjudication) as adjudication_needed
     from entries e join campaigns c on c.id = e.campaign_id join profiles p on p.id = e.user_id join videos v on v.id = e.video_id
     where e.status = 'APPROVED' and c.status in ('OPEN','SUBMISSION_CLOSED','VOTING_CLOSED','REVIEWING') and e.user_id <> $1
     order by c.vote_end, e.approved_at`,
    [a.userId],
  );
  const { playbackUrl } = await import('./entries');
  return rows.filter((r) => !r.mine && (r.scores < 2 || r.adjudication_needed)).map((r) => ({ entryId: r.id, campaignTitle: r.campaign_title, creatorHandle: r.handle, caption: r.caption, playbackUrl: playbackUrl(ctx, r.playback_id), independentScores: r.scores, adjudicationNeeded: r.adjudication_needed }));
}

/** GET /v1/campaigns/:id/leaderboard — public provisional or final snapshot; no voter data. */
export async function leaderboard(ctx: ServiceContext, campaignId: string, cursor: string | undefined, limit: number): Promise<LeaderboardDto> {
  const pub = await ctx.db.maybeOne(`select 1 from app_public.campaigns where id = $1`, [campaignId]);
  if (!pub) throw notFound('Campaign');
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const rows = await ctx.db.query<{ snapshot_id: string; snapshot_status: 'PROVISIONAL' | 'FINAL'; cutoff: Date; entry_id: string; rank: number; score: number; components: Record<string, number>; creator_handle: string }>(
    `select * from app_public.leaderboard where campaign_id = $1 and rank > $2 order by rank limit $3`,
    [campaignId, offset, limit + 1],
  );
  const head = rows[0] ?? (await ctx.db.maybeOne<{ snapshot_id: string; snapshot_status: 'PROVISIONAL' | 'FINAL'; cutoff: Date }>(`select snapshot_id, snapshot_status, cutoff from app_public.leaderboard where campaign_id = $1 limit 1`, [campaignId]));
  const snap = head ? await ctx.db.one<{ created_at: Date }>(`select created_at from score_snapshots where id = $1`, [head.snapshot_id]) : null;
  return {
    campaignId,
    snapshotId: head?.snapshot_id ?? null,
    status: head ? head.snapshot_status : 'NONE',
    cutoff: head ? iso(head.cutoff) : null,
    updatedAt: snap ? iso(snap.created_at) : null,
    rows: rows.slice(0, limit).map((r) => ({ rank: r.rank, entryId: r.entry_id, creatorHandle: r.creator_handle, score: Number(r.score), components: r.components })),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

/** Admin view of the latest snapshot + blockers to finalization. */
export async function finalizationReadiness(ctx: ServiceContext, actor: Actor | null, campaignId: string) {
  requirePlatform(ctx, actor, 'moderation');
  return readiness(ctx.db, await loadCampaign(ctx.db, campaignId));
}

async function readiness(q: Q, c: CampaignRow) {
  const snap = await q.maybeOne<{ id: string; version: number; cutoff: Date; status: string }>(`select id, version, cutoff, status from score_snapshots where campaign_id = $1 order by version desc limit 1`, [c.id]);
  const openAppeals = (await q.one<{ n: number }>(`select count(*)::int as n from appeals a join entries e on e.id = a.entry_id where e.campaign_id = $1 and a.status = 'OPEN'`, [c.id])).n;
  const openFlags = (await q.one<{ n: number }>(`select count(*)::int as n from fraud_flags where campaign_id = $1 and status = 'OPEN'`, [c.id])).n;
  const underReview = (await q.one<{ n: number }>(`select count(*)::int as n from entries e join entitlements en on en.id = e.entitlement_id where e.campaign_id = $1 and e.status = 'APPROVED' and en.status = 'UNDER_REVIEW'`, [c.id])).n;
  const scores = snap ? await q.query<{ entry_id: string; components: { creativityStatus?: string } }>(`select entry_id, components from entry_scores where snapshot_id = $1`, [snap.id]) : [];
  const creativityIncomplete = scores.filter((s) => s.components.creativityStatus !== 'COMPLETE').length;
  const approved = (await q.one<{ n: number }>(`select count(*)::int as n from entries where campaign_id = $1 and status = 'APPROVED'`, [c.id])).n;
  const staleSnapshot = !snap || new Date(snap.cutoff).getTime() !== new Date(c.vote_end).getTime() || scores.length !== approved;
  const blockers: string[] = [];
  if (c.status !== 'REVIEWING') blockers.push(`Campaign must be REVIEWING (is ${c.status})`);
  if (staleSnapshot) blockers.push('Latest snapshot must use the vote_end cutoff and include every approved entry — recompute');
  if (openAppeals) blockers.push(`${openAppeals} open appeal(s)`);
  if (openFlags) blockers.push(`${openFlags} open fraud flag(s)`);
  if (underReview) blockers.push(`${underReview} entr(ies) with eligibility under review`);
  if (creativityIncomplete) blockers.push(`${creativityIncomplete} entr(ies) missing rubric scores or adjudication`);
  if (approved < c.rules.minEntries) blockers.push(`Minimum entries not met (${approved}/${c.rules.minEntries}); apply the published remedy`);
  return { snapshot: snap ? { id: snap.id, version: snap.version, cutoff: iso(snap.cutoff), status: snap.status } : null, blockers, ready: blockers.length === 0 };
}

/**
 * POST /v1/admin/campaigns/:id/finalize — privileged, expected snapshot id,
 * approval reason, idempotency key. Locks the campaign row and issues exactly one
 * reward per final ranked entry (unique constraints make reruns harmless).
 */
export async function finalizeCampaign(ctx: ServiceContext, actor: Actor | null, campaignId: string, input: { expectedSnapshotId: string; reason: string }, idempotencyKey: string | null) {
  const a = requirePlatform(ctx, actor, 'admin');
  if (!idempotencyKey) throw invalid('Idempotency-Key header is required');
  const result = await ctx.db.tx(async (q) => {
    return withIdempotency(q, `finalize:${campaignId}`, idempotencyKey, input, async () => {
      if ((await killSwitches(q)).payoutsFrozen) throw forbidden('Reward issuance is frozen by the platform kill switch');
      const c = await loadCampaign(q, campaignId, { forUpdate: true });
      if (c.status === 'FINALIZED' || c.status === 'FULFILLED') throw conflict('Campaign is already finalized');
      if (c.frozen) throw forbidden('Campaign is frozen');
      const ready = await readiness(q, c);
      if (!ready.snapshot || ready.snapshot.id !== input.expectedSnapshotId) throw conflict('expectedSnapshotId is not the latest snapshot', { latest: ready.snapshot?.id ?? null });
      if (!ready.ready) throw ineligible('Campaign is not ready to finalize', { blockers: ready.blockers });
      const ranked = await q.query<{ entry_id: string; rank: number; user_id: string }>(
        `select es.entry_id, es.rank, e.user_id from entry_scores es join entries e on e.id = es.entry_id where es.snapshot_id = $1 order by es.rank`,
        [input.expectedSnapshotId],
      );
      const tiers = await tiersOf(q, campaignId);
      const plan = planRewards(ranked.map((r) => ({ entryId: r.entry_id, userId: r.user_id, rank: r.rank })), tiers);
      const now = ctx.clock.now();
      const store = await q.one<{ id: string }>(`select id from stores where id = $1`, [c.store_id]);
      for (const p of plan) {
        const reward = await q.one<{ id: string }>(
          `insert into rewards (campaign_id, entry_id, user_id, tier_id, snapshot_id, rank, type, status, value_minor, delivery_deadline, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
          [campaignId, p.entryId, p.userId, p.tier.id, input.expectedSnapshotId, p.rank, p.tier.type, p.tier.type === 'COUPON' ? 'FULFILLED' : 'ISSUED', p.tier.valueMinor,
            p.tier.type === 'PRIZE' ? new Date(now.getTime() + c.rules.prizes.deliveryDays * 86_400_000) : null, now],
        );
        if (p.tier.type === 'COUPON') {
          const code = couponCodeFor(ctx.config.COUPON_SECRET, reward.id);
          const cp = c.rules.coupon;
          await q.query(
            `insert into coupons (reward_id, owner_id, store_id, code_hash, code_last4, percent_off, max_discount_minor, min_spend_minor, currency, allowed_variant_ids, excluded_variant_ids, usage_limit, expires_at, terms)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [reward.id, p.userId, store.id, hashCouponCode(code), code.slice(-4), p.tier.percentOff, cp.maxDiscountMinor, cp.minSpendMinor, c.currency, cp.allowedVariantIds, cp.excludedVariantIds, cp.usageLimit,
              new Date(now.getTime() + cp.validityDays * 86_400_000), JSON.stringify({ exclusions: cp.exclusionsText })],
          );
          await q.query(`update rewards set fulfilled_at = now(), fulfillment_evidence = $2 where id = $1`, [reward.id, JSON.stringify({ method: 'COUPON_ISSUED' })]);
        }
        await notify(q, p.userId, 'reward.issued', { campaignId, rank: p.rank, type: p.tier.type, title: p.tier.title }, `reward:${reward.id}`);
      }
      await q.query(`update score_snapshots set status = 'FINAL' where id = $1`, [input.expectedSnapshotId]);
      await q.query(`update score_snapshots set status = 'SUPERSEDED' where campaign_id = $1 and id <> $2 and status = 'PROVISIONAL'`, [campaignId, input.expectedSnapshotId]);
      await q.query(`update campaigns set status = 'FINALIZED', finalized_at = now(), version = version + 1 where id = $1`, [campaignId]);
      await enqueue(q, 'campaign.finalized', { campaignId }, { dedupeKey: `campaign.finalized:${campaignId}` });
      await audit(q, { actorId: a.userId, action: 'campaign.finalized', targetType: 'campaign', targetId: campaignId, reason: input.reason, metadata: { snapshotId: input.expectedSnapshotId, rewards: plan.length } });
      return { status: 'FINALIZED', snapshotId: input.expectedSnapshotId, rewardsIssued: plan.length };
    });
  });
  return result;
}
