# ADR 0005 — Transactional outbox and job runner

**Status:** Accepted

State changes enqueue follow-up work in `outbox` inside the same transaction. `drainOutbox` claims rows
with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff and dead-letters after 8 attempts.
Handlers: `webhook.process`, `checkout.expire`, `order.status_changed` (entitlements),
`order.refunded` (eligibility review), `video.uploaded` (transcode), `campaign.voting_closed` (cutoff
snapshot), plus agent hooks. `tick()` advances campaign phases from server time, expires checkouts and
refreshes provisional leaderboards.

Runtimes: in sandbox the web process drains in-process; production runs `workers/jobs` (N replicas safe)
or calls `POST /v1/jobs/tick` from a scheduler with `CRON_SECRET`. Trigger.dev/Inngest can wrap the
same exported handlers later.
