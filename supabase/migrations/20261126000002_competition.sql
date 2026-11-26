-- TRENDORA P2/P3: campaigns, entitlements, video, entries, engagement, ranking.

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete restrict,
  title text not null check (char_length(title) between 3 and 120),
  tagline text not null default '',
  description text not null default '',
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'REVIEW', 'SCHEDULED', 'OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED',
    'REVIEWING', 'FINALIZED', 'FULFILLED', 'CANCELED')),
  starts_at timestamptz not null,
  submission_end timestamptz not null,
  vote_end timestamptz not null,
  appeal_deadline timestamptz not null,
  display_timezone text not null default 'UTC',
  currency char(3) not null,
  inventory_cap integer not null check (inventory_cap > 0),
  rules_version integer not null default 0,
  rules jsonb not null,
  rules_hash text,
  version integer not null default 1,
  funding_status text not null default 'NONE'
    check (funding_status in ('NONE', 'PENDING', 'VERIFIED', 'FAILED')),
  funding_evidence jsonb,
  frozen boolean not null default false,
  frozen_reason text,
  cancel_reason text,
  review_notes text,
  created_by uuid not null references public.profiles (id) on delete restrict,
  published_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < submission_end),
  check (submission_end <= vote_end),
  check (vote_end <= appeal_deadline)
);
create index campaigns_store_status_idx on public.campaigns (store_id, status);
create index campaigns_status_starts_idx on public.campaigns (status, starts_at);

alter table public.order_items
  add constraint order_items_campaign_fk foreign key (campaign_id)
  references public.campaigns (id) on delete restrict;

create table public.campaign_skus (
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  variant_id uuid not null references public.variants (id) on delete restrict,
  required_qty integer not null default 1 check (required_qty > 0),
  offer_minor bigint not null check (offer_minor >= 0),
  created_at timestamptz not null default now(),
  primary key (campaign_id, variant_id)
);
create index campaign_skus_variant_idx on public.campaign_skus (variant_id);

create table public.prize_tiers (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  rank_from integer not null check (rank_from >= 1),
  rank_to integer check (rank_to is null or rank_to >= rank_from), -- null = all remaining
  type text not null check (type in ('PRIZE', 'COUPON')),
  title text not null,
  value_minor bigint not null default 0 check (value_minor >= 0),
  percent_off integer check (percent_off between 1 and 100),
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((type = 'COUPON') = (percent_off is not null))
);
create index prize_tiers_campaign_idx on public.prize_tiers (campaign_id, rank_from);

-- Immutable published rule versions. Amendments add a new approved version.
create table public.campaign_rule_versions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  version integer not null,
  rules jsonb not null,
  rules_hash text not null,
  reason text not null,
  participant_remedy text,
  approved_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (campaign_id, version)
);
create trigger campaign_rule_versions_immutable before update or delete on public.campaign_rule_versions
  for each row execute function app.forbid_mutation();

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  order_item_id uuid references public.order_items (id) on delete restrict,
  source text not null check (source in ('PURCHASE', 'ALTERNATIVE')),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'LOCKED', 'UNDER_REVIEW', 'REVOKED')),
  status_reason text,
  created_at timestamptz not null default now(),
  check ((source = 'PURCHASE') = (order_item_id is not null))
);
create unique index entitlements_purchase_uniq on public.entitlements (campaign_id, order_item_id)
  where order_item_id is not null;
create unique index entitlements_alternative_uniq on public.entitlements (campaign_id, user_id)
  where source = 'ALTERNATIVE';
create index entitlements_user_idx on public.entitlements (user_id, created_at desc);

