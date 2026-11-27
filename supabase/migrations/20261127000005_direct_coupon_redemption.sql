-- Direct (off-platform) coupon redemption: shoppers can use a TRENDORA reward
-- coupon when buying from the business itself (physical store, own website, POS).
-- No money flows through TRENDORA for these sales, so no journal entries are
-- written; the redemption row consumes the coupon's usage and reduces liability.
--
-- Rollback: drop table store_api_keys; delete from coupon_redemptions where
-- channel = 'STORE_DIRECT'; drop the added columns/constraints; restore
-- order_id not null.

alter table public.coupon_redemptions
  alter column order_id drop not null,
  add column channel text not null default 'TRENDORA' check (channel in ('TRENDORA', 'STORE_DIRECT')),
  add column store_id uuid references public.stores (id) on delete restrict,
  add column external_reference text check (external_reference is null or char_length(external_reference) between 1 and 120),
  add column purchase_minor bigint check (purchase_minor is null or purchase_minor > 0),
  add column redeemed_by uuid references public.profiles (id) on delete restrict,
  add column redeemed_via_key uuid,
  add constraint coupon_redemptions_channel_shape check (
    (channel = 'TRENDORA' and order_id is not null and external_reference is null)
    or (channel = 'STORE_DIRECT' and order_id is null and store_id is not null
        and external_reference is not null and purchase_minor is not null and status = 'REDEEMED')
  );

-- The same receipt/order reference can never redeem a coupon twice (idempotent retries).
create unique index coupon_redemptions_direct_ref_uniq on public.coupon_redemptions (coupon_id, external_reference)
  where channel = 'STORE_DIRECT';
create index coupon_redemptions_store_idx on public.coupon_redemptions (store_id, created_at desc)
  where channel = 'STORE_DIRECT';

-- API keys a business uses to validate/redeem codes from its own website or POS.
-- Only a SHA-256 hash is stored; the plaintext is shown once at creation.
create table public.store_api_keys (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{coupons:redeem}',
  created_by uuid not null references public.profiles (id) on delete restrict,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index store_api_keys_store_idx on public.store_api_keys (store_id);

alter table public.coupon_redemptions
  add constraint coupon_redemptions_key_fk foreign key (redeemed_via_key)
  references public.store_api_keys (id) on delete restrict;

alter table public.store_api_keys enable row level security;
alter table public.store_api_keys force row level security;
-- Keys are managed through the server only; clients never read hashes.
revoke all on public.store_api_keys from anon, authenticated;
