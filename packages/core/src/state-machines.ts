import { conflict, type CampaignStatus, type EntryStatus, type OrderStatus } from '@trendora/contracts';

function machine<S extends string>(name: string, edges: Record<S, readonly S[]>) {
  return {
    edges,
    can(from: S, to: S): boolean {
      return (edges[from] ?? []).includes(to);
    },
    assert(from: S, to: S): void {
      if (!(edges[from] ?? []).includes(to)) throw conflict(`Invalid ${name} transition ${from} → ${to}`, { from, to });
    },
  };
}

/** Spec §6: DRAFT → REVIEW → SCHEDULED → OPEN → SUBMISSION_CLOSED → VOTING_CLOSED → REVIEWING → FINALIZED → FULFILLED; CANCELED explicit. */
export const campaignMachine = machine<CampaignStatus>('campaign', {
  DRAFT: ['REVIEW', 'CANCELED'],
  REVIEW: ['DRAFT', 'SCHEDULED', 'CANCELED'],
  SCHEDULED: ['OPEN', 'CANCELED'],
  OPEN: ['SUBMISSION_CLOSED', 'CANCELED'],
  SUBMISSION_CLOSED: ['VOTING_CLOSED', 'CANCELED'],
  VOTING_CLOSED: ['REVIEWING', 'CANCELED'],
  REVIEWING: ['FINALIZED', 'CANCELED'],
  FINALIZED: ['FULFILLED'],
  FULFILLED: [],
  CANCELED: [],
});

/** Spec §6: DRAFT → PROCESSING → REVIEW → APPROVED / REJECTED → WITHDRAWN. */
export const entryMachine = machine<EntryStatus>('entry', {
  DRAFT: ['PROCESSING', 'WITHDRAWN'],
  PROCESSING: ['REVIEW', 'DRAFT', 'WITHDRAWN'], // DRAFT on failed transcode (re-upload allowed)
  REVIEW: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  APPROVED: ['WITHDRAWN', 'REJECTED'], // REJECTED only via upheld report / fraud review
  REJECTED: ['APPROVED', 'WITHDRAWN'], // APPROVED only via upheld appeal
  WITHDRAWN: [],
});

/** Spec §8: PENDING → PAID → FULFILLING → SHIPPED → DELIVERED; refunds/disputes tracked separately. */
export const orderMachine = machine<OrderStatus>('order', {
  PENDING: ['PAID', 'CANCELED'],
  PAID: ['FULFILLING', 'SHIPPED', 'CANCELED'],
  FULFILLING: ['SHIPPED', 'CANCELED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELED: [],
});

export interface CampaignTimes {
  startsAt: Date;
  submissionEnd: Date;
  voteEnd: Date;
}

/**
 * The time-driven status a SCHEDULED/OPEN/... campaign should be in at `now`.
 * Admin-driven states (REVIEWING onwards) are never produced here.
 */
export function timeDrivenStatus(current: CampaignStatus, t: CampaignTimes, now: Date): CampaignStatus {
  const order: CampaignStatus[] = ['SCHEDULED', 'OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED'];
  if (!order.includes(current)) return current;
  let target: CampaignStatus = 'SCHEDULED';
  if (now >= t.startsAt) target = 'OPEN';
  if (now >= t.submissionEnd) target = 'SUBMISSION_CLOSED';
  if (now >= t.voteEnd) target = 'VOTING_CLOSED';
  return order.indexOf(target) > order.indexOf(current) ? target : current;
}

/** Server-timestamp gates used by every action (do not trust status alone). */
export const windows = {
  canPurchaseOffer: (t: CampaignTimes, now: Date) => now >= t.startsAt && now < t.submissionEnd,
  canSubmit: (t: CampaignTimes, now: Date) => now >= t.startsAt && now < t.submissionEnd,
  canVote: (t: CampaignTimes, now: Date) => now >= t.startsAt && now < t.voteEnd,
};
