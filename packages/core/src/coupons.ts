import { createHash, createHmac } from 'node:crypto';
import { ineligible } from '@trendora/contracts';
import { percentOfMinor } from './money';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Deterministic, unguessable code derived from a server secret + reward id. Only the hash is stored. */
export function couponCodeFor(secret: string, rewardId: string): string {
  const mac = createHmac('sha256', secret).update(`coupon:${rewardId}`).digest();
  let code = '';
  for (let i = 0; i < 12; i++) code += ALPHABET[mac[i]! % ALPHABET.length];
  return `TR-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export function hashCouponCode(code: string): string {
  return createHash('sha256').update(normalizeCouponCode(code)).digest('hex');
}

export interface CouponTerms {
  storeId: string;
  percentOff: number;
  maxDiscountMinor: number;
  minSpendMinor: number;
  currency: string;
  allowedVariantIds: string[] | null;
  excludedVariantIds: string[];
  usageLimit: number;
  usedCount: number;
  pendingCount: number;
  expiresAt: Date;
  status: 'ACTIVE' | 'EXHAUSTED' | 'VOID';
  ownerId: string;
}

export interface CartLine { variantId: string; qty: number; unitMinor: number }

/**
 * Evaluate a coupon against a server-priced cart. Throws INELIGIBLE with a clear
 * reason; otherwise returns the discount in minor units.
 */
export function evaluateCoupon(c: CouponTerms, ctx: { storeId: string; buyerId: string; currency: string; lines: CartLine[]; now: Date }): number {
  if (c.status !== 'ACTIVE') throw ineligible('This coupon is no longer active');
  if (c.ownerId !== ctx.buyerId) throw ineligible('This coupon belongs to another account');
  if (c.storeId !== ctx.storeId) throw ineligible('This coupon is only valid at the issuing store');
  if (c.currency !== ctx.currency) throw ineligible('Coupon currency does not match the order');
  if (ctx.now >= c.expiresAt) throw ineligible('This coupon has expired');
  if (c.usedCount + c.pendingCount >= c.usageLimit) throw ineligible('This coupon has reached its usage limit');
  const eligibleLines = ctx.lines.filter(
    (l) => (c.allowedVariantIds === null || c.allowedVariantIds.includes(l.variantId)) && !c.excludedVariantIds.includes(l.variantId),
  );
  const eligibleSubtotal = eligibleLines.reduce((s, l) => s + l.unitMinor * l.qty, 0);
  if (eligibleSubtotal === 0) throw ineligible('No items in this order are eligible for the coupon');
  const subtotal = ctx.lines.reduce((s, l) => s + l.unitMinor * l.qty, 0);
  if (subtotal < c.minSpendMinor) throw ineligible('Order does not meet the coupon minimum spend');
  const discount = Math.min(percentOfMinor(eligibleSubtotal, c.percentOff), c.maxDiscountMinor, eligibleSubtotal);
  if (discount <= 0) throw ineligible('Coupon discount rounds to zero for this order');
  return discount;
}
