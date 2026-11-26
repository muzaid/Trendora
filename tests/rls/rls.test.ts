import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { catalog } from '@trendora/services';
import { createWorld, createMarket, buyAndPay, type World, type Market } from '../support/world';

/**
 * Exercises RLS exactly as Supabase PostgREST would: role `authenticated` or
 * `anon` with the JWT `sub` claim in request.jwt.claims.
 */
let w: World;
let m: Market;
let client: pg.Client;
let buyerA: string;
let buyerB: string;
let orderA: string;
let rivalOwner: string;

beforeAll(async () => {
  w = await createWorld();
  m = await createMarket(w);
  const a = await w.user('rls_buyer_a');
  const b = await w.user('rls_buyer_b');
  buyerA = a.userId;
  buyerB = b.userId;
  orderA = (await buyAndPay(w, m, a)).orderId;
  await buyAndPay(w, m, b);
  const r = await w.user('rls_rival');
  rivalOwner = r.userId;
  await catalog.onboardMerchant(w.s, r, { organizationName: 'Rival', legalName: 'Rival', country: 'US', store: { name: 'Rival', slug: 'rival-rls', description: '', currency: 'USD', country: 'US', shippingPolicy: '', returnPolicy: '' } });
  client = new pg.Client({ connectionString: (w.db.pool as unknown as { options: { connectionString: string } }).options.connectionString });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await w?.drop();
});

async function as<T = Record<string, unknown>>(role: 'anon' | 'authenticated', sub: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })]);
    await client.query(`set local role ${role}`);
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.query('rollback');
  }
}

describe('row level security', () => {
  it('buyers see only their own orders, entitlements and checkouts', async () => {
    const rows = await as('authenticated', buyerA, 'select id, buyer_id from orders');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.buyer_id === buyerA)).toBe(true);
    expect((await as('authenticated', buyerA, 'select user_id from entitlements')).every((r) => r.user_id === buyerA)).toBe(true);
    expect(await as('authenticated', buyerB, 'select id from orders where id = $1', [orderA])).toHaveLength(0);
    expect((await as('authenticated', buyerA, 'select * from profiles')).map((r) => r.id)).toEqual([buyerA]);
  });

  it('merchant members see their organization’s orders; other merchants see none', async () => {
    const own = await as('authenticated', m.owner.userId, 'select id from orders');
    expect(own.length).toBeGreaterThanOrEqual(2);
    expect(await as('authenticated', rivalOwner, 'select id from orders')).toHaveLength(0);
    expect(await as('authenticated', rivalOwner, 'select id from campaigns')).toHaveLength(0);
    expect(await as('authenticated', rivalOwner, 'select variant_id from inventory where variant_id = $1', [m.variantId])).toHaveLength(0);
    // Fulfilment staff can see orders but not payment rows.
    expect((await as('authenticated', m.staff.userId, 'select id from orders')).length).toBeGreaterThan(0);
    expect(await as('authenticated', m.staff.userId, 'select id from payments')).toHaveLength(0);
  });

  it('finance, moderation and ops tables are never readable by clients', async () => {
    for (const t of ['audit_log', 'journals', 'journal_lines', 'outbox', 'webhook_events', 'fraud_flags', 'engagement_events', 'platform_roles', 'system_settings']) {
      await expect(as('authenticated', m.admin.userId, `select * from ${t} limit 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it('anonymous users read only approved public views', async () => {
    await expect(as('anon', null, 'select * from orders limit 1')).rejects.toThrow(/permission denied/);
    await expect(as('anon', null, 'select * from profiles limit 1')).rejects.toThrow(/permission denied/);
    const stores = await as('anon', null, 'select slug from app_public.stores');
    expect(stores.map((s) => s.slug)).toEqual(['glowlab']); // unverified rival store is hidden
    const camps = await as('anon', null, 'select id from app_public.campaigns');
    expect(camps.map((c) => c.id)).toContain(m.campaignId);
    const cols = await as('anon', null, `select column_name from information_schema.columns where table_schema = 'app_public' and table_name = 'feed'`);
    expect(cols.map((c) => c.column_name)).not.toContain('user_id');
  });

  it('clients cannot escalate privileges or write financial rows directly', async () => {
    await expect(as('authenticated', buyerA, `update profiles set risk_score = 0, status = 'ACTIVE' where id = $1`, [buyerA])).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', buyerA, `insert into platform_roles (user_id, role) values ($1, 'ADMIN')`, [buyerA])).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', buyerA, `update orders set total_minor = 0 where id = $1`, [orderA])).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', buyerA, `insert into coupons (reward_id) values (gen_random_uuid())`)).rejects.toThrow(/permission denied/);
    const upd = await as('authenticated', buyerA, `update profiles set display_name = 'New Name' where id = $1 returning id`, [buyerA]);
    expect(upd).toHaveLength(1);
    expect(await as('authenticated', buyerA, `update profiles set display_name = 'Hacked' where id = $1 returning id`, [buyerB])).toHaveLength(0);
  });
});
