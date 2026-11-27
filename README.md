# TRENDORA — Shop. Create. Compete. Win.

Competitive social commerce: merchants sell products through sponsored video challenges; buyers
create product videos, compete on a transparent, skill-judged **TrendScore**, and win prizes or
rank-based store coupons.

> **Status:** full purchase-to-reward vertical slice (spec phases P0–P4, P6 advisory AI, parts of P5)
> running on **sandbox** payment and video adapters. **Not production-ready** — see
> [launch gates](docs/progress-report.md#launch-gates-not-yet-met).

## What's in the box

| Surface | Highlights |
| --- | --- |
| **Consumer web** (`apps/web`) | Vertical video feed (muted, never autoplays audio, sponsor disclosure, product tags, like/share/report/comment/follow), stores & products, server-repriced checkout with hosted (sandbox) payment, challenge **arena** (rules, prizes, eligibility, upload → transcode → submit, live leaderboard with score breakdown, appeals, free alternative entry), profile with orders, entries, rewards, coupon codes, prize claims, notifications, privacy |
| **Merchant console** | **In-store / own-website coupon redemption** (staff screen + store API keys for the business's website or till), onboarding, catalog (variants, inventory with optimistic locking, price history, CSV import), campaign builder + preview + launch checklist + prize-funding evidence, orders (ship/deliver/refund), rewards fulfilment & coupon liability, analytics (funnel, attributed revenue, repeat purchase, fraud rate, video-rights consents, contribution margin & sensitivity), staff roles, advisory AI assistants |
| **Platform admin** | Merchant verification, campaign review/publish (rules frozen + hashed), moderation queue, two-reviewer creativity rubric with adjudication, reports/appeals/fraud flags, free-entry approvals, results review & **idempotent finalization**, kill switches, ledger reconciliation, audit log, sandbox clock |
| **Mobile** (`apps/mobile`) | Expo app: feed, likes, arena leaderboard, rewards/coupons |
| **API** | Versioned REST under `/v1/*` — Zod-validated, bearer or cookie auth, typed errors `{error:{code,message,requestId}}`, OpenAPI at `/v1/openapi.json` (`docs/openapi.json`) |
| **Backend** | Postgres schema with constraints/triggers/RLS, transactional services, signed webhooks, transactional outbox + worker, balanced immutable ledger |

## Quick start (local)

Requirements: Node 22+, pnpm 10, PostgreSQL 16 (or `supabase start`), ffmpeg (for video checks).

```bash
pnpm install
cp .env.example .env               # set the three secrets: openssl rand -hex 32
pnpm db:seed --reset               # migrate + seed via the real service flows (~10 s)
pnpm dev                           # http://localhost:3000
```

Sign in at `/login` with a seeded **sandbox** account:

| Handle | Try this |
| --- | --- |
| `buyer_bea` | Buy Glow Serum at the $49 challenge price → sandbox pay → wait for delivery → upload a video in the arena |
| `glow_owner` / `glow_staff` | Merchant console: ship/deliver orders, build a campaign, see analytics, fulfil prizes |
| `viewer_01` … `viewer_06`, `creator_01` … `creator_10` | Vote, share, comment; creators 1–6 hold prizes/coupons from the finalized *Summer Shine* campaign |
| `mod_ava`, `mod_ben` | Moderation queue, rubric scoring, appeals, fraud flags |
| `finance_fin` | Prize-funding verification, ledger reconciliation |
| `admin_alex` | Publish campaigns, finalize results, kill switches, sandbox clock (+days) |

Seed data: one merchant (GlowLab), three products, the live **Glow Up Challenge** ($99 → $49; #1 getaway,
#2 PS5, #3 headphones; #4–10 50% coupons, #11–100 35%, everyone else 20%), ten approved entries with
real transcoded video, engagement and rubric scores, plus a finalized past campaign with issued rewards.

## Commands

```bash
pnpm lint                 # ESLint (typescript-eslint, strict)
pnpm typecheck            # every workspace package
pnpm test:unit            # pure domain logic, tokens, contracts
pnpm test:integration     # services on real Postgres (each file clones a migrated template DB)
pnpm test:rls             # row-level security as PostgREST would apply it
pnpm test:e2e             # Playwright release gate (seeds + starts the app if not running)
pnpm build && pnpm start  # production build (sandbox needs ALLOW_SANDBOX_IN_PRODUCTION=true)
pnpm jobs                 # standalone outbox/tick worker for production-style runs
pnpm openapi              # regenerate docs/openapi.json
```

Integration/RLS tests use `TEST_DATABASE_ADMIN_URL` (default `postgresql://postgres:postgres@localhost:5432/postgres`).

## Architecture

```
apps/web (Next.js 16)  ──/v1 REST──►  packages/services ──► packages/db (pg) ──► Supabase Postgres (RLS, views)
apps/mobile (Expo) ───────┘                │   ▲
                                           ▼   │ outbox
                                  packages/core (pure, deterministic)      workers/jobs (drain + tick + reconcile)
                                  packages/contracts (Zod, DTOs, errors)   adapters: payments · video · AI (sandbox now)
```

Read **[AGENTS.md](AGENTS.md)** first, then the [ADRs](docs/adr), the
[dependency graph](docs/dependency-graph.md), [implementation checklist](docs/implementation-checklist.md),
[runbooks](docs/runbooks.md) and the [progress report](docs/progress-report.md).

## Coupons at the business itself

Reward coupons work on TRENDORA checkout **and** when the shopper buys directly from the business:

- **In store:** Merchant console → **Coupons** → enter code, purchase total and receipt number → *Check code* → *Redeem coupon*.
  Staff roles OWNER, MANAGER and FULFILLMENT can redeem.
- **Own website / POS:** the store owner creates an API key (Coupons tab), then the business's system calls

  ```bash
  curl -X POST $APP_URL/v1/stores/$STORE_ID/coupons/redeem \
    -H "Authorization: Bearer trk_live_…" -H "Content-Type: application/json" \
    -d '{"code":"TR-XXXX-XXXX-XXXX","purchaseMinor":5000,"reference":"ORDER-1001"}'
  ```
  `/coupons/lookup` previews validity and the discount first. Retrying with the same `reference` returns the
  original result; a used, expired or other-store code is refused. TRENDORA never handles the money for these
  sales — it computes the discount and records the redemption.

## Deploying (Supabase + Vercel)

1. Create separate Supabase projects for dev/staging/prod; apply `supabase/migrations` via
   `supabase db push` in CI (never apply `supabase/local/auth_stub.sql` there).
2. Vercel project rooted at the repo (`vercel.json`). Set env vars from `.env.example` in each
   environment; `SANDBOX_MODE=false`, `REQUIRE_MFA_FOR_PRIVILEGED=true`, `SUPABASE_JWT_SECRET`,
   `CRON_SECRET`, and the pooled `DATABASE_URL`.
3. Run `workers/jobs` on a long-running host (or rely on the `/v1/jobs/tick` cron).
4. Replace sandbox adapters with approved providers (see ADR 0004) before any real-money launch.
