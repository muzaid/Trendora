-- TRENDORA row-level security and public read views.
--
-- Model:
--   * The server (Next.js routes / workers) connects with a privileged role and
--     enforces authorization in the service layer. RLS is defense in depth for any
--     direct PostgREST / client access with a user JWT.
--   * anon/authenticated never read base tables publicly; public data is exposed
--     only through the app_public views below.
--   * Users read their own orders, entitlements, drafts and rewards.
--   * Merchant members read rows belonging to their organization (role-checked).
--   * Finance / moderation data is never exposed via RLS: server routes only.

create schema if not exists app_public;

create or replace function app.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.is_org_member(p_org uuid, p_roles text[] default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid()
      and (p_roles is null or m.role = any (p_roles))
  )
$$;

create or replace function app.store_org(p_store uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.stores where id = p_store
$$;

create or replace function app.is_store_member(p_store uuid, p_roles text[] default null)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_org_member(app.store_org(p_store), p_roles)
$$;

revoke all on function app.is_org_member(uuid, text[]) from public;
revoke all on function app.store_org(uuid) from public;
revoke all on function app.is_store_member(uuid, text[]) from public;

-- Enable RLS on every table in public.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

-- Base grants: authenticated may SELECT (filtered by policies). All writes go
-- through the server, so no INSERT/UPDATE/DELETE grants for client roles except
-- the narrow profile self-update below.
grant usage on schema public to anon, authenticated;
grant usage on schema app to anon, authenticated;
grant execute on function app.uid() to anon, authenticated;
grant execute on function app.is_org_member(uuid, text[]) to authenticated;
grant execute on function app.store_org(uuid) to authenticated;
grant execute on function app.is_store_member(uuid, text[]) to authenticated;
grant select on all tables in schema public to authenticated;
revoke select on public.audit_log, public.outbox, public.webhook_events, public.idempotency_keys,
  public.rate_limit_buckets, public.system_settings, public.journals, public.journal_lines,
  public.fraud_flags, public.rubric_scores, public.engagement_events, public.platform_roles
  from authenticated;

-- Profiles: self read/update (limited columns).
create policy profiles_self_select on public.profiles for select to authenticated
  using (id = auth.uid());
grant update (display_name, locale, privacy_settings) on public.profiles to authenticated;
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Organizations / memberships.
create policy organizations_member_select on public.organizations for select to authenticated
  using (app.is_org_member(id));
create policy memberships_member_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.is_org_member(org_id, array['OWNER', 'MANAGER']));

-- Catalog: merchant members see their org's rows (public reads use views).
create policy stores_member_select on public.stores for select to authenticated
  using (app.is_org_member(org_id));
create policy products_member_select on public.products for select to authenticated
  using (app.is_store_member(store_id));
create policy variants_member_select on public.variants for select to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and app.is_store_member(p.store_id)));
create policy inventory_member_select on public.inventory for select to authenticated
  using (exists (select 1 from public.variants v join public.products p on p.id = v.product_id
                 where v.id = variant_id and app.is_store_member(p.store_id)));
create policy price_history_member_select on public.price_history for select to authenticated
  using (exists (select 1 from public.variants v join public.products p on p.id = v.product_id
                 where v.id = variant_id and app.is_store_member(p.store_id)));

-- Orders: buyer, or merchant members with order-related roles.
create policy orders_buyer_select on public.orders for select to authenticated
  using (buyer_id = auth.uid()
         or app.is_store_member(store_id, array['OWNER', 'MANAGER', 'FULFILLMENT', 'ANALYST']));
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.buyer_id = auth.uid()
                      or app.is_store_member(o.store_id, array['OWNER', 'MANAGER', 'FULFILLMENT', 'ANALYST']))));
create policy checkouts_buyer_select on public.checkouts for select to authenticated
  using (buyer_id = auth.uid());
create policy stock_reservations_none on public.stock_reservations for select to authenticated
  using (false);
create policy payments_select on public.payments for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.buyer_id = auth.uid() or app.is_store_member(o.store_id, array['OWNER', 'MANAGER']))));
create policy refunds_select on public.refunds for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.buyer_id = auth.uid() or app.is_store_member(o.store_id, array['OWNER', 'MANAGER']))));
create policy disputes_select on public.disputes for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and app.is_store_member(o.store_id, array['OWNER', 'MANAGER'])));

-- Campaigns: merchant members (drafts included).
create policy campaigns_member_select on public.campaigns for select to authenticated
  using (app.is_store_member(store_id));
create policy campaign_skus_member_select on public.campaign_skus for select to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id and app.is_store_member(c.store_id)));
create policy prize_tiers_member_select on public.prize_tiers for select to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id and app.is_store_member(c.store_id)));
create policy campaign_rule_versions_member_select on public.campaign_rule_versions for select to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id and app.is_store_member(c.store_id)));

-- Creator-owned rows.
create policy entitlements_owner_select on public.entitlements for select to authenticated
  using (user_id = auth.uid());
create policy alt_entry_owner_select on public.alternative_entry_requests for select to authenticated
  using (user_id = auth.uid());
create policy videos_owner_select on public.videos for select to authenticated
  using (owner_id = auth.uid());
