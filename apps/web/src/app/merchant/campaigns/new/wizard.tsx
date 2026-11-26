'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CampaignRules } from '@trendora/contracts';
import { api, ErrorBox, type ApiError } from '@/components/client';

const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const day = 86_400_000;

export function CampaignWizard({ storeId, variants, rules }: { storeId: string; variants: { id: string; label: string; priceMinor: number }[]; rules: CampaignRules }) {
  const router = useRouter();
  const now = Date.now();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [weights, setWeights] = useState(rules.scoring.weights);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const num = (k: string) => Number(f.get(k));
      const tiers = [
        { rankFrom: 1, rankTo: 1, type: 'PRIZE', title: String(f.get('p1')), valueMinor: Math.round(num('p1v') * 100), percentOff: null },
        { rankFrom: 2, rankTo: 2, type: 'PRIZE', title: String(f.get('p2')), valueMinor: Math.round(num('p2v') * 100), percentOff: null },
        { rankFrom: 3, rankTo: 3, type: 'PRIZE', title: String(f.get('p3')), valueMinor: Math.round(num('p3v') * 100), percentOff: null },
        { rankFrom: 4, rankTo: 10, type: 'COUPON', title: `${num('c1')}% off your next order`, valueMinor: 0, percentOff: num('c1') },
        { rankFrom: 11, rankTo: 100, type: 'COUPON', title: `${num('c2')}% off your next order`, valueMinor: 0, percentOff: num('c2') },
        { rankFrom: 101, rankTo: null, type: 'COUPON', title: `${num('c3')}% off your next order`, valueMinor: 0, percentOff: num('c3') },
      ];
      const body = {
        storeId, title: f.get('title'), tagline: f.get('tagline'), description: f.get('description'),
        startsAt: new Date(String(f.get('startsAt'))).toISOString(), submissionEnd: new Date(String(f.get('submissionEnd'))).toISOString(),
        voteEnd: new Date(String(f.get('voteEnd'))).toISOString(), appealDeadline: new Date(String(f.get('appealDeadline'))).toISOString(),
        displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, inventoryCap: num('cap'),
        skus: [{ variantId: f.get('variantId'), requiredQty: num('requiredQty'), offerMinor: Math.round(num('offer') * 100) }],
        prizeTiers: tiers,
        rules: {
          ...rules,
          scoring: { ...rules.scoring, weights },
          eligibility: { ...rules.eligibility, countries: String(f.get('countries')).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), minAge: num('minAge'), entitlementMilestone: f.get('milestone'), alternativeEntry: f.get('alt') === 'on' },
          minEntries: num('minEntries'),
          coupon: { ...rules.coupon, validityDays: num('validity'), maxDiscountMinor: Math.round(num('maxDiscount') * 100) },
        },
      };
      setBusy(true); setError(null);
      try { const r = await api<{ campaignId: string }>('/v1/merchant/campaigns', { body }); router.push(`/merchant/campaigns/${r.campaignId}`); } catch (err) { setError(err as ApiError); setBusy(false); }
    }}>
      <fieldset className="card stack"><legend>Basics</legend>
        <label>Title<input name="title" required defaultValue="Glow Up Encore" /></label>
        <label>Tagline<input name="tagline" defaultValue="Show your best 60-second glow-up." /></label>
        <label>Description<textarea name="description" defaultValue="Buy at the challenge price, film a creative demo and compete on the published TrendScore." /></label>
      </fieldset>
      <fieldset className="card stack"><legend>Offer</legend>
        <label>Eligible SKU<select name="variantId">{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
        <div className="row"><label style={{ flex: 1 }}>Challenge price ($)<input name="offer" type="number" step="0.01" defaultValue="49" required /></label><label style={{ flex: 1 }}>Units per entry<input name="requiredQty" type="number" defaultValue={1} min={1} /></label><label style={{ flex: 1 }}>Inventory cap<input name="cap" type="number" defaultValue={500} min={1} /></label></div>
      </fieldset>
      <fieldset className="card stack"><legend>Dates (your local time)</legend>
        <div className="row">
          <label style={{ flex: 1 }}>Start<input name="startsAt" type="datetime-local" defaultValue={toLocal(new Date(now + day))} required /></label>
          <label style={{ flex: 1 }}>Submissions close<input name="submissionEnd" type="datetime-local" defaultValue={toLocal(new Date(now + 8 * day))} required /></label>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Voting ends<input name="voteEnd" type="datetime-local" defaultValue={toLocal(new Date(now + 15 * day))} required /></label>
          <label style={{ flex: 1 }}>Appeal deadline<input name="appealDeadline" type="datetime-local" defaultValue={toLocal(new Date(now + 17 * day))} required /></label>
        </div>
      </fieldset>
      <fieldset className="card stack"><legend>Prizes & coupons</legend>
        {[1, 2, 3].map((n) => <div key={n} className="row"><label style={{ flex: 2 }}>Rank {n} prize<input name={`p${n}`} required defaultValue={['Weekend getaway', 'Game console', 'Headphones'][n - 1]} /></label><label style={{ flex: 1 }}>Value ($)<input name={`p${n}v`} type="number" step="0.01" required defaultValue={[2500, 500, 350][n - 1]} /></label></div>)}
        <div className="row"><label style={{ flex: 1 }}>Ranks 4–10 coupon %<input name="c1" type="number" defaultValue={50} /></label><label style={{ flex: 1 }}>Ranks 11–100 %<input name="c2" type="number" defaultValue={35} /></label><label style={{ flex: 1 }}>All remaining %<input name="c3" type="number" defaultValue={20} /></label></div>
        <div className="row"><label style={{ flex: 1 }}>Coupon validity (days)<input name="validity" type="number" defaultValue={rules.coupon.validityDays} /></label><label style={{ flex: 1 }}>Max discount ($)<input name="maxDiscount" type="number" step="0.01" defaultValue={rules.coupon.maxDiscountMinor / 100} /></label></div>
      </fieldset>
      <fieldset className="card stack"><legend>Eligibility</legend>
        <div className="row"><label style={{ flex: 1 }}>Countries (ISO, comma-separated)<input name="countries" defaultValue={rules.eligibility.countries.join(',')} /></label><label style={{ flex: 1 }}>Minimum age<input name="minAge" type="number" defaultValue={rules.eligibility.minAge} /></label><label style={{ flex: 1 }}>Minimum entries<input name="minEntries" type="number" defaultValue={rules.minEntries} /></label></div>
        <label>Entry unlocks when the order is<select name="milestone" defaultValue={rules.eligibility.entitlementMilestone}><option value="PAID">Paid</option><option value="DELIVERED">Delivered</option></select></label>
        <label className="check"><input type="checkbox" name="alt" defaultChecked /> Offer a free alternative entry (required in many markets)</label>
      </fieldset>
      <fieldset className="card stack"><legend>Scoring weights (must total 100) — currently {total}</legend>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          {(Object.keys(weights) as (keyof typeof weights)[]).map((k) => <label key={k}>{k}<input type="number" value={weights[k]} min={0} max={100} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} /></label>)}
        </div>
      </fieldset>
      <ErrorBox error={error} />
      <div><button className="btn primary" disabled={busy || total !== 100}>{busy ? 'Saving…' : 'Save draft'}</button></div>
    </form>
  );
}
