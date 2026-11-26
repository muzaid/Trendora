# ADR 0003 — TrendScore, snapshots and finalization

**Status:** Accepted

- **Formula (frozen per campaign, hashed at publish):** 30% likes + 20% qualified shares + 20%
  creativity + 15% completion + 10% meaningful comments + 5% audience growth, each 0–100.
- **Rate metrics** use Bayesian smoothing `(events + prior × W)/(exposures + W)` with W = 100, scaled
  against a published reference rate and capped at 100. Exposures exclude paid traffic.
- **Creativity** = mean of two independent human rubric scores; if they differ by more than the
  threshold (20), a third reviewer adjudicates and the median of three is used. AI may flag, never score.
- **Validity** is decided per event at write time (self-engagement, burst rate, account age, risk, view
  caps, anonymous votes) and recorded with a reason; confirmed fraud flags exclude an actor's events at
  snapshot time.
- **Ties:** creativity, then qualified share score, then earlier approval, then entry id (total order).
- **Snapshots** are immutable `(campaign, version)` rows with cutoff, algorithm version, components and
  excluded-event counts. Provisional snapshots refresh ≤ 60 s while voting.
- **Finalization:** admin-only, `expectedSnapshotId` must be the latest snapshot with cutoff = `vote_end`,
  no open appeals/flags/eligibility reviews, complete rubric scores, minimum entries met. Campaign row is
  locked; rewards are unique per entry; idempotency key replay returns the stored response.
