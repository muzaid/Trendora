import Link from 'next/link';
import { redirect } from 'next/navigation';
import { identity, orders, entries, rewards, trust } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money, when, statusTone } from '@/lib/format';
import { ApiForm } from '@/components/client';

const TABS = ['rewards', 'orders', 'entries', 'notifications', 'privacy'] as const;

export default async function MePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?next=/me');
  const s = services();
  const { tab: rawTab } = await searchParams;
  const tab = (TABS as readonly string[]).includes(rawTab ?? '') ? rawTab! : 'rewards';
  const me = await identity.me(s, actor);
  return (
    <div className="stack">
      <h1>Hi, {me.displayName}</h1>
      <nav className="tabs" aria-label="Profile sections">
        {TABS.map((t) => <Link key={t} href={`/me?tab=${t}`} aria-current={tab === t ? 'page' : undefined}>{t[0]!.toUpperCase() + t.slice(1)}{t === 'notifications' && me.unreadNotifications ? ` (${me.unreadNotifications})` : ''}</Link>)}
      </nav>
      {tab === 'rewards' && <RewardsTab list={await rewards.myRewards(s, actor)} />}
      {tab === 'orders' && <OrdersTab list={await orders.myOrders(s, actor)} entitlements={await entries.myEntitlements(s, actor)} />}
      {tab === 'entries' && <EntriesTab list={await entries.myEntries(s, actor)} appeals={(await trust.myAppeals(s, actor)) as { id: string; entryId: string; status: string; resolution: string | null }[]} />}
      {tab === 'notifications' && <NotificationsTab list={await identity.listNotifications(s, actor)} />}
      {tab === 'privacy' && (
        <section className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>Privacy & profile</h2>
          <ApiForm path="/v1/me" method="PATCH" submitLabel="Save" resetOnSuccess={false} successText="Saved."
            template={{ displayName: { $: 'displayName' }, locale: { $: 'locale' }, privacySettings: { showOnLeaderboard: { $: 'showOnLeaderboard' }, marketingEmails: { $: 'marketingEmails' } } }}
            fields={[
              { name: 'displayName', label: 'Display name', defaultValue: me.displayName, required: true },
              { name: 'locale', label: 'Language', type: 'select', defaultValue: me.locale, options: [{ value: 'en', label: 'English' }, { value: 'he', label: 'עברית (Hebrew, RTL preview)' }, { value: 'ar', label: 'العربية (Arabic, RTL preview)' }] },
              { name: 'showOnLeaderboard', label: 'Show my handle on public leaderboards', type: 'checkbox', defaultValue: (me.privacySettings as { showOnLeaderboard?: boolean }).showOnLeaderboard ?? true },
              { name: 'marketingEmails', label: 'Receive marketing emails', type: 'checkbox', defaultValue: (me.privacySettings as { marketingEmails?: boolean }).marketingEmails ?? false },
            ]} />
          <p className="small muted">Country {me.country ?? '—'} · birth year on file {me.birthYear ? 'yes' : 'no'} (used only for eligibility). To delete your account and data, contact support — deletion requests are processed under the retention policy.</p>
        </section>
      )}
    </div>
  );
}

