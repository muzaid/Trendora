-- TRENDORA P0/P1 foundation: identity, organizations, catalog, commerce, ledger.
-- Conventions: UUID primary keys, timestamptz, created_at on each table, money as
-- bigint minor units with ISO-4217 currency, quantities as integer.
-- Financial and campaign records use ON DELETE RESTRICT. Public catalog rows are
-- soft-deleted (deleted_at) only.

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,30}$'),
  locale text not null default 'en' check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  country char(2),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'DELETED')),
  birth_year integer check (birth_year between 1900 and 2100),
  privacy_settings jsonb not null default '{"showOnLeaderboard": true, "marketingEmails": false}'::jsonb,
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  mfa_enrolled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.platform_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('MODERATOR', 'FINANCE', 'ADMIN')),
  granted_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  legal_name text,
  country char(2),
  verification_status text not null default 'PENDING'
    check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED')),
  verification_notes text,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('OWNER', 'MANAGER', 'CATALOG', 'CAMPAIGNS', 'FULFILLMENT', 'ANALYST')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  description text not null default '',
  currency char(3) not null default 'USD',
  country char(2) not null default 'US',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'SUSPENDED')),
  shipping_policy text not null default '',
  return_policy text not null default '',
  logo_url text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index stores_org_idx on public.stores (org_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  image_urls jsonb not null default '[]'::jsonb,
  fulfillment jsonb not null default '{"shipsFrom": "US", "handlingDays": 2}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index products_store_status_idx on public.products (store_id, status);

create table public.variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  sku text not null check (char_length(sku) between 1 and 64),
  title text not null default 'Default',
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null,
  attributes jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  unique (product_id, sku)
);
create index variants_product_idx on public.variants (product_id);

create table public.price_history (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id) on delete restrict,
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null,
  changed_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index price_history_variant_idx on public.price_history (variant_id, created_at desc);

-- available: sellable units not held; reserved: units held by ACTIVE reservations.
create table public.inventory (
  variant_id uuid primary key references public.variants (id) on delete restrict,
  available integer not null check (available >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Commerce
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles (id) on delete restrict,
  store_id uuid not null references public.stores (id) on delete restrict,
  currency char(3) not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELED')),
  financial_status text not null default 'NONE'
    check (financial_status in ('NONE', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')),
  payment_ref text unique,
  shipping_address jsonb,
  tracking jsonb,
  paid_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  check (total_minor = subtotal_minor - discount_minor)
);
create index orders_buyer_created_idx on public.orders (buyer_id, created_at desc);
create index orders_store_status_idx on public.orders (store_id, status);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  variant_id uuid not null references public.variants (id) on delete restrict,
  qty integer not null check (qty > 0),
  unit_minor bigint not null check (unit_minor >= 0),
  campaign_id uuid, -- FK added in competition migration
  created_at timestamptz not null default now()
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_variant_idx on public.order_items (variant_id);
create index order_items_campaign_idx on public.order_items (campaign_id);

create table public.checkouts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete restrict,
  buyer_id uuid not null references public.profiles (id) on delete restrict,
  idempotency_key text not null,
  request_hash text not null,
  provider text not null,
  provider_session_id text unique,
  hosted_url text,
  status text not null default 'OPEN' check (status in ('OPEN', 'COMPLETED', 'EXPIRED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (buyer_id, idempotency_key)
);
create index checkouts_status_expiry_idx on public.checkouts (status, expires_at);

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id) on delete restrict,
  checkout_id uuid not null references public.checkouts (id) on delete restrict,
  qty integer not null check (qty > 0),
  expires_at timestamptz not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMMITTED', 'RELEASED')),
  created_at timestamptz not null default now()
);
create index stock_reservations_expiry_idx on public.stock_reservations (status, expires_at);
create index stock_reservations_variant_idx on public.stock_reservations (variant_id);
create index stock_reservations_checkout_idx on public.stock_reservations (checkout_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  provider text not null,
  external_id text not null unique,
  status text not null check (status in ('SUCCEEDED', 'FAILED')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now()
);
create index payments_order_idx on public.payments (order_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict,
  order_id uuid not null references public.orders (id) on delete restrict,
  external_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),
  reason text not null,
  requested_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index refunds_payment_idx on public.refunds (payment_id);
create index refunds_order_idx on public.refunds (order_id);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict,
  order_id uuid not null references public.orders (id) on delete restrict,
  external_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'OPEN' check (status in ('OPEN', 'WON', 'LOST')),
  created_at timestamptz not null default now()
);
create index disputes_payment_idx on public.disputes (payment_id);
create index disputes_order_idx on public.disputes (order_id);

-- ---------------------------------------------------------------------------
-- Ledger: balanced, immutable journal entries in integer minor units.
-- ---------------------------------------------------------------------------
create table public.journals (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  currency char(3) not null,
  type text not null,
  memo text not null default '',
  order_id uuid references public.orders (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index journals_order_idx on public.journals (order_id);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.journals (id) on delete restrict,
  account_code text not null check (account_code ~ '^[a-z_]+(:[a-z0-9_-]+)*$'),
  amount_minor bigint not null check (amount_minor <> 0),
  created_at timestamptz not null default now()
);
create index journal_lines_journal_idx on public.journal_lines (journal_id);
create index journal_lines_account_idx on public.journal_lines (account_code);

create or replace function app.assert_journal_balanced() returns trigger
language plpgsql as $$
declare
  jid uuid := coalesce(new.journal_id, old.journal_id);
  total bigint;
  line_count integer;
begin
  select coalesce(sum(amount_minor), 0), count(*) into total, line_count
  from public.journal_lines where journal_id = jid;
  if line_count < 2 or total <> 0 then
    raise exception 'journal % is unbalanced (sum=%, lines=%)', jid, total, line_count
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger journal_lines_balanced
  after insert on public.journal_lines
  deferrable initially deferred
  for each row execute function app.assert_journal_balanced();

create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

create trigger journals_immutable before update or delete on public.journals
  for each row execute function app.forbid_mutation();
create trigger journal_lines_immutable before update or delete on public.journal_lines
  for each row execute function app.forbid_mutation();