-- Lawful free alternative entry (no purchase necessary) adapter.
create table public.alternative_entry_requests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  statement text not null check (char_length(statement) between 10 and 2000),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (campaign_id, user_id)
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  provider text not null,
  upload_id text not null unique,
  provider_asset_id text unique,
  status text not null default 'AWAITING_UPLOAD'
    check (status in ('AWAITING_UPLOAD', 'PROCESSING', 'READY', 'FAILED', 'DELETED')),
  failure_reason text,
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  content_hash text,
  content_type text,
  size_bytes bigint,
  playback_id text,
  poster_url text,
  moderation_status text not null default 'PENDING'
    check (moderation_status in ('PENDING', 'APPROVED', 'REJECTED')),
  created_at timestamptz not null default now()
);
create index videos_owner_idx on public.videos (owner_id);
create index videos_hash_idx on public.videos (content_hash);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  entitlement_id uuid not null unique references public.entitlements (id) on delete restrict,
  video_id uuid not null unique references public.videos (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'PROCESSING', 'REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  caption text not null default '' check (char_length(caption) <= 300),
  commercial_reuse_consent boolean not null default false,
  submitted_at timestamptz,
  approved_at timestamptz,
  rejection_reason text,
  boost_exposure integer not null default 0, -- exploration slots granted (fair exposure)
  created_at timestamptz not null default now()
);
create index entries_campaign_status_idx on public.entries (campaign_id, status);
create index entries_user_idx on public.entries (user_id, created_at desc);

create table public.likes (
  entry_id uuid not null references public.entries (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);
create index likes_user_idx on public.likes (user_id);

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete restrict,
  sharer_id uuid not null references public.profiles (id) on delete restrict,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);
create index share_links_entry_idx on public.share_links (entry_id);
create index share_links_sharer_idx on public.share_links (sharer_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete restrict,
  author_id uuid not null references public.profiles (id) on delete restrict,
  body text not null check (char_length(body) between 1 and 500),
  status text not null default 'VISIBLE' check (status in ('VISIBLE', 'HIDDEN')),
  created_at timestamptz not null default now()
);
create index comments_entry_idx on public.comments (entry_id, created_at desc);
create index comments_author_idx on public.comments (author_id);

create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  creator_id uuid not null references public.profiles (id) on delete cascade,
  via_entry_id uuid references public.entries (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (follower_id, creator_id),
  check (follower_id <> creator_id)
);
create index follows_creator_idx on public.follows (creator_id);

-- Append-only engagement event log used for reproducible ranking snapshots.
create table public.engagement_events (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete restrict,
  visitor_hash text, -- pseudonymous id for unauthenticated share recipients
  type text not null check (type in (
    'IMPRESSION', 'VIEW_COMPLETE', 'LIKE', 'UNLIKE', 'SHARE_VISIT', 'COMMENT', 'FOLLOW')),
  dedupe_key text not null unique,
  occurred_at timestamptz not null,
  validity text not null default 'VALID' check (validity in ('VALID', 'INVALID')),
  invalid_reason text,
  share_link_id uuid references public.share_links (id) on delete restrict,
  exposure_source text not null default 'ORGANIC' check (exposure_source in ('ORGANIC', 'EXPLORATION', 'PAID')),
  device_hash text,
  network_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index engagement_entry_time_idx on public.engagement_events (entry_id, occurred_at);
create index engagement_actor_time_idx on public.engagement_events (actor_id, occurred_at);
create index engagement_share_link_idx on public.engagement_events (share_link_id);

create table public.rubric_scores (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete restrict,
  reviewer_id uuid not null references public.profiles (id) on delete restrict,
  originality integer not null check (originality between 0 and 100),
  product_integration integer not null check (product_integration between 0 and 100),
  execution integer not null check (execution between 0 and 100),
  is_adjudication boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique (entry_id, reviewer_id)
);
create index rubric_scores_reviewer_idx on public.rubric_scores (reviewer_id);

create table public.score_snapshots (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  version integer not null,
  cutoff timestamptz not null,
  algorithm_version text not null,
  status text not null default 'PROVISIONAL' check (status in ('PROVISIONAL', 'FINAL', 'SUPERSEDED')),
  event_count integer not null default 0,
  excluded_count integer not null default 0,
  created_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (campaign_id, version)
);
create unique index score_snapshots_one_final on public.score_snapshots (campaign_id) where status = 'FINAL';

create table public.entry_scores (
  snapshot_id uuid not null references public.score_snapshots (id) on delete restrict,
  entry_id uuid not null references public.entries (id) on delete restrict,
  components jsonb not null,
  excluded jsonb not null default '{}'::jsonb,
  score numeric(7, 3) not null check (score between 0 and 100),
  rank integer not null check (rank >= 1),
  created_at timestamptz not null default now(),
  primary key (snapshot_id, entry_id),
  unique (snapshot_id, rank)
);
create index entry_scores_entry_idx on public.entry_scores (entry_id);