function RewardsTab({ list }: { list: Awaited<ReturnType<typeof rewards.myRewards>> }) {
  if (!list.length) return <p className="muted">No rewards yet. Enter a challenge to compete for prizes and coupons.</p>;
  return (
    <div className="grid">
      {list.map((r) => (
        <article key={r.id} className="card stack" data-testid="reward-card">
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="badge violet">Rank #{r.rank}</span><span className={`badge ${statusTone(r.status)}`}>{r.status}</span></div>
          <h3>{r.title}</h3>
          <p className="small muted">{r.campaignTitle}</p>
          {r.coupon && (
            <div className="stack">
              <div className="code" aria-label="Coupon code" data-testid="coupon-code">{r.coupon.code}</div>
              <p className="small">{r.coupon.percentOff}% off (max {money(r.coupon.maxDiscountMinor, r.coupon.currency)}){r.coupon.minSpendMinor ? `, min spend ${money(r.coupon.minSpendMinor, r.coupon.currency)}` : ''} at <Link href={`/stores/${r.coupon.storeSlug}`}>{r.coupon.storeSlug}</Link>. Expires {when(r.coupon.expiresAt)}. Used {r.coupon.usedCount}/{r.coupon.usageLimit}. <span className={`badge ${statusTone(r.coupon.status)}`}>{r.coupon.status}</span></p>
              <p className="small muted">{r.coupon.exclusions}</p>
            </div>
          )}
          {r.type === 'PRIZE' && r.status === 'ISSUED' && (
            <details open>
              <summary>Claim your prize (no fee)</summary>
              <ApiForm path={`/v1/rewards/${r.id}/claim`} submitLabel="Claim prize"
                template={{ acceptTerms: { $: 'acceptTerms' }, shippingAddress: { name: { $: 'name' }, line1: { $: 'line1' }, city: { $: 'city' }, region: { $: 'region' }, postalCode: { $: 'postalCode' }, country: { $: 'country' } } }}
                fields={[{ name: 'name', label: 'Full name', required: true }, { name: 'line1', label: 'Address', required: true }, { name: 'city', label: 'City', required: true }, { name: 'region', label: 'State' }, { name: 'postalCode', label: 'Postal code', required: true }, { name: 'country', label: 'Country', defaultValue: 'US', required: true }, { name: 'acceptTerms', label: 'I accept the prize terms', type: 'checkbox' }]} />
            </details>
          )}
          {r.type === 'PRIZE' && r.deliveryDeadline && <p className="small muted">Merchant delivery deadline {when(r.deliveryDeadline)}</p>}
          {r.status === 'FULFILLED' && r.type === 'PRIZE' && <p className="small">Shipped: {JSON.stringify(r.fulfillment)}</p>}
        </article>
      ))}
    </div>
  );
}

function OrdersTab({ list, entitlements }: { list: Awaited<ReturnType<typeof orders.myOrders>>; entitlements: Awaited<ReturnType<typeof entries.myEntitlements>> }) {
  return (
    <div className="stack">
      {entitlements.length > 0 && (
        <div className="alert ok">You have {entitlements.length} challenge entr{entitlements.length > 1 ? 'ies' : 'y'}: {entitlements.map((e) => <Link key={e.id} href={`/campaigns/${e.campaignId}`} style={{ marginInlineEnd: 8 }}>{e.campaignTitle} ({e.status.toLowerCase()})</Link>)}</div>
      )}
      {list.length === 0 && <p className="muted">No orders yet.</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>Order</th><th>Store</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead>
        <tbody>{list.map((o) => (
          <tr key={o.id} data-testid="order-row">
            <td className="small">{o.id.slice(0, 8)}</td><td>{o.storeName}</td>
            <td className="small">{o.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}</td>
            <td>{money(o.totalMinor, o.currency)}{o.discountMinor > 0 && <div className="small muted">−{money(o.discountMinor, o.currency)} coupon</div>}</td>
            <td><span className={`badge ${statusTone(o.status)}`}>{o.status}</span>{o.financialStatus !== 'NONE' && <> <span className="badge bad">{o.financialStatus}</span></>}</td>
            <td className="small">{when(o.createdAt)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function EntriesTab({ list, appeals }: { list: Awaited<ReturnType<typeof entries.myEntries>>; appeals: { id: string; entryId: string; status: string; resolution: string | null }[] }) {
  if (!list.length) return <p className="muted">No entries yet.</p>;
  return (
    <div className="grid">
      {list.map((e) => (
        <article key={e.id} className="card stack">
          <div className="row"><span className={`badge ${statusTone(e.status)}`}>{e.status}</span><span className="badge">{e.videoStatus}</span></div>
          <Link href={`/campaigns/${e.campaignId}`}>{e.campaignTitle}</Link>
          <p className="small">{e.caption}</p>
          {e.videoFailure && <p className="small" style={{ color: 'var(--danger)' }}>Processing failed: {e.videoFailure}</p>}
          {e.rejectionReason && <p className="small">Reason: {e.rejectionReason}</p>}
          {e.playbackUrl && <video src={e.playbackUrl} controls muted playsInline preload="metadata" style={{ width: '100%', borderRadius: 8 }} aria-label={e.caption || 'My entry'} />}
          {appeals.filter((a) => a.entryId === e.id).map((a) => <p key={a.id} className="small">Appeal: <span className="badge">{a.status}</span> {a.resolution}</p>)}
        </article>
      ))}
    </div>
  );
}

function NotificationsTab({ list }: { list: Awaited<ReturnType<typeof identity.listNotifications>> }) {
  if (!list.length) return <p className="muted">You&apos;re all caught up.</p>;
  return <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{list.map((n) => <li key={n.id} className="card small"><strong>{n.type}</strong> <span className="muted">{when(n.createdAt)}</span><pre className="json">{JSON.stringify(n.payload, null, 1)}</pre></li>)}</ul>;
}
