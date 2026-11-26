import { conflict, rateLimited } from '@trendora/contracts';
import { pgCode, PG_UNIQUE_VIOLATION } from '@trendora/db';
import { sha256Hex, canonicalJson } from '@trendora/core';
import type { Q } from './context';

/** Immutable audit trail entry (spec §11). */
export async function audit(q: Q, a: { actorId: string | null; action: string; targetType: string; targetId: string; reason?: string | null; metadata?: unknown; requestId?: string | null }) {
  await q.query(
    `insert into audit_log (actor_id, action, target_type, target_id, reason, metadata, request_id) values ($1,$2,$3,$4,$5,$6,$7)`,
    [a.actorId, a.action, a.targetType, a.targetId, a.reason ?? null, JSON.stringify(a.metadata ?? {}), a.requestId ?? null],
  );
}

/** Transactional outbox: written in the same transaction as the state change. */
export async function enqueue(q: Q, eventType: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; delayMs?: number } = {}) {
  await q.query(
    `insert into outbox (event_type, payload, dedupe_key, available_at)
     values ($1, $2, $3, now() + ($4::int * interval '1 millisecond'))
     on conflict (dedupe_key) do nothing`,
    [eventType, JSON.stringify(payload), opts.dedupeKey ?? null, opts.delayMs ?? 0],
  );
}

export async function notify(q: Q, userId: string, type: string, payload: Record<string, unknown>, dedupeKey?: string) {
  await q.query(
    `insert into notifications (user_id, type, payload, dedupe_key) values ($1,$2,$3,$4) on conflict (dedupe_key) do nothing`,
    [userId, type, JSON.stringify(payload), dedupeKey ?? null],
  );
}

/** Fixed-window rate limiter backed by Postgres (works across serverless instances). */
export async function rateLimit(q: Q, bucket: string, limit: number, windowSeconds: number, now: Date) {
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const row = await q.one<{ count: number }>(
    `insert into rate_limit_buckets (bucket, window_start, count) values ($1, $2, 1)
     on conflict (bucket, window_start) do update set count = rate_limit_buckets.count + 1
     returning count`,
    [bucket, windowStart],
  );
  if (row.count > limit) throw rateLimited();
}

/**
 * Idempotency for privileged/financial POSTs. Returns the stored response for a
 * replay with the same request hash; CONFLICT if the key is reused with a different body.
 */
export async function withIdempotency<T>(q: Q, scope: string, key: string, request: unknown, run: () => Promise<T>): Promise<T> {
  const requestHash = sha256Hex(canonicalJson(request));
  const existing = await q.maybeOne<{ request_hash: string; response: T | null }>(
    `select request_hash, response from idempotency_keys where scope = $1 and key = $2 for update`,
    [scope, key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw conflict('Idempotency-Key was already used with a different request');
    if (existing.response !== null) return existing.response;
  } else {
    try {
      await q.query(`insert into idempotency_keys (scope, key, request_hash) values ($1,$2,$3)`, [scope, key, requestHash]);
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) throw conflict('A request with this Idempotency-Key is in progress');
      throw e;
    }
  }
  const response = await run();
  await q.query(`update idempotency_keys set response = $3 where scope = $1 and key = $2`, [scope, key, JSON.stringify(response)]);
  return response;
}

export async function getSetting<T>(q: Q, key: string): Promise<T | null> {
  const row = await q.maybeOne<{ value: T }>(`select value from system_settings where key = $1`, [key]);
  return row?.value ?? null;
}

export async function setSetting(q: Q, key: string, value: unknown, actorId: string | null) {
  await q.query(
    `insert into system_settings (key, value, updated_by) values ($1,$2,$3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actorId],
  );
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
