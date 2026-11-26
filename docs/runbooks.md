# Runbooks

## Incident response — freeze first, then investigate
1. **Campaign-level:** Admin → Campaigns → *Freeze (kill switch)*. Blocks purchases at the offer price,
   votes, submissions and finalization for that campaign. Reason is audited.
2. **Platform-level:** Admin → Platform → *Freeze all checkout* and/or *Freeze rewards*
   (`/v1/admin/kill-switch`). Checkout returns 403; finalization and prize fulfilment are refused.
3. Preserve evidence: do not delete rows; export `audit_log`, `engagement_events`, `webhook_events`
   for the time window. Journals and audit log are append-only by trigger.
4. Notify owners (merchant OWNER memberships) and affected participants (notifications table).
5. Restore from the latest tested backup only with platform approval; replay outbox/webhooks afterwards.

## Fraud review & appeals
1. Admin → *Reports, appeals & flags*. Each flag shows source (RULE/AGENT), confidence and evidence.
2. **Confirm** only with human-reviewed evidence. Confirmed actor flags exclude that actor's events from
   the next snapshot (`FRAUD_CONFIRMED`). Duplicate-media confirmation rejects the entry.
3. `REFUND_ELIGIBILITY_REVIEW`: *Dismiss* reinstates the entitlement and reward; *Confirm* revokes the
   entitlement and forfeits an unfulfilled reward (with reason, audited, participant notified).
4. Appeals must be resolved before finalization (readiness blocker). Upholding an appeal re-approves the entry.
5. Recompute the snapshot after decisions (Admin → Campaigns → *Recompute snapshot*), then finalize.

## Webhook replay & dead letters
- Deliveries are idempotent by `(provider, event_id)`; journals by `external_event_id`.
- Inspect: `select * from outbox where status = 'DEAD'` and `webhook_events where status <> 'PROCESSED'`.
- Replay: fix the cause, then `update outbox set status='PENDING', attempts=0, available_at=now() where id = …`.
- Amount mismatches never auto-heal: reconcile manually with the provider dashboard.

## Daily reconciliation
- Worker runs `dailyReconciliation`; Admin → Finance shows captured/refunded/disputed vs ledger clearing.
- `ok=false` or `unbalancedJournals>0` is a SEV-2: freeze payouts and investigate.

## Data deletion requests
1. Verify identity; check for open orders/disputes/legal holds.
2. Anonymize the profile (display name, handle, birth year, country) and set `status='DELETED'`;
   delete videos through the video provider (`VideoProvider.delete`) and mark `videos.status='DELETED'`.
3. Financial records (orders, payments, journals) are retained per tax law; they reference the
   anonymized profile only.

## Secret rotation
- `AUTH_JWT_SECRET` (invalidates sessions), `SIGNING_SECRET` (invalidates upload/playback/share tokens),
  `SANDBOX_WEBHOOK_SECRET`/provider secrets (coordinate with provider), `CRON_SECRET`.
- **`COUPON_SECRET` derives displayed coupon codes** — rotating it changes codes shown to users while the
  stored hashes keep validating the old codes. Rotate only with a migration that re-issues codes.
