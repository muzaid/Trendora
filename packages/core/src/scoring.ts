import type { ScoringConfig } from '@trendora/contracts';

/**
 * TrendScore v1 (spec §7). Pure and deterministic: identical inputs always give
 * identical outputs, so snapshots are reproducible from the frozen event set.
 *
 * TrendScore = Σ weight_i × normalized_i / 100, every component on 0–100.
 */

export interface RubricScore {
  reviewerId: string;
  originality: number;
  productIntegration: number;
  execution: number;
  isAdjudication: boolean;
}

export interface EntryMetrics {
  entryId: string;
  approvedAt: Date;
  /** Valid, non-paid exposures (impressions). Denominator for rate metrics. */
  exposures: number;
  likes: number;
  qualifiedShares: number;
  completions: number;
  meaningfulComments: number;
  follows: number;
  rubric: RubricScore[];
}

export type ComponentKey = 'likes' | 'shares' | 'creativity' | 'completion' | 'comments' | 'growth';
export type Components = Record<ComponentKey, number>;

export interface CreativityResult {
  score: number;
  status: 'COMPLETE' | 'NEEDS_SCORES' | 'NEEDS_ADJUDICATION';
  reviewerTotals: number[];
}

export interface ScoredEntry {
  entryId: string;
  score: number;
  components: Components;
  creativityStatus: CreativityResult['status'];
  approvedAt: Date;
  rank: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp100 = (n: number) => Math.max(0, Math.min(100, n));

/** (events + priorRate × W) / (exposures + W) — Bayesian smoothing with prior weight W. */
export function smoothedRate(events: number, exposures: number, priorRate: number, priorWeight: number): number {
  if (events < 0 || exposures < 0) throw new RangeError('events/exposures must be non-negative');
  return (events + priorRate * priorWeight) / (exposures + priorWeight);
}

/** Scale a smoothed rate against the published fixed reference rate, capped at 100. */
export function normalizeRate(events: number, exposures: number, priorRate: number, referenceRate: number, priorWeight: number): number {
  // A qualifying event implies an exposure; never let the rate exceed 1.
  const exp = Math.max(exposures, events);
  return round3(clamp100((smoothedRate(events, exp, priorRate, priorWeight) / referenceRate) * 100));
}

export function rubricTotal(r: RubricScore): number {
  return (r.originality + r.productIntegration + r.execution) / 3;
}

/**
 * Two independent human rubric scores, averaged. If they differ by more than
 * the threshold, an adjudication score is required and the result is the median
 * of the three. AI never contributes to this score.
 */
export function creativityScore(rubric: RubricScore[], threshold: number): CreativityResult {
  const independent = rubric.filter((r) => !r.isAdjudication).slice(0, 2);
  const totals = independent.map(rubricTotal);
  if (totals.length < 2) return { score: totals[0] !== undefined ? round3(totals[0]) : 0, status: 'NEEDS_SCORES', reviewerTotals: totals };
  const [a, b] = totals as [number, number];
  if (Math.abs(a - b) <= threshold) return { score: round3((a + b) / 2), status: 'COMPLETE', reviewerTotals: totals };
  const adj = rubric.find((r) => r.isAdjudication);
  if (!adj) return { score: round3((a + b) / 2), status: 'NEEDS_ADJUDICATION', reviewerTotals: totals };
  const sorted = [a, b, rubricTotal(adj)].sort((x, y) => x - y);
  return { score: round3(sorted[1]!), status: 'COMPLETE', reviewerTotals: [...totals, rubricTotal(adj)] };
}

export function computeComponents(m: EntryMetrics, cfg: ScoringConfig): { components: Components; creativity: CreativityResult } {
  const W = cfg.priorWeight;
  const creativity = creativityScore(m.rubric, cfg.adjudicationThreshold);
  return {
    creativity,
    components: {
      likes: normalizeRate(m.likes, m.exposures, cfg.priorRates.likes, cfg.referenceRates.likes, W),
      shares: normalizeRate(m.qualifiedShares, m.exposures, cfg.priorRates.shares, cfg.referenceRates.shares, W),
      creativity: creativity.score,
      completion: normalizeRate(m.completions, m.exposures, cfg.priorRates.completion, cfg.referenceRates.completion, W),
      comments: normalizeRate(m.meaningfulComments, m.exposures, cfg.priorRates.comments, cfg.referenceRates.comments, W),
      growth: normalizeRate(m.follows, m.exposures, cfg.priorRates.growth, cfg.referenceRates.growth, W),
    },
  };
}

export function trendScore(c: Components, cfg: ScoringConfig): number {
  const w = cfg.weights;
  return round3(
    (w.likes * c.likes + w.shares * c.shares + w.creativity * c.creativity + w.completion * c.completion +
      w.comments * c.comments + w.growth * c.growth) / 100,
  );
}

/**
 * Rank entries. Tie resolution (published): higher creativity, then qualified
 * share score, then earlier approved submission; entry id as a final total order.
 */
export function rankEntries(metrics: EntryMetrics[], cfg: ScoringConfig): ScoredEntry[] {
  const scored = metrics.map((m) => {
    const { components, creativity } = computeComponents(m, cfg);
    return { entryId: m.entryId, score: trendScore(components, cfg), components, creativityStatus: creativity.status, approvedAt: m.approvedAt, rank: 0 };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.components.creativity - a.components.creativity ||
      b.components.shares - a.components.shares ||
      a.approvedAt.getTime() - b.approvedAt.getTime() ||
      (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
  );
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}

/** Words heuristic for "meaningful" comments (spec §7). */
export function isMeaningfulComment(body: string, minWords: number): boolean {
  const words = body.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
  if (words.length < minWords) return false;
  const unique = new Set(words.map((w) => w.toLowerCase()));
  return unique.size >= Math.ceil(minWords / 2);
}
