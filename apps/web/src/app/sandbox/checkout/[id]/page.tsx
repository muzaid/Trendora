import { redirect } from 'next/navigation';
import { checkout } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money, when } from '@/lib/format';
import { ActionButton } from '@/components/client';

export default async function SandboxCheckout({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) redirect(`/login?next=/sandbox/checkout/${id}`);
  const view = await checkout.sandboxCheckoutView(services(), actor, id);
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <span className="badge sandbox">SANDBOX PAYMENT PROVIDER</span>
      <h1>Hosted checkout</h1>
      <p className="muted">This page simulates the payment provider&apos;s hosted checkout. Choosing an outcome sends a signed webhook to TRENDORA, exactly as a real provider would.</p>
      <div className="card stack">
        <strong>{view.storeName}</strong>
        <table><tbody>
          {view.items.map((i) => <tr key={i.title}><td>{i.title} × {i.qty}</td><td>{money(i.unitMinor * i.qty, view.currency)}</td></tr>)}
          {view.discountMinor > 0 && <tr><td>Coupon discount</td><td>−{money(view.discountMinor, view.currency)}</td></tr>}
          <tr><th>Total</th><th>{money(view.totalMinor, view.currency)}</th></tr>
        </tbody></table>
        <p className="small muted">Stock is reserved until {when(view.expiresAt)}. Status: {view.status}</p>
        {view.status === 'OPEN' ? (
          <div className="row">
            <ActionButton className="btn primary" path={`/v1/sandbox/checkouts/${id}/pay`} body={{ outcome: 'succeeded' }} redirectTo="/me?tab=orders">Pay {money(view.totalMinor, view.currency)} (sandbox)</ActionButton>
            <ActionButton className="btn danger" path={`/v1/sandbox/checkouts/${id}/pay`} body={{ outcome: 'failed' }} redirectTo="/me?tab=orders">Simulate declined card</ActionButton>
          </div>
        ) : <div className="alert">This checkout is {view.status.toLowerCase()}.</div>}
      </div>
    </div>
  );
}
