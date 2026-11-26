import { invalid } from '@trendora/contracts';
import { bpsOfMinor, assertMinor } from './money';

/**
 * Double-entry journal construction. Sign convention: debit > 0, credit < 0.
 * Every journal must sum to zero (also enforced by a deferred DB constraint trigger).
 */
export interface JournalLine { accountCode: string; amountMinor: number }
export interface JournalDraft { externalEventId: string; type: string; currency: string; memo: string; lines: JournalLine[] }

export const ACCOUNTS = {
  providerClearing: 'asset:provider_clearing',
  merchantPayable: (storeId: string) => `liability:merchant_payable:${storeId}`,
  platformCommission: 'revenue:platform_commission',
  disputeReserve: 'asset:dispute_reserve',
} as const;

export function assertBalanced(lines: JournalLine[]): void {
  if (lines.length < 2) throw invalid('A journal needs at least two lines');
  for (const l of lines) if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor === 0) throw invalid('Journal lines must be non-zero integers');
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== 0) throw invalid(`Journal is unbalanced by ${sum}`);
}

function compact(lines: JournalLine[]): JournalLine[] {
  return lines.filter((l) => l.amountMinor !== 0);
}

export function paymentJournal(p: { eventId: string; orderId: string; storeId: string; currency: string; amountMinor: number; commissionBps: number }): JournalDraft {
  assertMinor(p.amountMinor);
  const commission = bpsOfMinor(p.amountMinor, p.commissionBps);
  const lines = compact([
    { accountCode: ACCOUNTS.providerClearing, amountMinor: p.amountMinor },
    { accountCode: ACCOUNTS.merchantPayable(p.storeId), amountMinor: -(p.amountMinor - commission) },
    { accountCode: ACCOUNTS.platformCommission, amountMinor: -commission },
  ]);
  assertBalanced(lines);
  return { externalEventId: p.eventId, type: 'PAYMENT_CAPTURED', currency: p.currency, memo: `order ${p.orderId}`, lines };
}

export function refundJournal(p: { eventId: string; orderId: string; storeId: string; currency: string; amountMinor: number; commissionBps: number }): JournalDraft {
  assertMinor(p.amountMinor);
  const commission = bpsOfMinor(p.amountMinor, p.commissionBps);
  const lines = compact([
    { accountCode: ACCOUNTS.merchantPayable(p.storeId), amountMinor: p.amountMinor - commission },
    { accountCode: ACCOUNTS.platformCommission, amountMinor: commission },
    { accountCode: ACCOUNTS.providerClearing, amountMinor: -p.amountMinor },
  ]);
  assertBalanced(lines);
  return { externalEventId: p.eventId, type: 'REFUND', currency: p.currency, memo: `order ${p.orderId}`, lines };
}

export function disputeJournal(p: { eventId: string; orderId: string; storeId: string; currency: string; amountMinor: number }): JournalDraft {
  const lines = [
    { accountCode: ACCOUNTS.merchantPayable(p.storeId), amountMinor: p.amountMinor },
    { accountCode: ACCOUNTS.providerClearing, amountMinor: -p.amountMinor },
  ];
  assertBalanced(lines);
  return { externalEventId: p.eventId, type: 'DISPUTE_OPENED', currency: p.currency, memo: `order ${p.orderId}`, lines };
}
