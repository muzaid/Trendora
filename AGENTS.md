# AGENTS.md — working agreement for humans and coding agents

TRENDORA is a competitive social-commerce platform: merchants sell through sponsored
video challenges; buyers create videos, compete on a transparent TrendScore, and win
prizes or rank-based coupons. **Money, eligibility, ranking and rewards are
deterministic services. AI assists but never authorizes money movement.**

## Repository map

| Path | Owner role | What lives here |
| --- | --- | --- |
| `packages/contracts` | Architect | Zod request schemas, response DTOs, typed errors, campaign rules schema, agent output contract, OpenAPI generator |
| `packages/core` | Trust / commerce engineers | Pure domain logic: money, state machines, TrendScore, tie-breaks, rewards planning, coupons, ledger, pricing, eligibility, fraud rules, signing |
| `packages/db` | Database engineer | `pg` pool, transaction helper (retries serialization failures), migration runner |
| `packages/services` | Backend engineer | Transactional services (identity, catalog, checkout, payments/webhooks, orders, campaigns, entries/video, engagement, ranking/finalization, rewards, trust & safety, analytics, agents), sandbox adapters, outbox jobs, seed |
| `packages/ui` | UX designer | Design tokens, i18n/RTL helpers, contrast checks |
| `apps/web` | Frontend engineer | Next.js storefront, consumer app, merchant console, admin; `/v1/*` REST API (single router `src/server/routes.ts`) |
| `apps/mobile` | Frontend engineer | Expo React Native consumer app (feed, arena, rewards) using the same API & tokens |
| `workers/jobs` | DevOps | Outbox drainer + maintenance tick + reconciliation worker |
| `supabase/migrations` | Database engineer (integration lead merges) | Schema, constraints, triggers, RLS, public views |
| `tests` | QA | `unit` (also `packages/**/*.test.ts`), `integration`, `rls`, `e2e` (Playwright) |
| `docs/adr` | Architect | Architecture decision records |

## Rules of engagement

1. **Contracts first.** Change `packages/contracts` (and an ADR if architectural) before parallel work.
   Only the integration lead merges migrations and shared contracts.
2. **Claim a task ID** from `docs/implementation-checklist.md`, work on a bounded branch/worktree,
   write tests, and report modified files + blockers in the PR description.
3. **Every action** connects to authorization (`identity.require*`), validation (Zod),
   persistence (transaction) and typed errors (`AppError`). No placeholder buttons, no fake success.
4. **Money**: integer minor units + ISO currency; balanced, append-only journals; never trust
   client amounts; never let an agent trigger a payout.
5. **Use DB constraints** for invariants (inventory non-negative, one entitlement per order line,
   one entry per entitlement, one reward per entry, coupon usage, unique webhook event ids).
6. **Time**: use `ctx.clock.now()` for business timestamps (sandbox clock offsets, deterministic tests).
7. **Secrets** only from the environment. Never commit `.env`. Never expose service-role keys to clients.
8. **Never run destructive commands against production.** `db:reset` refuses non-local hosts.

## Commands

```bash
pnpm install
cp .env.example .env            # then set secrets (openssl rand -hex 32)
pnpm db:seed --reset            # local Postgres: migrate + seed (one merchant, 3 products, Glow Up, 10 entries)
pnpm dev                        # http://localhost:3000 (sandbox: in-process jobs)
pnpm jobs                       # standalone worker (production-style)
pnpm lint && pnpm typecheck
pnpm test:unit | test:integration | test:rls   # needs local Postgres (TEST_DATABASE_ADMIN_URL)
pnpm test:e2e                   # Playwright; seeds and starts the server if needed
pnpm openapi                    # regenerate docs/openapi.json
```

## Definition of done

Typed contract · migration + rollback note · unit/integration/RLS/E2E tests as relevant ·
accessibility (44px targets, labels, contrast, reduced motion, no autoplay audio) · structured
logs · docs · feature flag / sandbox label where a provider is not yet approved · reviewed
security implications.
