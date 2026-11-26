'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, type ApiError } from '@/components/client';

export function InventoryAdjust({ variantId, version, priceMinor }: { variantId: string; version: number; priceMinor: number }) {
  const router = useRouter();
  const [delta, setDelta] = useState(10);
  const [price, setPrice] = useState((priceMinor / 100).toFixed(2));
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <label className="visually-hidden" htmlFor={`d-${variantId}`}>Stock change</label>
        <input id={`d-${variantId}`} type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} style={{ width: 90 }} />
        <button className="btn sm" onClick={async () => { setError(null); try { await api(`/v1/merchant/variants/${variantId}/inventory`, { body: { delta, expectedVersion: version } }); router.refresh(); } catch (e) { setError(e as ApiError); } }}>Adjust stock</button>
      </div>
      <div className="row">
        <label className="visually-hidden" htmlFor={`p-${variantId}`}>Price</label>
        <input id={`p-${variantId}`} type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 90 }} />
        <button className="btn sm" onClick={async () => { setError(null); try { await api(`/v1/merchant/variants/${variantId}/price`, { method: 'PUT', body: { priceMinor: Math.round(Number(price) * 100) } }); router.refresh(); } catch (e) { setError(e as ApiError); } }}>Set price</button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
