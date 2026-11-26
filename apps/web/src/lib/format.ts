import { formatMoney, formatDateTime } from '@trendora/ui';

export const money = (minor: number, currency = 'USD', locale = 'en-US') => formatMoney(minor, currency, locale);
export const when = (iso: string | null | undefined, tz = 'UTC', locale = 'en-US') => (iso ? formatDateTime(iso, locale, tz) : '—');
export const statusTone = (s: string) =>
  ['APPROVED', 'PAID', 'DELIVERED', 'FULFILLED', 'VERIFIED', 'OPEN', 'ACTIVE', 'READY', 'FINAL', 'SUCCEEDED', 'CLAIMED', 'UPHELD'].includes(s)
    ? 'ok'
    : ['REJECTED', 'CANCELED', 'FAILED', 'REVOKED', 'FORFEITED', 'SUSPENDED', 'DEAD', 'DENIED'].includes(s)
      ? 'bad'
      : ['REVIEW', 'PENDING', 'PROCESSING', 'UNDER_REVIEW', 'PROVISIONAL', 'REVIEWING', 'ISSUED', 'SCHEDULED'].includes(s)
        ? 'warn'
        : '';
