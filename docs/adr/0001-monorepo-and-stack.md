# ADR 0001 — TypeScript monorepo on Supabase Postgres + Vercel

**Status:** Accepted · 2026-11

## Context
The spec mandates a TypeScript monorepo (web, mobile, contracts, ui, core, db, jobs) with Supabase +
Vercel as the initial baseline, and warns against premature microservices.

## Decision
- pnpm workspaces: `apps/web` (Next.js 16 App Router), `apps/mobile` (Expo, installed separately),
  `packages/{contracts,core,db,services,ui}`, `workers/jobs`, `tests`.
- Packages ship TypeScript source (`transpilePackages`), no build step for libraries.
- A **modular monolith**: services are plain modules over one Postgres; the web tier exposes them
  at `/v1/*`; workers reuse the same modules.
- Server talks to Postgres via `pg` (Supabase pooled connection string in production). RLS is
  defense-in-depth for direct client access, not the primary authorization path.

## Consequences
+ One deploy, shared types end to end, easy local dev with plain Postgres.
− Long-running jobs need a worker or a job platform (see ADR 0005).
