# Implementation checklist

Legend: ✅ done & tested · 🟡 partial / sandbox · ⬜ not started. Task IDs are for claiming work (AGENTS.md).

## P0 Foundation
- ✅ P0-1 pnpm monorepo (apps/web, apps/mobile, packages/{contracts,core,db,services,ui}, workers/jobs, tests, docs/adr)
- ✅ P0-2 CI workflow: lint, typecheck, unit, integration, RLS, build, E2E; mobile typecheck
- ✅ P0-3 Environment validation (Zod), sandbox guard in production
- ✅ P0-4 Supabase migrations (4 files) with constraints, triggers, immutable journals/audit, RLS, public views
- ✅ P0-5 RLS tests (cross-tenant, anon, direct write denial)
- ✅ P0-6 Auth: HS256 tokens (sandbox + Supabase JWT), cookie sessions, CSRF origin check, MFA (aal2) gate
- ✅ P0-7 Organization roles & permission matrix; platform roles
- ✅ P0-8 Design tokens (contrast-tested), RTL helpers
- ✅ P0-9 Seed fixture via real service flows

## P1 Commerce
- ✅ P1-1 Merchant onboarding + verification
- ✅ P1-2 Catalog, variants, inventory (optimistic version), price history, CSV import
- ✅ P1-3 Checkout: server repricing, single store/currency, campaign cap, stock reservation TTL, Idempotency-Key
- 🟡 P1-4 Hosted checkout adapter — sandbox provider only (real provider pending approval)
- ✅ P1-5 Signed webhooks: raw-body HMAC + timestamp, persist once, outbox, retries, dead-letter
- ✅ P1-6 Orders state machine, merchant fulfilment, refunds (partial/full), disputes
- ✅ P1-7 Balanced immutable ledger + reconciliation

## P2 Arena
- ✅ P2-1 Campaign wizard, drafts with optimistic concurrency, preview, launch checklist
- ✅ P2-2 Platform review → frozen, hashed rules version; amendments (deadline extensions) with remedy
- ✅ P2-3 Eligibility (country, conservative age, milestone, max entries), ineligible checkout blocked
- ✅ P2-4 Free alternative entry adapter (request + moderator approval)
- 🟡 P2-5 Upload/transcode/moderation — sandbox video provider (sniffing, ffprobe, metadata strip, hash); Mux/Stream pending
- ✅ P2-6 Public feed (cursor), store, product pages, sponsor disclosure

## P3 Engagement
- ✅ P3-1 Likes (one per user), qualified shares (signed links, distinct recipients), impressions, completions, comments, follows
- ✅ P3-2 Fraud rules: self-votes, burst rate, account age, risk, view caps, device clusters, duplicate media, same-network referrals
- ✅ P3-3 Versioned snapshots with components + excluded-event reasons; provisional refresh ≤60 s
- ✅ P3-4 Leaderboard (provisional/final, breakdown), two-reviewer rubric + adjudication
- ✅ P3-5 Appeals and reports workflows

## P4 Rewards
- ✅ P4-1 Prize funding evidence + finance verification (no custody)
- ✅ P4-2 Finalization (locked, idempotent, readiness blockers) → one reward per entry
- ✅ P4-3 Coupons (HMAC-derived code, hash stored, store-bound, expiry, min spend, cap, allowed/excluded SKUs, usage limit, atomic redemption)
- ✅ P4-4 Prize claims + fulfilment evidence; campaign → FULFILLED
- ✅ P4-5 Notifications (in-app); refund → eligibility review (never silent revoke)
- ✅ P4-6 Merchant reports (analytics, coupon liability), reconciliation
- ✅ P4-7 Direct coupon redemption: shoppers use reward coupons when buying from the business itself (store, own website, POS) — staff console + store API keys, server-computed discount, idempotent per receipt, shared usage limit with online checkout
- ⬜ P4-8 Email/push notification delivery

## P5 Growth
- 🟡 P5-1 Referral attribution — share attribution tracked; payouts deliberately not implemented (post-MVP)
- 🟡 P5-2 Feed fairness — exploration slots first; no personalization yet
- ✅ P5-3 Campaign analytics + sensitivity model
- 🟡 P5-4 Mobile app (feed, arena, rewards); upload/checkout still via web

## P6 AI
- ✅ P6-1 Bounded agent runtime (8 agent kinds), tenant-scoped inputs, untrusted text wrapped
- ✅ P6-2 Structured output validation (shared contract), run logs with trace id and cost, monthly budget cap
- ✅ P6-3 Human approval records; agents have no write tools
- 🟡 P6-4 Claude provider (structured outputs) wired; evaluations not yet built
- ⬜ P6-5 Video studio generation, analytics assistant chat
