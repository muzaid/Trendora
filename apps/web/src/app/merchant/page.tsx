import Link from 'next/link';
import { redirect } from 'next/navigation';
import { catalog, campaigns, orders, rewards, agents } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money, when, statusTone } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';
import { InventoryAdjust } from './inventory-adjust';

const TABS = ['campaigns', 'catalog', 'orders', 'rewards', 'team', 'assistant'] as const;

export default async function MerchantPage({ searchParams }: { searchParams: Promise<{ tab?: string; store?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?next=/merchant');
  const s = services();
  const ctx = await catalog.merchantContext(s, actor);
  const sp = await searchParams;
  if (ctx.organizations.length === 0) return <Onboard />;
  const stores = ctx.organizations.flatMap((o) => o.stores.map((st) => ({ ...st, org: o })));
  const store = stores.find((x) => x.id === sp.store) ?? stores[0]!;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? sp.tab! : 'campaigns';
  const q = (t: string) => `/merchant?store=${store.id}&tab=${t}`;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>{store.name} <span className="small muted">merchant console</span></h1>
          <p className="small">Organization {store.org.name} · <span className={`badge ${statusTone(store.org.verificationStatus)}`}>{store.org.verificationStatus}</span> · your role <span className="badge">{store.org.role}</span></p></div>
        <Link className="btn" href={`/stores/${store.slug}`}>View storefront</Link>
      </div>
      <nav className="tabs" aria-label="Merchant sections">{TABS.map((t) => <Link key={t} href={q(t)} aria-current={tab === t ? 'page' : undefined}>{t[0]!.toUpperCase() + t.slice(1)}</Link>)}</nav>
      {tab === 'campaigns' && <CampaignsTab storeId={store.id} list={await campaigns.merchantCampaigns(s, actor, store.id)} />}
      {tab === 'catalog' && <CatalogTab storeId={store.id} currency={store.currency} list={await catalog.merchantCatalog(s, actor, store.id)} />}
      {tab === 'orders' && <OrdersTab list={await orders.merchantOrders(s, actor, store.id)} />}
      {tab === 'rewards' && <RewardsTab data={await rewards.merchantRewards(s, actor, store.id)} />}
      {tab === 'team' && <TeamTab orgId={store.org.id} canManage={store.org.role === 'OWNER'} staff={store.org.role === 'OWNER' ? ((await catalog.listStaff(s, actor, store.org.id)) as { handle: string; displayName: string; role: string }[]) : []} />}
      {tab === 'assistant' && <AssistantTab orgId={store.org.id} campaigns={(await campaigns.merchantCampaigns(s, actor, store.id)).map((c) => ({ id: c.id, title: c.title }))} runs={(await agents.listAgentRuns(s, actor, store.org.id).catch(() => [])) as { id: string; agent: string; provider: string; status: string; output: { recommendations: { title: string; detail: string }[]; risk: { level: string; notes: string }; confidence: number; escalations: string[] } | null; costUsdMicros: number; createdAt: string }[]} />}
    </div>
  );
}

function Onboard() {
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <h1>Become a TRENDORA merchant</h1>
      <p className="muted">Create your organization and store. Business verification is required before campaigns can launch.</p>
      <ApiForm path="/v1/merchant/onboard" submitLabel="Create store"
        template={{ organizationName: { $: 'organizationName' }, legalName: { $: 'legalName' }, country: { $: 'country' }, store: { name: { $: 'storeName' }, slug: { $: 'slug' }, description: { $: 'description' }, currency: 'USD', country: { $: 'country' }, shippingPolicy: { $: 'shippingPolicy' }, returnPolicy: { $: 'returnPolicy' } } }}
        fields={[{ name: 'organizationName', label: 'Brand name', required: true }, { name: 'legalName', label: 'Legal business name', required: true }, { name: 'country', label: 'Country (ISO)', defaultValue: 'US', required: true }, { name: 'storeName', label: 'Store name', required: true }, { name: 'slug', label: 'Store URL slug (lowercase-with-dashes)', required: true }, { name: 'description', label: 'Description', type: 'textarea' }, { name: 'shippingPolicy', label: 'Shipping policy', type: 'textarea' }, { name: 'returnPolicy', label: 'Return policy', type: 'textarea' }]} />
    </div>
  );
}

