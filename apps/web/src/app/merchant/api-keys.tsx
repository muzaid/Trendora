'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, type ApiError } from '@/components/client';

interface Key { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string | null }

/** Owner-only: API keys for the business's own website / POS to validate and redeem codes. */
export function ApiKeys({ storeId, keys, appUrl }: { storeId: string; keys: Key[]; appUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState('Website checkout');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="stack">
      <p className="small muted">Let your own website or till system check and redeem TRENDORA coupon codes automatically. Keys only allow coupon lookup and redemption for this store.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setError(null); try { const r = await api<{ key: string }>(`/v1/merchant/stores/${storeId}/api-keys`, { body: { name } }); setCreated(r.key); router.refresh(); } catch (err) { setError(err as ApiError); } }}>
        <label style={{ flex: 1 }}>Key name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
        <button className="btn primary">Create key</button>
      </form>
      <ErrorBox error={error} />
      {created && (
        <div className="alert warn" role="status">
          <strong>Copy this key now — it will not be shown again.</strong>
          <div className="code" style={{ fontSize: 14, wordBreak: 'break-all', marginTop: 6 }}>{created}</div>
          <pre className="json">{`curl -X POST ${appUrl}/v1/stores/${storeId}/coupons/redeem \\
  -H "Authorization: Bearer ${created}" -H "Content-Type: application/json" \\
  -d '{"code":"TR-XXXX-XXXX-XXXX","purchaseMinor":5000,"reference":"ORDER-1001"}'`}</pre>
        </div>
      )}
      <table><thead><tr><th>Name</th><th>Key</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>{keys.map((k) => (
          <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td className="small">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
            <td>{k.revokedAt ? <span className="badge bad">REVOKED</span> : <span className="badge ok">ACTIVE</span>}</td>
            <td>{!k.revokedAt && <button className="btn sm danger" onClick={async () => { if (!window.confirm('Revoke this key? Systems using it will stop working.')) return; try { await api(`/v1/merchant/api-keys/${k.id}/revoke`, { body: {} }); router.refresh(); } catch (err) { setError(err as ApiError); } }}>Revoke</button>}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}
