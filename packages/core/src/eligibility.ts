import type { CampaignRules, OrderStatus } from '@trendora/contracts';

const MILESTONE_ORDER: OrderStatus[] = ['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'];

/** True when an order has reached the campaign's configured entitlement milestone. */
export function reachedMilestone(status: OrderStatus, milestone: CampaignRules['eligibility']['entitlementMilestone']): boolean {
  const idx = MILESTONE_ORDER.indexOf(status);
  return idx >= 0 && idx >= MILESTONE_ORDER.indexOf(milestone);
}

export interface Participant { country: string | null; birthYear: number | null; status: string; createdAt: Date }

export type IneligibleReason = 'COUNTRY' | 'AGE_UNKNOWN' | 'UNDER_AGE' | 'ACCOUNT_STATUS';

/**
 * Conservative age check using birth year only (data minimisation): a user is
 * treated as old enough only if they are minAge on Jan 1 of the current year.
 */
export function participantIneligibility(p: Participant, rules: CampaignRules, now: Date): IneligibleReason | null {
  if (p.status !== 'ACTIVE') return 'ACCOUNT_STATUS';
  if (!p.country || !rules.eligibility.countries.includes(p.country)) return 'COUNTRY';
  if (p.birthYear === null) return 'AGE_UNKNOWN';
  if (now.getUTCFullYear() - p.birthYear - 1 < rules.eligibility.minAge) return 'UNDER_AGE';
  return null;
}

export const INELIGIBLE_MESSAGES: Record<IneligibleReason, string> = {
  COUNTRY: 'This challenge is not open to residents of your country',
  AGE_UNKNOWN: 'Add your birth year in your profile to confirm age eligibility',
  UNDER_AGE: 'You do not meet the minimum age for this challenge',
  ACCOUNT_STATUS: 'Your account is not in good standing',
};
