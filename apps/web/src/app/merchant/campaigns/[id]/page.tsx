import Link from 'next/link';
import { redirect } from 'next/navigation';
import { campaigns, analytics } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money, when, statusTone } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';

export default async function MerchantCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  const { id } = await params;
  if (!actor) redirect(`/login?next=/merchant/campaigns/${id}`);
  const s = services();
  const c = await campaigns.merchantCampaign(s, actor, id);
  const live = !['DRAFT', 'REVIEW', 'CANCELED'].includes(c.status);
  const a = live ? await analytics.campaignAnalytics(s, actor, id) : null;
  const model = await analytics.campaignModel(s, actor, id, 2000, 500_000);
  const required = c.prizeTiers.filter((t) => t.type === 'PRIZE').reduce((x, t) => x + t.valueMinor * ((t.rankTo ?? t.rankFrom) - t.rankFrom + 1), 0);
  return (
    <div className="stack">
      <Link href={`/merchant?store=${c.storeId}`} className="small">← Merchant console</Link>
      <div className="row"><h1 style={{ margin: 0 }}>{c.title}</h1><span className={`badge ${statusTone(c.status)}`}>{c.status}</span><span className={`badge ${statusTone(c.fundingStatus)}`}>Funding {c.fundingStatus}</span></div>
      {c.reviewNotes && <div className="alert">Platform review notes: {c.reviewNotes}</div>}
      {c.cancelReason && <div className="alert error">Canceled: {c.cancelReason}</div>}

      <div className="split">
        <div className="stack">
          {a && (
            <section className="card stack" aria-labelledby="an">
              <h2 id="an" style={{ marginTop: 0 }}>Performance</h2>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {[
                  ['Impressions (organic)', `${a.funnel.organicImpressions}`], ['Paid orders', `${a.funnel.paidOrders}`], ['Delivered', `${a.funnel.delivered}`], ['Entries', `${a.funnel.entries}`],
                  ['Delivered→entry', `${Math.round(a.rates.deliveredToEntry * 100)}%`], ['Qualified shares / entry', a.rates.sharesPerEntry.toFixed(1)], ['Repeat purchase', `${Math.round(a.rates.repeatPurchaseRate * 100)}%`], ['Invalid traffic', `${(a.rates.fraudRate * 100).toFixed(1)}%`],
                  ['Gross', money(a.revenue.grossMinor, a.currency)], ['Refunded', money(a.revenue.refundedMinor, a.currency)], ['Platform fee', money(a.revenue.commissionMinor, a.currency)], ['Contribution before COGS', money(a.revenue.contributionBeforeCogsMinor, a.currency)],
                  ['Coupon redemptions', `${a.revenue.couponRedemptions}`], ['Coupon revenue', money(a.revenue.couponAttributedRevenueMinor, a.currency)], ['Fraud flags', `${a.trust.fraudFlags}`], ['Reuse consents', `${a.videoRights.commercialReuseConsents}/${a.videoRights.approvedEntries}`],
                ].map(([k, v]) => <div key={k}><div className="kpi">{v}</div><div className="small muted">{k}</div></div>)}
              </div>
            </section>
          )}
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Preview</h2>
            <p className="muted">{c.tagline}</p>
            <p className="small">{c.description}</p>
            <p className="small">Starts {when(c.startsAt, c.displayTimezone)} · submissions close {when(c.submissionEnd, c.displayTimezone)} · voting ends {when(c.voteEnd, c.displayTimezone)} · appeals until {when(c.appealDeadline, c.displayTimezone)}</p>
            <table><thead><tr><th>SKU</th><th>Regular</th><th>Offer</th><th>Bundle qty</th></tr></thead><tbody>{c.skus.map((k) => <tr key={k.variantId}><td>{k.productTitle} — {k.variantTitle}</td><td>{money(k.regularMinor, c.currency)}</td><td>{money(k.offerMinor, c.currency)}</td><td>{k.requiredQty}</td></tr>)}</tbody></table>
            <h3 style={{ marginTop: 16 }}>Prize tiers</h3>
            <ul>{c.prizeTiers.map((t) => <li key={t.id}>#{t.rankFrom}{t.rankTo === t.rankFrom ? '' : `–${t.rankTo ?? '∞'}`}: {t.title} {t.type === 'PRIZE' ? `(${money(t.valueMinor, c.currency)})` : `(${t.percentOff}% coupon)`}</li>)}</ul>
            <p className="small muted">Scoring weights: {Object.entries(c.rules.scoring.weights).map(([k, v]) => `${k} ${v}%`).join(' · ')}</p>
          </section>
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Economics model (illustrative)</h2>
            <p className="small muted">Assumes unit cost {money(2000)} and other costs {money(500_000)} (fulfilment, refunds, payment fees, coupon liability). Adjust via the API: /model?unitCostMinor=&otherCostsMinor=.</p>
            <table><thead><tr><th>Units sold</th><th>Gross</th><th>Prizes</th><th>Platform fee</th><th>Contribution</th></tr></thead>
              <tbody>{model.sensitivity.map((r) => <tr key={r.units}><td>{r.units}</td><td>{money(r.grossMinor)}</td><td>{money(r.prizesMinor)}</td><td>{money(r.commissionMinor)}</td><td style={{ color: r.contributionMinor < 0 ? 'var(--danger)' : undefined }}>{money(r.contributionMinor)}</td></tr>)}</tbody></table>
          </section>
          {c.ruleVersions.length > 0 && (
            <section className="card small">
              <h2 style={{ marginTop: 0 }}>Published rule versions</h2>
              <ul>{(c.ruleVersions as { version: number; rulesHash: string; reason: string; participantRemedy: string | null }[]).map((v) => <li key={v.version}>v{v.version} · {v.rulesHash.slice(0, 16)}… · {v.reason}{v.participantRemedy ? ` · remedy: ${v.participantRemedy}` : ''}</li>)}</ul>
            </section>
          )}
        </div>
        <aside className="stack">
          <section className="card stack">
            <h2 style={{ marginTop: 0 }}>Launch checklist</h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="checklist">{c.checklist.items.map((i) => <li key={i.key} className="small" style={{ marginBottom: 6 }}>{i.ok ? '✅' : '⬜️'} {i.label}</li>)}</ul>
            {c.status === 'DRAFT' && <ActionButton className="btn primary" path={`/v1/merchant/campaigns/${c.id}/publish`}>Submit for platform review</ActionButton>}
            {c.status === 'REVIEW' && <p className="small">Awaiting platform review. Rules freeze when approved.</p>}
          </section>
          {['DRAFT', 'REVIEW'].includes(c.status) && c.fundingStatus !== 'VERIFIED' && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Prize funding</h2>
              <p className="small muted">Required: {money(required, c.currency)}. Provide a verified escrow, bank guarantee or prepaid-inventory reference. TRENDORA does not hold prize money.</p>
              <ApiForm path={`/v1/merchant/campaigns/${c.id}/funding`} submitLabel="Submit evidence" fields={[{ name: 'method', label: 'Method', type: 'select', options: [{ value: 'ESCROW_PROVIDER', label: 'Licensed escrow provider' }, { value: 'BANK_GUARANTEE', label: 'Bank guarantee' }, { value: 'PREPAID_INVENTORY', label: 'Prize inventory on hand' }] }, { name: 'reference', label: 'Reference', required: true }, { name: 'amountMinor', label: `Amount (${c.currency})`, type: 'number', minor: true, required: true, defaultValue: required / 100 }]} />
            </section>
          )}
          {c.status === 'DRAFT' && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Edit draft</h2>
              <ApiForm path={`/v1/merchant/campaigns/${c.id}`} method="PATCH" submitLabel="Save draft" extra={{ expectedVersion: c.version }} resetOnSuccess={false}
                fields={[{ name: 'title', label: 'Title', defaultValue: c.title }, { name: 'tagline', label: 'Tagline', defaultValue: c.tagline }, { name: 'inventoryCap', label: 'Inventory cap', type: 'number', defaultValue: c.inventoryCap }]} />
            </section>
          )}
          {['DRAFT', 'REVIEW', 'SCHEDULED'].includes(c.status) && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Cancel</h2>
              <ApiForm path={`/v1/merchant/campaigns/${c.id}/cancel`} submitLabel="Cancel campaign" fields={[{ name: 'reason', label: 'Reason (shared with participants)', type: 'textarea', required: true }]} />
            </section>
          )}
          {live && <Link className="btn" href={`/campaigns/${c.id}`}>Open public arena</Link>}
        </aside>
      </div>
    </div>
  );
}
