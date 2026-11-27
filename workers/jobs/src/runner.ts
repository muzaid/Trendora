import '@trendora/db/load-env';
import { createServices, drainOutbox, tick, dailyReconciliation } from '@trendora/services';

/**
 * Background worker (spec §9 Jobs): drains the transactional outbox (webhook
 * processing, entitlements, transcode, notifications) with retries + dead-letter,
 * runs the maintenance tick (phase transitions, checkout expiry, provisional
 * leaderboard snapshots ≤60s) and daily ledger reconciliation.
 *
 * Deploy as a long-running process (Fly/Render/ECS) or replace with Trigger.dev /
 * Inngest functions calling the same exported handlers. Safe to run N replicas.
 */
const s = createServices();
const TICK_MS = Number(process.env.JOBS_TICK_MS ?? 15_000);
const DRAIN_MS = Number(process.env.JOBS_DRAIN_MS ?? 1_000);
let stopping = false;
let lastRecon = 0;

async function loop(name: string, everyMs: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    const started = Date.now();
    try {
      await s.dbClock?.refresh();
      const r = await fn();
      if (r && typeof r === 'object' && Object.values(r as object).some((v) => (Array.isArray(v) ? v.length : Number(v) > 0))) s.log.info(`${name} done`, { result: r });
    } catch (e) {
      s.log.error(`${name} failed`, { err: (e as Error).message });
    }
    await new Promise((res) => setTimeout(res, Math.max(50, everyMs - (Date.now() - started))));
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    s.log.info('worker stopping', { sig });
    setTimeout(() => void s.db.close().then(() => process.exit(0)), 2_000);
  });
}

s.log.info('worker started', { sandbox: s.config.SANDBOX_MODE });
void loop('outbox', DRAIN_MS, async () => ({ processed: await drainOutbox(s) }));
void loop('tick', TICK_MS, async () => {
  const r = await tick(s);
  if (Date.now() - lastRecon > 24 * 3_600_000) {
    lastRecon = Date.now();
    await dailyReconciliation(s);
  }
  return r;
});