create policy entries_owner_select on public.entries for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.campaigns c where c.id = campaign_id and app.is_store_member(c.store_id)));
create policy likes_owner_select on public.likes for select to authenticated
  using (user_id = auth.uid());
create policy share_links_owner_select on public.share_links for select to authenticated
  using (sharer_id = auth.uid());
create policy comments_author_select on public.comments for select to authenticated
  using (author_id = auth.uid());
create policy follows_self_select on public.follows for select to authenticated
  using (follower_id = auth.uid() or creator_id = auth.uid());
create policy score_snapshots_none on public.score_snapshots for select to authenticated using (false);
create policy entry_scores_owner_select on public.entry_scores for select to authenticated
  using (exists (select 1 from public.entries e where e.id = entry_id and e.user_id = auth.uid()));

create policy rewards_owner_select on public.rewards for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.campaigns c where c.id = campaign_id
                    and app.is_store_member(c.store_id, array['OWNER', 'MANAGER', 'FULFILLMENT'])));
create policy coupons_owner_select on public.coupons for select to authenticated
  using (owner_id = auth.uid() or app.is_store_member(store_id, array['OWNER', 'MANAGER']));
create policy coupon_redemptions_select on public.coupon_redemptions for select to authenticated
  using (exists (select 1 from public.coupons c where c.id = coupon_id
                 and (c.owner_id = auth.uid() or app.is_store_member(c.store_id, array['OWNER', 'MANAGER']))));

create policy reports_reporter_select on public.reports for select to authenticated
  using (reporter_id = auth.uid());
create policy appeals_owner_select on public.appeals for select to authenticated
  using (user_id = auth.uid());
create policy blocks_owner_select on public.blocks for select to authenticated
  using (user_id = auth.uid());
create policy notifications_owner_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy agent_runs_member_select on public.agent_runs for select to authenticated
  using (org_id is not null and app.is_org_member(org_id, array['OWNER', 'MANAGER', 'CAMPAIGNS', 'ANALYST']));

-- ---------------------------------------------------------------------------
-- Public views (owned by the migration role; expose approved, safe columns only).
-- ---------------------------------------------------------------------------
create or replace view app_public.stores as
  select s.id, s.slug, s.name, s.description, s.currency, s.country, s.shipping_policy,
         s.return_policy, s.logo_url
  from public.stores s
  join public.organizations o on o.id = s.org_id
  where s.status = 'ACTIVE' and s.deleted_at is null and o.verification_status = 'VERIFIED';

create or replace view app_public.products as
  select p.id, p.store_id, p.title, p.description, p.image_urls
  from public.products p
  join app_public.stores s on s.id = p.store_id
  where p.status = 'ACTIVE' and p.deleted_at is null;

create or replace view app_public.variants as
  select v.id, v.product_id, v.sku, v.title, v.price_minor, v.currency, v.attributes,
         (i.available > 0) as in_stock
  from public.variants v
  join app_public.products p on p.id = v.product_id
  left join public.inventory i on i.variant_id = v.id
  where v.status = 'ACTIVE';

create or replace view app_public.campaigns as
  select c.id, c.store_id, c.title, c.tagline, c.description, c.status, c.starts_at,
         c.submission_end, c.vote_end, c.appeal_deadline, c.display_timezone, c.currency,
         c.rules, c.rules_version
  from public.campaigns c
  join app_public.stores s on s.id = c.store_id
  where c.status in ('SCHEDULED', 'OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED', 'REVIEWING',
                     'FINALIZED', 'FULFILLED', 'CANCELED');

create or replace view app_public.prize_tiers as
  select t.id, t.campaign_id, t.rank_from, t.rank_to, t.type, t.title, t.value_minor,
         t.percent_off, t.terms
  from public.prize_tiers t join app_public.campaigns c on c.id = t.campaign_id;

create or replace view app_public.feed as
  select e.id as entry_id, e.campaign_id, e.caption, e.approved_at, v.playback_id, v.poster_url,
         v.duration_ms, p.handle as creator_handle, p.display_name as creator_name,
         c.title as campaign_title, c.store_id
  from public.entries e
  join public.videos v on v.id = e.video_id
  join public.profiles p on p.id = e.user_id
  join app_public.campaigns c on c.id = e.campaign_id
  where e.status = 'APPROVED' and v.status = 'READY' and v.moderation_status = 'APPROVED'
    and p.status = 'ACTIVE';

create or replace view app_public.leaderboard as
  select s.campaign_id, s.id as snapshot_id, s.status as snapshot_status, s.cutoff,
         es.entry_id, es.rank, es.score, es.components,
         case when (p.privacy_settings ->> 'showOnLeaderboard')::boolean is false
              then 'hidden' else p.handle end as creator_handle
  from public.score_snapshots s
  join public.entry_scores es on es.snapshot_id = s.id
  join public.entries e on e.id = es.entry_id
  join public.profiles p on p.id = e.user_id
  where s.status in ('PROVISIONAL', 'FINAL')
    and s.version = (select max(s2.version) from public.score_snapshots s2
                     where s2.campaign_id = s.campaign_id and s2.status in ('PROVISIONAL', 'FINAL'));

grant usage on schema app_public to anon, authenticated;
grant select on all tables in schema app_public to anon, authenticated;
