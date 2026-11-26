# ADR 0002 — Deterministic money, ledger and idempotency

**Status:** Accepted

- All amounts are `bigint` minor units + ISO-4217 currency; percentage maths rounds half-up in
  integer arithmetic (`core/money.ts`).
- Checkout reprices server-side from catalog + campaign; client totals are ignored.
- Stock is reserved with a conditional `UPDATE … WHERE available >= qty` plus non-negative CHECKs, with
  a TTL (`stock_reservations.expires_at`) released by an outbox event and a sweeper.
- Every captured payment, refund and dispute writes a **balanced, append-only journal** (deferred
  constraint trigger + immutability trigger). `journals.external_event_id` is unique → replays are no-ops.
- Webhooks: verify raw-body HMAC + timestamp, persist `(provider, event_id)` once, enqueue via the
  transactional outbox, return 2xx only after the durable insert. Out-of-order events retry with backoff;
  after 8 attempts rows go `DEAD` for operator review.
- `Idempotency-Key` is mandatory for checkout and finalization.
- Payouts are never automated; AI has no write tools.
