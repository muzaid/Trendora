import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../../../supabase/migrations');
const AUTH_STUB = resolve(here, '../../../supabase/local/auth_stub.sql');

/**
 * Applies supabase/migrations in order, tracking them in app_migrations.
 * With { localAuthStub: true } it first installs the local auth emulation
 * (plain Postgres only — never against Supabase, which owns the auth schema).
 */
export async function migrate(connectionString: string, opts: { localAuthStub?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    if (opts.localAuthStub) await client.query(readFileSync(AUTH_STUB, 'utf8'));
    await client.query(`create table if not exists public.app_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await client.query<{ name: string }>('select name from public.app_migrations')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      log(`applying ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
        await client.query('insert into public.app_migrations (name) values ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    // Migration bookkeeping is server-only.
    await client.query('alter table public.app_migrations enable row level security');
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
}

/** Drop and recreate a database (local/dev/test only). Refuses non-local hosts. */
export async function resetDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname)) {
    throw new Error(`refusing to reset non-local database host ${url.hostname}`);
  }
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error('unsafe database name');
  const admin = new URL(connectionString);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists ${dbName} with (force)`);
    await client.query(`create database ${dbName}`);
  } finally {
    await client.end();
  }
}
