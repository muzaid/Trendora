/**
 * Deterministic engagement validity rules (spec §7). These decide whether an
 * event counts; they never sanction users (that needs human review).
 */
export interface EventContext {
  type: string;
  actorId: string | null;
  creatorId: string;
  actorCreatedAt: Date | null;
  actorRisk: number;
  occurredAt: Date;
  recentActorEventsSameType: number; // within the last minute
  priorSameTypeForEntry: number; // by this actor/visitor
}
export interface VotingPolicy { minAccountAgeHours: number; maxLikesPerMinute: number; viewCapPerUser: number }

export type InvalidReason = 'SELF_ENGAGEMENT' | 'ACCOUNT_TOO_NEW' | 'RATE_LIMIT_BURST' | 'VIEW_CAP' | 'HIGH_RISK_ACCOUNT' | 'ANONYMOUS';

export function eventInvalidReason(e: EventContext, policy: VotingPolicy): InvalidReason | null {
  if (e.actorId && e.actorId === e.creatorId) return 'SELF_ENGAGEMENT';
  if (e.type === 'LIKE' || e.type === 'COMMENT' || e.type === 'FOLLOW') {
    if (!e.actorId) return 'ANONYMOUS';
    if (policy.minAccountAgeHours > 0 && e.actorCreatedAt && e.occurredAt.getTime() - e.actorCreatedAt.getTime() < policy.minAccountAgeHours * 3_600_000) return 'ACCOUNT_TOO_NEW';
    if (e.actorRisk >= 80) return 'HIGH_RISK_ACCOUNT';
  }
  if (e.type === 'LIKE' && e.recentActorEventsSameType >= policy.maxLikesPerMinute) return 'RATE_LIMIT_BURST';
  if ((e.type === 'IMPRESSION' || e.type === 'VIEW_COMPLETE') && e.priorSameTypeForEntry >= policy.viewCapPerUser) return 'VIEW_CAP';
  return null;
}

/** Device/network anomaly: many distinct accounts engaging one entry from the same device or network. */
export function clusterAnomaly(distinctActorsOnSameDevice: number, threshold = 3): boolean {
  return distinctActorsOnSameDevice >= threshold;
}
