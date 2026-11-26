# Dependency graph

## Packages

```mermaid
graph TD
  contracts[packages/contracts<br/>Zod schemas · DTOs · errors · rules · OpenAPI]
  core[packages/core<br/>money · state machines · TrendScore · rewards · coupons · ledger · pricing · fraud · signing]
  ui[packages/ui<br/>tokens · i18n/RTL]
  db[packages/db<br/>pg · tx · migrate]
  services[packages/services<br/>domain services · adapters · outbox jobs · seed]
  web[apps/web<br/>Next.js UI + /v1 API]
  jobs[workers/jobs]
  mobile[apps/mobile<br/>Expo]
  mig[(supabase/migrations)]
  tests[tests<br/>unit · integration · rls · e2e]

  core --> contracts
  services --> core
  services --> contracts
  services --> db
  db --> mig
  web --> services
  web --> ui
  web --> contracts
  jobs --> services
  mobile -. HTTP /v1 .-> web
  tests --> services
  tests --> ui
```

## Delivery order (each phase ends in a demonstrable slice)

```mermaid
graph LR
  P0[P0 Foundation<br/>monorepo · CI · env · migrations · RLS · auth · roles · tokens · seed]
  P1[P1 Commerce<br/>onboarding · catalog · inventory · checkout · signed webhooks · orders · refunds · ledger]
  P2[P2 Arena<br/>campaign wizard · rules snapshot · eligibility · free entry · upload/transcode/moderation · feed/store]
  P3[P3 Engagement<br/>likes/shares/views · fraud rules · snapshots · leaderboard · appeals]
  P4[P4 Rewards<br/>funding verification · finalization · rewards · coupons · fulfilment · reconciliation · reports]
  P5[P5 Growth<br/>referral attribution · personalized feed · analytics · mobile]
  P6[P6 AI<br/>bounded agents · run logs · approvals · cost caps]
  P0 --> P1 --> P2 --> P3 --> P4 --> P5
  P4 --> P6
```

## Runtime event flow

```
checkout ─► provider (hosted) ─► POST /v1/webhooks/:provider ─► webhook_events (unique) ─► outbox
outbox: webhook.process → order PAID → journal → order.status_changed → entitlement (at milestone)
upload PUT /v1/uploads/:token → video.uploaded → transcode/validate/hash → video.asset.ready → moderation queue
engagement events (validity at write) → tick: provisional snapshot ≤60 s → vote_end: cutoff snapshot
admin finalize (idempotent, locked) → rewards + coupons → campaign.finalized → merchant fulfilment → FULFILLED
refund/dispute webhook → order.refunded → eligibility review flag (never silent revocation)
```
