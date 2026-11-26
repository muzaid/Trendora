'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, newIdempotencyKey, type ApiError } from '@/components/client';

interface Product {
  id: string; title: string;
  variants: { id: string; title: string; priceMinor: number; currency: string; inStock: boolean }[];
  campaignOffers: { campaignId: string; variantId: string; offerMinor: number; requiredQty: number }[];
}
const fmt = (m: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(m / 100);

export function BuyBox({ product, signedIn, preferredCampaignId }: { product: Product; signedIn: boolean; preferredCampaignId?: string }) {
  const router = useRouter();
  const [variantId, setVariantId] = useState(product.variants.find((v) => v.inStock)?.id ?? product.variants[0]?.id ?? '');
  const [qty, setQty] = useState(1);
  const [useOffer, setUseOffer] = useState(true);
  const [coupon, setCoupon] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const v = product.variants.find((x) => x.id === variantId);
  const offers = product.campaignOffers.filter((o) => o.variantId === variantId);
  const offer = offers.find((o) => o.campaignId === preferredCampaignId) ?? offers[0];
  if (!v) return <p>Unavailable</p>;
  const unit = offer && useOffer ? offer.offerMinor : v.priceMinor;
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault();
      if (!signedIn) { router.push(`/login?next=/products/${product.id}`); return; }
      const fd = new FormData(e.currentTarget);
      setBusy(true); setError(null);
      try {
        const r = await api<{ hostedUrl: string }>('/v1/checkouts', {
          headers: { 'idempotency-key': key },
          body: {
            ...(offer && useOffer ? { campaignId: offer.campaignId } : {}),
            items: [{ variantId, qty }],
            ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
            shippingAddress: { name: fd.get('name'), line1: fd.get('line1'), city: fd.get('city'), region: fd.get('region') || undefined, postalCode: fd.get('postalCode'), country: fd.get('country') },
          },
        });
        window.location.assign(r.hostedUrl);
      } catch (err) { setError(err as ApiError); setBusy(false); }
    }}>
      <h2 style={{ margin: 0 }}>Buy</h2>
      <label>Option
        <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
          {product.variants.map((x) => <option key={x.id} value={x.id} disabled={!x.inStock}>{x.title} — {fmt(x.priceMinor, x.currency)}{x.inStock ? '' : ' (sold out)'}</option>)}
        </select>
      </label>
      <label>Quantity<input type="number" min={1} max={20} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} /></label>
      {offer && (
        <label className="check"><input type="checkbox" checked={useOffer} onChange={(e) => setUseOffer(e.target.checked)} /> Buy at the challenge price ({fmt(offer.offerMinor, v.currency)}) and receive a challenge entry after delivery</label>
      )}
      <label>Coupon code (optional)<input value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="TR-XXXX-XXXX-XXXX" autoComplete="off" /></label>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">Shipping address</legend>
        <label>Full name<input name="name" required autoComplete="name" /></label>
        <label>Address<input name="line1" required autoComplete="address-line1" /></label>
        <div className="row"><label style={{ flex: 1 }}>City<input name="city" required autoComplete="address-level2" /></label><label style={{ flex: 1 }}>State<input name="region" autoComplete="address-level1" /></label></div>
        <div className="row"><label style={{ flex: 1 }}>Postal code<input name="postalCode" required autoComplete="postal-code" /></label><label style={{ flex: 1 }}>Country<input name="country" defaultValue="US" maxLength={2} required /></label></div>
      </fieldset>
      <p>Estimated subtotal: <strong>{fmt(unit * qty, v.currency)}</strong> <span className="small muted">— final price is calculated by the server.</span></p>
      <ErrorBox error={error} />
      <button className="btn primary" disabled={busy || !v.inStock} data-testid="checkout-button">{busy ? 'Reserving stock…' : signedIn ? 'Continue to secure payment' : 'Sign in to buy'}</button>
    </form>
  );
}
