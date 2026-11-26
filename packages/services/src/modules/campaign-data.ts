import { notFound, type CampaignRules, type CampaignStatus } from '@trendora/contracts';
import type { Q } from '../context';
import { getSetting } from '../ops';

export interface CampaignRow {
  id: string;
  store_id: string;
  title: string;
  tagline: string;
  description: string;
  status: CampaignStatus;
  starts_at: Date;
  submission_end: Date;
  vote_end: Date;
  appeal_deadline: Date;
  display_timezone: string;
  currency: string;
  inventory_cap: number;
  rules_version: number;
  rules: CampaignRules;
  rules_hash: string | null;
  version: number;
  funding_status: string;
  funding_evidence: unknown;
  frozen: boolean;
  frozen_reason: string | null;
  cancel_reason: string | null;
  review_notes: string | null;
  created_by: string;
  published_at: Date | null;
  finalized_at: Date | null;
  created_at: Date;
}

export async function loadCampaign(q: Q, id: string, opts: { forUpdate?: boolean } = {}): Promise<CampaignRow> {
  const row = await q.maybeOne<CampaignRow>(`select * from campaigns where id = $1 ${opts.forUpdate ? 'for update' : ''}`, [id]);
  if (!row) throw notFound('Campaign');
  return row;
}

export const times = (c: CampaignRow) => ({ startsAt: new Date(c.starts_at), submissionEnd: new Date(c.submission_end), voteEnd: new Date(c.vote_end) });

/** Platform-wide kill switches (spec §15 incident response). */
export async function killSwitches(q: Q): Promise<{ commerceFrozen: boolean; payoutsFrozen: boolean }> {
  const v = await getSetting<{ commerceFrozen?: boolean; payoutsFrozen?: boolean }>(q, 'kill_switch');
  return { commerceFrozen: v?.commerceFrozen ?? false, payoutsFrozen: v?.payoutsFrozen ?? false };
}
