# Progress report — 2026-11-26

## Summary
The purchase-to-reward vertical slice works end to end on sandbox providers: a merchant builds and
publishes a campaign, a buyer checks out through a signed-webhook payment flow, the delivery milestone
unlocks an entry, the video is uploaded/validated/transcoded/moderated, other users vote and share,
two humans score creativity, voting closes on the server clock, an admin finalizes once, and the
winner's prize and the runners-up coupons are issued, claimed, fulfilled and redeemed.

## Verification (all green on this commit)
| Gate | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (all workspace packages) + mobile `tsc` | clean |
| Unit (`packages/core`, tokens, contracts) | 33 tests |
| Integration (services on Postgres 16) | 27 tests — idempotent checkout, concurrent last-unit purchase, cap, TTL expiry, forged/stale/duplicate/out-of-order webhooks, late payment auto-refund, ledger balance & immutability, partial refunds, milestone entitlements, free entry, malicious upload + re-upload, duplicate media, duplicate likes, self-votes, shares, bot bursts, deadline boundaries, refund eligibility review, simultaneous finalization, idempotent replay, coupon theft & concurrent redemption, cross-tenant access, privilege escalation, MFA gate, forged tokens, prompt-injection boundary, SSRF inputs |
| RLS | 5 tests — buyer/merchant isolation, ops tables hidden, anon views only, client writes denied |
| E2E (Playwright, real browser) | release-gate journey passes repeatedly (~25 s) |
| `next build` + `next start` smoke | passes; CSP and security headers present |

## Completed criteria
See [implementation-checklist.md](implementation-checklist.md): P0–P4 complete (sandbox providers),
P5 partial, P6 advisory agents with validation, logs, budget caps and approvals.

## Changed files (high level)
`supabase/migrations/*` (schema, RLS, views) · `packages/contracts` · `packages/core` · `packages/db` ·
`packages/services` (modules, adapters, jobs, seed) · `packages/ui` · `apps/web` (UI + `/v1` router) ·
`apps/mobile` · `workers/jobs` · `tests/*` · `docs/*` · CI (`.github/workflows/ci.yml`), `vercel.json`.

## Update 2026-11-27 — direct coupon redemption
Shoppers can redeem reward coupons when buying from the business itself. Added migration
`20261127000005_direct_coupon_redemption.sql` (rollback note inside), `services/modules/coupons.ts`,
merchant **Coupons** tab, store API keys, 2 unit + 6 integration tests (idempotent receipts, concurrency,
online-hold interplay, cross-store denial, key scoping/revocation, DB shape constraint). Suite: 73 tests + E2E green.

## Known defects / limitations
1. **Sandbox providers only.** Payments and video use labelled sandbox adapters; no real money or CDN.
2. **Sign-in UI is sandbox-only.** Supabase Auth access tokens are verified server-side and
   `/v1/auth/profile` bootstraps profiles, but the web app has no Supabase sign-up/sign-in screens yet.
3. **Leaderboard refresh** uses 30 s polling, not Supabase Realtime.
4. **Localization:** RTL direction helpers and locale preference exist; UI strings are English only.
5. **Notifications** are in-app only (no email/push delivery).
6. **Mobile** is typechecked but not device-tested; upload and checkout hand off to the web.
7. **Observability:** structured, redacted JSON logs with request ids; OpenTelemetry/error tracking not wired.
8. **AI:** Claude provider wired with structured outputs and cost tracking but not exercised against the
   live API here (no key); no agent evaluation suite yet.
9. **Amendments** support deadline extensions only; other material changes require cancel + new campaign.
10. The sandbox clock is platform-wide (by design, sandbox only).
12. Direct redemptions trust the business's declared purchase/eligible amounts (no POS receipt verification); they are audited and listed per store.
11. Performance SLOs (p95 < 500 ms, 99.9%) are untested; no load test yet.

## Next dependency
Blocking decisions from the spec's open list: **launch jurisdiction** and **payment provider**
(marketplace-capable, underwriting). These unblock the real payment adapter, tax treatment, age limits
and free-entry legal text. In parallel (non-blocking): Supabase Auth screens + MFA enrolment,
Mux/Cloudflare Stream adapter, Realtime leaderboard, email notifications, OpenTelemetry.

## Launch gates not yet met
No real-money launch until: approved payment provider · local counsel review of competition rules and
free-entry alternative · privacy notice & terms · moderation staffing · prize fulfilment guarantees with a
licensed escrow/guarantee provider · cross-tenant security tests against the deployed stack · backup
restore test · fraud appeal runbook sign-off ([runbooks.md](runbooks.md)) · load test against agreed traffic.
