-- TRENDORA P4/P6: rewards, coupons, trust & safety, audit, outbox, webhooks, AI runs.

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  entry_id uuid not null unique references public.entries (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  tier_id uuid not null references public.prize_tiers (id) on delete restrict,
  snapshot_id uuid not null references public.score_snapshots (id) on delete restrict,
  rank integer not null check (rank >= 1),
  type text not null check (type in ('PRIZE', 'COUPON')),
  status text not null default 'ISSUED' check (status in (
    'ISSUED', 'CLAIMED', 'FULFILLING', 'FULFILLED', 'UNDER_REVIEW', 'FORFEITED')),
  value_minor bigint not null default 0 check (value_minor >= 0),
  claim jsonb,
  fulfillment_evidence jsonb,
  delivery_deadline timestamptz,
  claimed_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now()
);
create index rewards_campaign_idx on public.rewards (campaign_id, rank);
create index rewards_user_idx on public.rewards (user_id, created_at desc);
create index rewards_tier_idx on public.rewards (tier_id);
create index rewards_snapshot_idx on public.rewards (snapshot_id);

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null unique references public.rewards (id) on delete restrict,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  store_id uuid not null references public.stores (id) on delete restrict,
  code_hash text not null unique,
  code_last4 text not null,
  percent_off integer not null check (percent_off between 1 and 100),
  max_discount_minor bigint not null check (max_discount_minor > 0),
  min_spend_minor bigint not null default 0 check (min_spend_minor >= 0),
  currency char(3) not null,
  allowed_variant_ids uuid[], -- null = all store SKUs
  excluded_variant_ids uuid[] not null default '{}',
  usage_limit integer not null default 1 check (usage_limit >= 1),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz not null,
  terms jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'EXHAUSTED', 'VOID')),
  created_at timestamptz not null default now(),
  check (used_count <= usage_limit)
);
create index coupons_owner_idx on public.coupons (owner_id);
create index coupons_store_idx on public.coupons (store_id);

create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons (id) on delete restrict,
  order_id uuid not null unique references public.orders (id) on delete restrict,
  discount_minor bigint not null check (discount_minor > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'REDEEMED', 'RELEASED')),
  created_at timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id);

-- ---------------------------------------------------------------------------
-- Trust & safety
-- ---------------------------------------------------------------------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete restrict,
  target_type text not null check (target_type in ('ENTRY', 'COMMENT', 'PROFILE', 'PRODUCT', 'STORE')),
  target_id uuid not null,
  reason text not null check (reason in (
    'SPAM', 'HARASSMENT', 'UNSAFE_CHALLENGE', 'COPYRIGHT', 'MISLEADING', 'UNDERAGE', 'OTHER')),
  details text not null default '' check (char_length(details) <= 2000),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACTIONED', 'DISMISSED')),
  resolution text,
  resolved_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index reports_status_idx on public.reports (status, created_at);
create index reports_reporter_idx on public.reports (reporter_id);

create table public.appeals (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  reason text not null check (char_length(reason) between 10 and 2000),
  status text not null default 'OPEN' check (status in ('OPEN', 'UPHELD', 'DENIED')),
  resolution text,
  resolved_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index appeals_entry_idx on public.appeals (entry_id);
create index appeals_user_idx on public.appeals (user_id);
create unique index appeals_one_open_per_entry on public.appeals (entry_id) where status = 'OPEN';

create table public.blocks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  blocked_user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_user_id),
  check (user_id <> blocked_user_id)
);

create table public.fraud_flags (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  entry_id uuid references public.entries (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete restrict,
  kind text not null,
  source text not null check (source in ('RULE', 'AGENT')),
  evidence jsonb not null default '{}'::jsonb,
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  status text not null default 'OPEN' check (status in ('OPEN', 'CONFIRMED', 'DISMISSED')),
  dedupe_key text unique,
  resolved_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index fraud_flags_campaign_idx on public.fraud_flags (campaign_id, status);
create index fraud_flags_entry_idx on public.fraud_flags (entry_id);
create index fraud_flags_actor_idx on public.fraud_flags (actor_id);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete restrict,
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index audit_log_target_idx on public.audit_log (target_type, target_id, at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, at desc);
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function app.forbid_mutation();

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null,
  dedupe_key text unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'DONE', 'DEAD')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on public.outbox (status, available_at);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload_hash text not null,
  payload jsonb not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table public.idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);

create table public.rate_limit_buckets (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (bucket, window_start)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles (id) on delete restrict,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent in (
    'TREND', 'CAMPAIGN', 'COMMERCE', 'VIDEO_STUDIO', 'TRUST', 'REWARDS', 'MARKETING', 'ANALYTICS')),
  org_id uuid references public.organizations (id) on delete restrict,
  requested_by uuid references public.profiles (id) on delete restrict,
  provider text not null,
  input_ref jsonb not null,
  status text not null default 'RUNNING' check (status in (
    'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED_OUTPUT', 'APPROVED', 'DISMISSED')),
  output jsonb,
  error text,
  cost_usd_micros bigint not null default 0,
  trace_id text not null,
  approved_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index agent_runs_org_idx on public.agent_runs (org_id, created_at desc);
