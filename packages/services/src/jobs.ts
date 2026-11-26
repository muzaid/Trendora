import type { ServiceContext } from './context';
import { processWebhookEvent, RetryableError, reconcile } from './modules/payments';
import { expireCheckout, expireStaleCheckouts } from './modules/checkout';
import { grantEntitlementsForOrder, reviewEligibilityAfterRefund } from './modules/orders';
import { processVideo } from './modules/entries';
import { advanceCampaignPhases } from './modules/campaigns';
import { createSnapshot } from './modules/ranking';
import { enqueue } from './ops';

type Handler = (ctx: ServiceContext, payload: Record<string, string>) => Promise<void>;

/** Outbox event handlers (spec §14 event orchestration). */
export const handlers: Record<string, Handler> = {
  'webhook.process': (ctx, p) => processWebhookEvent(ctx, p.webhookEventId!),
  'checkout.expire': async (ctx, p) => void (await expireCheckout(ctx, p.checkoutId!)),
  'order.status_changed': (ctx, p) => grantEntitlementsForOrder(ctx, p.orderId!),
  'order.refunded': (ctx, p) => reviewEligibilityAfterRefund(ctx, p.orderId!),
  'video.uploaded': (ctx, p) => processVideo(ctx, p.videoId!, p.uploadId!),
  'video.asset.ready': async () => undefined, // human moderation queue picks entries up
  'entry.approved': async () => undefined,
  'campaign.draft.created': async () => undefined, // agent suggestions run on merchant request
  'campaign.voting_closed': async (ctx, p) => void (await createSnapshot(ctx, p.campaignId!, { onlyIfChanged: false })),
  'campaign.finalized': async () => undefined,
};

const MAX_ATTEMPTS = 8;

/** Claim and run due outbox rows. Safe to run concurrently (SKIP LOCKED). Returns processed count. */
export async function drainOutbox(ctx: ServiceContext, opts: { limit?: number; maxRounds?: number } = {}): Promise<number> {
  let total = 0;
  for (let round = 0; round < (opts.maxRounds ?? 10); round++) {
    const rows = await ctx.db.tx(async (q) =>
      q.query<{ id: string; event_type: string; payload: Record<string, string>; attempts: number }>(
        `update outbox set status = 'PROCESSING', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
         where id in (select id from outbox where (status = 'PENDING' and available_at <= now()) or (status = 'PROCESSING' and locked_until < now())
                      order by created_at limit $1 for update skip locked)
         returning id, event_type, payload, attempts`,
        [opts.limit ?? 25],
      ),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const handler = handlers[row.event_type];
      try {
        if (!handler) throw new Error(`no handler for ${row.event_type}`);
        await handler(ctx, row.payload);
        await ctx.db.query(`update outbox set status = 'DONE', processed_at = now(), last_error = null where id = $1`, [row.id]);
        total++;
      } catch (e) {
        const err = (e as Error).message;
        const dead = row.attempts >= MAX_ATTEMPTS;
        const backoffMs = Math.min(60_000 * 30, 500 * 2 ** row.attempts);
        await ctx.db.query(
          `update outbox set status = $2, last_error = $3, available_at = now() + ($4::int * interval '1 millisecond'), locked_until = null where id = $1`,
          [row.id, dead ? 'DEAD' : 'PENDING', err.slice(0, 1000), backoffMs],
        );
        const level = (e as Error).name === RetryableError.name && !dead ? 'info' : 'error';
        ctx.log[level === 'info' ? 'info' : 'error']('outbox handler failed', { outboxId: row.id, eventType: row.event_type, attempt: row.attempts, dead, err });
      }
    }
  }
  return total;
}

/** Periodic maintenance tick (every ~15s from the worker; also safe to call on demand). */
export async function tick(ctx: ServiceContext) {
  const phases = await advanceCampaignPhases(ctx);
  const expired = await expireStaleCheckouts(ctx);
  // Provisional leaderboard refresh (target: within 60 seconds).
  const live = await ctx.db.query<{ id: string }>(`select id from campaigns where status in ('OPEN','SUBMISSION_CLOSED') and not frozen`);
  let snapshots = 0;
  for (const c of live) {
    const r = await createSnapshot(ctx, c.id, { onlyIfChanged: true });
    if (!r.unchanged) snapshots++;
  }
  await ctx.db.query(`delete from rate_limit_buckets where window_start < now() - interval '1 day'`);
  return { phases, expired, snapshots };
}

export async function dailyReconciliation(ctx: ServiceContext) {
  const r = await reconcile(ctx, null, { system: true });
  if (!r.ok) ctx.log.error('reconciliation mismatch', r);
  return r;
}

export { enqueue };
