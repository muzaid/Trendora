'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, type ApiError } from '@/components/client';

interface Lookup {
  valid: boolean; reason: string | null; discountMinor: number | null;
  coupon: { codeLast4: string; percentOff: number; maxDiscountMinor: number; minSpendMinor: number; currency: string; expiresAt: string; usedCount: number; usageLimit: number; status: string; exclusions: string; campaignTitle: string; holderHandle: string | null };
}
const fmt = (m: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(m / 100);
const toMinor = (v: string) => Math.round(Number(v) * 100);

/** Store staff redeem a shopper's TRENDORA coupon for a purchase made directly with the business. */
export function CouponRedeem({ storeId, currency }: { storeId: string; currency: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [total, setTotal] = useState('');
  const [eligible, setEligible] = useState('');
  const [reference, setReference] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [done, setDone] = useState<{ discountMinor: number; payableMinor: number; currency: string; replay: boolean } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const amounts = () => ({ purchaseMinor: toMinor(total), ...(eligible ? { eligibleMinor: toMinor(eligible) } : {}) });
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e as ApiError); } finally { setBusy(false); } };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { setDone(null); setLookup(await api<Lookup>(`/v1/stores/${storeId}/coupons/lookup`, { body: { code, ...amounts() } })); }); }}>
      <label>Coupon code<input value={code} onChange={(e) => { setCode(e.target.value); setLookup(null); setDone(null); }} placeholder="TR-XXXX-XXXX-XXXX" required autoComplete="off" data-testid="redeem-code" /></label>
      <div className="row">
        <label style={{ flex: 1 }}>Purchase total ({currency})<input type="number" step="0.01" min="0.01" value={total} onChange={(e) => { setTotal(e.target.value); setLookup(null); }} required data-testid="redeem-total" /></label>
        <label style={{ flex: 1 }}>Eligible amount (optional)<input type="number" step="0.01" min="0.01" value={eligible} onChange={(e) => { setEligible(e.target.value); setLookup(null); }} aria-describedby="elig-help" /></label>
      </div>
      <span className="small muted" id="elig-help">Leave empty if the whole purchase qualifies. Exclude items the coupon terms exclude.</span>
      <label>Receipt / order number<input value={reference} onChange={(e) => setReference(e.target.value)} required maxLength={120} data-testid="redeem-reference" /></label>
      <div><button className="btn" disabled={busy}>{busy && !lookup ? 'Checking…' : 'Check code'}</button></div>
      <ErrorBox error={error} />
      {lookup && (
        <div className={`alert ${lookup.valid ? 'ok' : 'error'}`} role="status" data-testid="redeem-lookup">
          <strong>{lookup.valid ? 'Valid coupon' : `Cannot redeem: ${lookup.reason}`}</strong>
          <p className="small" style={{ margin: '6px 0' }}>
            {lookup.coupon.percentOff}% off (max {fmt(lookup.coupon.maxDiscountMinor, lookup.coupon.currency)}){lookup.coupon.minSpendMinor ? `, min spend ${fmt(lookup.coupon.minSpendMinor, lookup.coupon.currency)}` : ''} · from {lookup.coupon.campaignTitle}
            {lookup.coupon.holderHandle && <> · issued to @{lookup.coupon.holderHandle}</>} · expires {new Date(lookup.coupon.expiresAt).toLocaleDateString()} · used {lookup.coupon.usedCount}/{lookup.coupon.usageLimit}
          </p>
          {lookup.coupon.exclusions && <p className="small muted" style={{ margin: 0 }}>{lookup.coupon.exclusions}</p>}
          {lookup.valid && lookup.discountMinor !== null && (
            <div className="row" style={{ marginTop: 8 }}>
              <span>Discount <strong>{fmt(lookup.discountMinor, lookup.coupon.currency)}</strong> · customer pays <strong>{fmt(toMinor(total) - lookup.discountMinor, lookup.coupon.currency)}</strong></span>
              <button type="button" className="btn primary" disabled={busy} data-testid="redeem-confirm" onClick={() => void run(async () => {
                const r = await api<{ discountMinor: number; payableMinor: number; currency: string; replay: boolean }>(`/v1/stores/${storeId}/coupons/redeem`, { body: { code, reference, ...amounts() } });
                setDone(r); setLookup(null); setCode(''); setTotal(''); setEligible(''); setReference('');
                router.refresh();
              })}>Redeem coupon</button>
            </div>
          )}
        </div>
      )}
      {done && <div className="alert ok" role="status" data-testid="redeem-done">Redeemed{done.replay ? ' (already recorded for this receipt)' : ''}: discount {fmt(done.discountMinor, done.currency)}, customer pays {fmt(done.payableMinor, done.currency)}.</div>}
    </form>
  );
}
