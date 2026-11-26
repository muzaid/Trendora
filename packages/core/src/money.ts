import { invalid } from '@trendora/contracts';

/** Money is always integer minor units + ISO currency. */
export function assertMinor(n: number, label = 'amount'): number {
  if (!Number.isSafeInteger(n) || n < 0) throw invalid(`${label} must be a non-negative integer of minor units`);
  return n;
}

/**
 * Percentage of an amount in minor units, rounded half-up to the nearest minor
 * unit. Uses integer arithmetic only (no floating point drift).
 */
export function percentOfMinor(amountMinor: number, percent: number): number {
  assertMinor(amountMinor);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw invalid('percent must be an integer 0-100');
  return Math.floor((amountMinor * percent + 50) / 100);
}

/** Basis points (1/100 of a percent) of an amount, rounded half-up. */
export function bpsOfMinor(amountMinor: number, bps: number): number {
  assertMinor(amountMinor);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw invalid('bps must be an integer 0-10000');
  return Math.floor((amountMinor * bps + 5_000) / 10_000);
}

/**
 * Split a total across weights so that the parts sum exactly to the total
 * (largest-remainder method). Deterministic for equal remainders (lower index first).
 */
export function allocateMinor(totalMinor: number, weights: number[]): number[] {
  assertMinor(totalMinor);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw invalid('weights must sum to a positive number');
  const raw = weights.map((w) => (totalMinor * w) / sum);
  const parts = raw.map(Math.floor);
  let remainder = totalMinor - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    parts[i]! += 1;
    remainder -= 1;
  }
  return parts;
}

export function sumMinor(values: number[]): number {
  return values.reduce((a, b) => a + assertMinor(b), 0);
}
