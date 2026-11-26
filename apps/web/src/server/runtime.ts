import 'server-only';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServices, drainOutbox, tick, type Services } from '@trendora/services';

/**
 * Process-wide service container. In sandbox/dev the web process also drains the
 * outbox and runs the maintenance tick so the full loop works with `pnpm dev`.
 * In production run workers/jobs (or the /v1/jobs/tick cron) instead.
 */
type G = typeof globalThis & { __trendora?: Services; __trendoraTimer?: NodeJS.Timeout; __trendoraDraining?: Promise<unknown> | null };
const g = globalThis as G;

function loadRootEnv() {
  if (process.env.DATABASE_URL) return;
  for (const p of [resolve(/*turbopackIgnore: true*/ process.cwd(), '.env'), resolve(/*turbopackIgnore: true*/ process.cwd(), '../../.env')]) {
    if (existsSync(/*turbopackIgnore: true*/ p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

export function services(): Services {
  if (g.__trendora) return g.__trendora;
  loadRootEnv();
  const s = createServices();
  const inProcessJobs = s.config.SANDBOX_MODE && process.env.INPROCESS_JOBS !== 'false';
  s.kickJobs = inProcessJobs ? () => void drainSoon(s) : undefined;
  g.__trendora = s;
  if (inProcessJobs && !g.__trendoraTimer) {
    g.__trendoraTimer = setInterval(() => {
      void (async () => {
        try {
          await s.dbClock?.refresh();
          await tick(s);
          await drainOutbox(s);
        } catch (e) {
          s.log.error('in-process tick failed', { err: (e as Error).message });
        }
      })();
    }, 15_000);
    g.__trendoraTimer.unref?.();
  }
  return s;
}

function drainSoon(s: Services) {
  if (g.__trendoraDraining) return g.__trendoraDraining;
  g.__trendoraDraining = new Promise((r) => setTimeout(r, 25))
    .then(() => drainOutbox(s))
    .catch((e) => s.log.error('outbox drain failed', { err: (e as Error).message }))
    .finally(() => {
      g.__trendoraDraining = null;
    });
  return g.__trendoraDraining;
}

/** Await in-flight background processing (used by sandbox endpoints so demos are deterministic). */
export async function settleJobs() {
  const s = services();
  await g.__trendoraDraining;
  await drainOutbox(s);
}

export async function freshClock() {
  await services().dbClock?.refresh();
}
