import { forbidden, notFound, unauthenticated, conflict, type MerchantRole, type PlatformRole } from '@trendora/contracts';
import { merchantCan, platformCan, type MerchantPermission, type PlatformPermission } from '@trendora/core';
import type { Actor, Q, ServiceContext } from '../context';
import { verifyToken } from '../adapters/auth';

export async function loadActor(q: Q, userId: string, aal: 'aal1' | 'aal2' = 'aal1'): Promise<Actor | null> {
  const p = await q.maybeOne<{ id: string; handle: string; display_name: string; status: string; country: string | null; birth_year: number | null; created_at: Date; risk_score: number }>(
    `select id, handle, display_name, status, country, birth_year, created_at, risk_score from profiles where id = $1`,
    [userId],
  );
  if (!p) return null;
  const roles = await q.query<{ role: PlatformRole }>(`select role from platform_roles where user_id = $1`, [userId]);
  const mems = await q.query<{ org_id: string; role: MerchantRole }>(`select org_id, role from memberships where user_id = $1`, [userId]);
  return {
    userId: p.id,
    handle: p.handle,
    displayName: p.display_name,
    status: p.status,
    country: p.country,
    birthYear: p.birth_year,
    createdAt: new Date(p.created_at),
    riskScore: p.risk_score,
    platformRoles: roles.map((r) => r.role),
    memberships: mems.map((m) => ({ orgId: m.org_id, role: m.role })),
    aal,
  };
}

/** Resolve a bearer token to an Actor (null when anonymous / invalid). */
export async function actorFromToken(ctx: ServiceContext, token: string | null | undefined): Promise<Actor | null> {
  if (!token) return null;
  const claims = await verifyToken(token, {
    secret: ctx.config.AUTH_JWT_SECRET,
    issuer: ctx.config.AUTH_JWT_ISSUER,
    supabaseSecret: ctx.config.SUPABASE_JWT_SECRET,
    supabaseUrl: ctx.config.SUPABASE_URL,
  });
  if (!claims) return null;
  return loadActor(ctx.db, claims.sub, claims.aal);
}

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw unauthenticated();
  if (actor.status !== 'ACTIVE') throw forbidden('Your account is suspended');
  return actor;
}

/** Platform roles (moderator / finance / admin). MFA (aal2) is required when configured. */
export function requirePlatform(ctx: ServiceContext, actor: Actor | null, perm: PlatformPermission): Actor {
  const a = requireActor(actor);
  if (!platformCan(a.platformRoles, perm)) throw forbidden();
  if (ctx.config.REQUIRE_MFA_FOR_PRIVILEGED && a.aal !== 'aal2') throw forbidden('Multi-factor authentication is required for this action');
  return a;
}

export function orgRole(actor: Actor, orgId: string): MerchantRole | null {
  return actor.memberships.find((m) => m.orgId === orgId)?.role ?? null;
}

export function requireOrgPermission(actor: Actor | null, orgId: string, perm: MerchantPermission): Actor {
  const a = requireActor(actor);
  const role = orgRole(a, orgId);
  if (!role || !merchantCan(role, perm)) throw forbidden();
  return a;
}

export async function storeOrg(q: Q, storeId: string): Promise<{ orgId: string; verification: string; status: string; currency: string; slug: string; name: string }> {
  const s = await q.maybeOne<{ org_id: string; verification_status: string; status: string; currency: string; slug: string; name: string }>(
    `select s.org_id, o.verification_status, s.status, s.currency, s.slug, s.name from stores s join organizations o on o.id = s.org_id where s.id = $1 and s.deleted_at is null`,
    [storeId],
  );
  if (!s) throw notFound('Store');
  return { orgId: s.org_id, verification: s.verification_status, status: s.status, currency: s.currency, slug: s.slug, name: s.name };
}

export async function requireStorePermission(q: Q, actor: Actor | null, storeId: string, perm: MerchantPermission) {
  const store = await storeOrg(q, storeId);
  const a = requireOrgPermission(actor, store.orgId, perm);
  return { actor: a, store };
}

export async function me(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  const p = await ctx.db.one<{ locale: string; privacy_settings: unknown; birth_year: number | null; country: string | null }>(
    `select locale, privacy_settings, birth_year, country from profiles where id = $1`,
    [a.userId],
  );
  const orgs = await ctx.db.query<{ id: string; name: string; verification_status: string; role: string }>(
    `select o.id, o.name, o.verification_status, m.role from memberships m join organizations o on o.id = m.org_id where m.user_id = $1 order by o.name`,
    [a.userId],
  );
  const unread = await ctx.db.one<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [a.userId]);
  return {
    id: a.userId, handle: a.handle, displayName: a.displayName, country: p.country, birthYear: p.birth_year, locale: p.locale,
    privacySettings: p.privacy_settings, platformRoles: a.platformRoles, organizations: orgs.map((o) => ({ id: o.id, name: o.name, verificationStatus: o.verification_status, role: o.role })),
    unreadNotifications: unread.n,
  };
}

export async function updateProfile(ctx: ServiceContext, actor: Actor | null, patch: { displayName?: string; locale?: string; privacySettings?: Record<string, boolean> }) {
  const a = requireActor(actor);
  await ctx.db.query(
    `update profiles set display_name = coalesce($2, display_name), locale = coalesce($3, locale),
       privacy_settings = privacy_settings || coalesce($4::jsonb, '{}'::jsonb) where id = $1`,
    [a.userId, patch.displayName ?? null, patch.locale ?? null, patch.privacySettings ? JSON.stringify(patch.privacySettings) : null],
  );
  return me(ctx, await loadActor(ctx.db, a.userId, a.aal));
}

/**
 * Create a profile for a newly signed-up auth user (Supabase Auth). The country
 * and birth year are self-declared and only used for eligibility.
 */
export async function bootstrapProfile(ctx: ServiceContext, userId: string, input: { handle: string; displayName: string; country: string; birthYear: number }) {
  const exists = await ctx.db.maybeOne(`select 1 from profiles where id = $1`, [userId]);
  if (exists) throw conflict('Profile already exists');
  await ctx.db.query(`insert into profiles (id, handle, display_name, country, birth_year) values ($1,$2,$3,$4,$5)`, [userId, input.handle, input.displayName, input.country, input.birthYear]);
}

export async function listNotifications(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  const rows = await ctx.db.query<{ id: string; type: string; payload: unknown; read_at: Date | null; created_at: Date }>(
    `select id, type, payload, read_at, created_at from notifications where user_id = $1 order by created_at desc limit 50`,
    [a.userId],
  );
  await ctx.db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [a.userId]);
  return rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, read: r.read_at !== null, createdAt: new Date(r.created_at).toISOString() }));
}

/** Any member of the store's organization (read-only merchant views). */
export async function requireStoreMember(q: Q, actor: Actor | null, storeId: string) {
  const store = await storeOrg(q, storeId);
  const a = requireActor(actor);
  const role = orgRole(a, store.orgId);
  if (!role) throw forbidden();
  return { actor: a, store, role };
}
