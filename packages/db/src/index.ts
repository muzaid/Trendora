import pg from 'pg';

/**
 * Thin, explicit data access over node-postgres. Services write SQL directly and
 * rely on database constraints + transactions for money, inventory, eligibility
 * and reward uniqueness.
 */

// Return bigint (int8) and numeric as JS numbers. Minor-unit amounts stay well
// under Number.MAX_SAFE_INTEGER (enforced by API validation).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends object = Row>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends object = Row>(text: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends object = Row>(text: string, params?: unknown[]): Promise<T | null>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Tx) => Promise<T>, opts?: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' }): Promise<T>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

export interface Tx extends Queryable {
  /** Run fn after the transaction commits (e.g. notify the job runner). */
  afterCommit(fn: () => void | Promise<void>): void;
}

export class NotFoundRowError extends Error {
  constructor() {
    super('Expected exactly one row');
    this.name = 'NotFoundRowError';
  }
}

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  const query = async <T extends object>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[];
  return {
    query,
    async one<T extends object>(text: string, params?: unknown[]) {
      const rows = await query<T>(text, params);
      if (rows.length !== 1) throw new NotFoundRowError();
      return rows[0]!;
    },
    async maybeOne<T extends object>(text: string, params?: unknown[]) {
      const rows = await query<T>(text, params);
      return rows[0] ?? null;
    },
  };
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, application_name: 'trendora' });
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: err.message })));
  const base = wrap(pool);
  return {
    ...base,
    pool,
    async tx(fn, txOpts) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        const after: (() => void | Promise<void>)[] = [];
        try {
          await client.query(`BEGIN ISOLATION LEVEL ${txOpts?.isolation ?? 'READ COMMITTED'}`);
          const result = await fn({ ...wrap(client), afterCommit: (f) => after.push(f) });
          await client.query('COMMIT');
          client.release();
          for (const f of after) {
            try {
              await f();
            } catch (e) {
              console.error(JSON.stringify({ level: 'error', msg: 'afterCommit hook failed', err: (e as Error).message }));
            }
          }
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
          const code = (e as { code?: string }).code;
          if (code && RETRYABLE.has(code) && attempt < 4) {
            await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
            continue;
          }
          throw e;
        }
      }
    },
    close: () => pool.end(),
  };
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FK_VIOLATION = '23503';
export function pgCode(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}
export function pgConstraint(e: unknown): string | undefined {
  return (e as { constraint?: string })?.constraint;
}

export { migrate, resetDatabase, MIGRATIONS_DIR } from './migrate';
