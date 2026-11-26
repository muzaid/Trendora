import { invalid } from '@trendora/contracts';

export interface TierDef {
  id: string;
  rankFrom: number;
  rankTo: number | null; // null = all remaining eligible entries
  type: 'PRIZE' | 'COUPON';
  title: string;
  valueMinor: number;
  percentOff: number | null;
}

/** Validate that tiers are contiguous from rank 1, non-overlapping, and at most one open-ended tier (last). */
export function validateTiers(tiers: Omit<TierDef, 'id'>[]): void {
  if (tiers.length === 0) throw invalid('At least one prize tier is required');
  const sorted = [...tiers].sort((a, b) => a.rankFrom - b.rankFrom);
  let expected = 1;
  sorted.forEach((t, i) => {
    if (t.rankFrom !== expected) throw invalid(`Prize tiers must be contiguous: expected rank ${expected}, got ${t.rankFrom}`);
    if (t.rankTo === null && i !== sorted.length - 1) throw invalid('Only the last tier may cover "all remaining" ranks');
    if (t.rankTo !== null && t.rankTo < t.rankFrom) throw invalid('rankTo must be >= rankFrom');
    if ((t.type === 'COUPON') !== (t.percentOff !== null)) throw invalid('Coupon tiers need percentOff; prize tiers must not');
    if (t.type === 'PRIZE' && t.valueMinor <= 0) throw invalid('Prize tiers must declare a positive value');
    expected = (t.rankTo ?? Number.MAX_SAFE_INTEGER) + 1;
  });
}

export function tierForRank<T extends TierDef>(tiers: T[], rank: number): T | null {
  return tiers.find((t) => rank >= t.rankFrom && (t.rankTo === null || rank <= t.rankTo)) ?? null;
}

export interface PlannedReward<T extends TierDef = TierDef> {
  entryId: string;
  userId: string;
  rank: number;
  tier: T;
}

/** One reward per final eligible entry (spec §7 finalization contract). Entries outside every tier get nothing. */
export function planRewards<T extends TierDef>(ranked: { entryId: string; userId: string; rank: number }[], tiers: T[]): PlannedReward<T>[] {
  const out: PlannedReward<T>[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    if (seen.has(r.entryId)) throw invalid(`Duplicate entry ${r.entryId} in ranking`);
    seen.add(r.entryId);
    const tier = tierForRank(tiers, r.rank);
    if (tier) out.push({ entryId: r.entryId, userId: r.userId, rank: r.rank, tier });
  }
  return out;
}

/** Total prize value that must be funded or guaranteed before launch. */
export function requiredPrizeFunding(tiers: Omit<TierDef, 'id'>[]): number {
  return tiers
    .filter((t) => t.type === 'PRIZE')
    .reduce((sum, t) => sum + t.valueMinor * ((t.rankTo ?? t.rankFrom) - t.rankFrom + 1), 0);
}