function CampaignsTab({ storeId, list }: { storeId: string; list: Awaited<ReturnType<typeof campaigns.merchantCampaigns>> }) {
  return (
    <div className="stack">
      <div><Link className="btn primary" href={`/merchant/campaigns/new?store=${storeId}`}>New campaign</Link></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Campaign</th><th>Status</th><th>Funding</th><th>Dates</th><th>Approved entries</th></tr></thead>
        <tbody>{list.map((c) => (
          <tr key={c.id}><td><Link href={`/merchant/campaigns/${c.id}`}>{c.title}</Link></td><td><span className={`badge ${statusTone(c.status)}`}>{c.status}</span></td><td><span className={`badge ${statusTone(c.fundingStatus)}`}>{c.fundingStatus}</span></td><td className="small">{when(c.startsAt)} → {when(c.voteEnd)}</td><td>{c.entryCount}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function CatalogTab({ storeId, currency, list }: { storeId: string; currency: string; list: Awaited<ReturnType<typeof catalog.merchantCatalog>> }) {
  return (
    <div className="stack">
      <div className="table-wrap"><table>
        <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th>Available / reserved</th><th>Actions</th></tr></thead>
        <tbody>{list.flatMap((p) => p.variants.map((v, i) => {
          const vv = v as typeof v & { available: number; reserved: number; version: number };
          return (
            <tr key={v.id}>
              <td>{i === 0 ? <><strong>{p.title}</strong> <span className={`badge ${statusTone(p.status)}`}>{p.status}</span></> : ''}</td>
              <td>{v.sku} <span className="small muted">{v.title}</span></td>
              <td>{money(v.priceMinor, v.currency)}</td>
              <td>{vv.available} / {vv.reserved}</td>
              <td><InventoryAdjust variantId={v.id} version={vv.version} priceMinor={v.priceMinor} /></td>
            </tr>
          );
        }))}</tbody>
      </table></div>
      <div className="split">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Add product</h2>
          <ApiForm path="/v1/merchant/products" submitLabel="Create product" extra={{ storeId }}
            template={{ storeId, title: { $: 'title' }, description: { $: 'description' }, status: 'ACTIVE', imageUrls: [], variants: [{ sku: { $: 'sku' }, title: { $: 'variantTitle' }, priceMinor: { $: 'price' }, stock: { $: 'stock' }, attributes: {} }] }}
            fields={[{ name: 'title', label: 'Title', required: true }, { name: 'description', label: 'Description', type: 'textarea' }, { name: 'sku', label: 'SKU', required: true }, { name: 'variantTitle', label: 'Variant name', defaultValue: 'Default' }, { name: 'price', label: `Price (${currency})`, type: 'number', minor: true, required: true }, { name: 'stock', label: 'Initial stock', type: 'number', required: true, defaultValue: 0 }]} />
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>CSV import</h2>
          <p className="small muted">Columns: title,description,sku,variant_title,price_minor,stock[,image_url]</p>
          <ApiForm path="/v1/merchant/catalog/import" submitLabel="Import" extra={{ storeId }} successText="Imported."
            fields={[{ name: 'csv', label: 'CSV', type: 'textarea', required: true, defaultValue: 'title,description,sku,variant_title,price_minor,stock\nGlow Kit,Serum + mist bundle,GK-1,Kit,11900,50' }]} />
        </section>
      </div>
    </div>
  );
}

function OrdersTab({ list }: { list: Awaited<ReturnType<typeof orders.merchantOrders>> }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Order</th><th>Buyer</th><th>Items</th><th>Total</th><th>Status</th><th>Fulfilment</th></tr></thead>
      <tbody>{list.map((o) => (
        <tr key={o.id}>
          <td className="small">{o.id.slice(0, 8)}<div className="muted">{when(o.createdAt)}</div></td>
          <td>@{o.buyerHandle}</td>
          <td className="small">{o.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}</td>
          <td>{money(o.totalMinor, o.currency)}</td>
          <td><span className={`badge ${statusTone(o.status)}`}>{o.status}</span>{o.financialStatus !== 'NONE' && <> <span className="badge bad">{o.financialStatus}</span></>}</td>
          <td><div className="row">
            {o.status === 'PAID' && <ActionButton className="btn sm" path={`/v1/merchant/orders/${o.id}/transition`} body={{ to: 'SHIPPED', carrier: 'USPS', trackingNumber: `9400${o.id.slice(0, 8)}` }}>Mark shipped</ActionButton>}
            {o.status === 'SHIPPED' && <ActionButton className="btn sm" path={`/v1/merchant/orders/${o.id}/transition`} body={{ to: 'DELIVERED' }}>Mark delivered</ActionButton>}
            {o.financialStatus === 'NONE' && o.status !== 'CANCELED' && <ActionButton className="btn sm danger" path={`/v1/merchant/orders/${o.id}/refunds`} body={{ amountMinor: o.totalMinor, reason: 'Customer return' }} confirm="Refund this order in full? Linked challenge entries go to eligibility review.">Refund</ActionButton>}
          </div></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function RewardsTab({ data }: { data: Awaited<ReturnType<typeof rewards.merchantRewards>> }) {
  return (
    <div className="stack">
      <p>Coupons issued: <strong>{data.couponLiability.issued}</strong> · maximum outstanding coupon liability <strong>{money(data.couponLiability.maxOutstandingMinor)}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr><th>Campaign</th><th>Rank</th><th>Winner</th><th>Reward</th><th>Status</th><th>Deadline</th><th>Fulfil</th></tr></thead>
        <tbody>{data.rewards.map((r) => (
          <tr key={r.id}>
            <td className="small">{r.campaignTitle}</td><td>#{r.rank}</td><td>@{r.winnerHandle}</td><td>{r.title}</td>
            <td><span className={`badge ${statusTone(r.status)}`}>{r.status}</span>{r.overdue && <> <span className="badge bad">OVERDUE</span></>}</td>
            <td className="small">{when(r.deliveryDeadline)}</td>
            <td>{r.type === 'PRIZE' && r.status === 'CLAIMED' ? (
              <ApiForm path={`/v1/merchant/rewards/${r.id}/fulfill`} submitLabel="Record shipment" fields={[{ name: 'carrier', label: 'Carrier', required: true, defaultValue: 'UPS' }, { name: 'trackingNumber', label: 'Tracking #', required: true }]} />
            ) : r.type === 'PRIZE' && r.status === 'ISSUED' ? <span className="small muted">Awaiting winner claim</span> : null}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function TeamTab({ orgId, canManage, staff }: { orgId: string; canManage: boolean; staff: { handle: string; displayName: string; role: string }[] }) {
  if (!canManage) return <p className="muted">Only the organization owner manages staff access.</p>;
  return (
    <div className="split">
      <table><thead><tr><th>Member</th><th>Role</th></tr></thead><tbody>{staff.map((m) => <tr key={m.handle}><td>{m.displayName} <span className="muted small">@{m.handle}</span></td><td><span className="badge">{m.role}</span></td></tr>)}</tbody></table>
      <section className="card"><h2 style={{ marginTop: 0 }}>Grant access</h2>
        <ApiForm path={`/v1/merchant/orgs/${orgId}/staff`} submitLabel="Save role" fields={[{ name: 'userHandle', label: 'User handle', required: true }, { name: 'role', label: 'Role', type: 'select', options: ['MANAGER', 'CATALOG', 'CAMPAIGNS', 'FULFILLMENT', 'ANALYST'].map((r) => ({ value: r, label: r })) }]} />
      </section>
    </div>
  );
}

function AssistantTab({ orgId, campaigns: list, runs }: { orgId: string; campaigns: { id: string; title: string }[]; runs: { id: string; agent: string; provider: string; status: string; output: { recommendations: { title: string; detail: string }[]; risk: { level: string; notes: string }; confidence: number; escalations: string[] } | null; costUsdMicros: number; createdAt: string }[] }) {
  return (
    <div className="split">
      <div className="stack">
        {runs.length === 0 && <p className="muted">No assistant runs yet.</p>}
        {runs.map((r) => (
          <article key={r.id} className="card stack">
            <div className="row"><span className="badge violet">{r.agent}</span><span className={`badge ${statusTone(r.status)}`}>{r.status}</span><span className="small muted">{r.provider} · ${(r.costUsdMicros / 1e6).toFixed(4)} · {when(r.createdAt)}</span></div>
            {r.output?.recommendations.map((rec, i) => <div key={i}><strong>{rec.title}</strong><p className="small" style={{ margin: 0 }}>{rec.detail}</p></div>)}
            {r.output && <p className="small muted">Risk {r.output.risk.level}: {r.output.risk.notes} · confidence {Math.round(r.output.confidence * 100)}%</p>}
            {r.output?.escalations.map((e, i) => <p key={i} className="small" style={{ color: 'var(--warning)' }}>⚠ {e}</p>)}
            {r.status === 'SUCCEEDED' && <div className="row"><ActionButton className="btn sm" path={`/v1/agents/runs/${r.id}/decision`} body={{ decision: 'APPROVED' }}>Mark reviewed & accepted</ActionButton><ActionButton className="btn sm" path={`/v1/agents/runs/${r.id}/decision`} body={{ decision: 'DISMISSED' }}>Dismiss</ActionButton></div>}
          </article>
        ))}
      </div>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Ask an assistant</h2>
        <p className="small muted">Advisory only: assistants read aggregated, tenant-scoped data and can never publish campaigns, change prices, rank entries, issue rewards or move funds.</p>
        <ApiForm path="/v1/agents/runs" submitLabel="Run" extra={{ orgId }}
          fields={[{ name: 'agent', label: 'Assistant', type: 'select', options: ['CAMPAIGN', 'ANALYTICS', 'COMMERCE', 'MARKETING', 'TREND', 'VIDEO_STUDIO'].map((a) => ({ value: a, label: a })) }, { name: 'campaignId', label: 'Campaign', type: 'select', options: list.map((c) => ({ value: c.id, label: c.title })) }, { name: 'prompt', label: 'Notes (optional)', type: 'textarea' }]} />
      </section>
    </div>
  );
}
