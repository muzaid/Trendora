/** English-first with Hebrew and Arabic RTL readiness (spec §1). */
export const SUPPORTED_LOCALES = ['en', 'he', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
const RTL = new Set(['he', 'ar']);
export const isRtl = (locale: string) => RTL.has(locale.slice(0, 2));
export const dirFor = (locale: string): 'rtl' | 'ltr' => (isRtl(locale) ? 'rtl' : 'ltr');

export function formatMoney(amountMinor: number, currency: string, locale = 'en-US'): string {
  const digits = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 10 ** digits);
}

export function formatDateTime(iso: string | Date, locale = 'en-US', timeZone = 'UTC'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(d);
}
