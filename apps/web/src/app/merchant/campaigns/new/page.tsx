import { redirect } from 'next/navigation';
import { catalog } from '@trendora/services';
import { defaultRules } from '@trendora/contracts';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { CampaignWizard } from './wizard';

export default async function NewCampaign({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?next=/merchant');
  const { store } = await searchParams;
  const s = services();
  const ctx = await catalog.merchantContext(s, actor);
  const st = ctx.organizations.flatMap((o) => o.stores).find((x) => x.id === store) ?? ctx.organizations[0]?.stores[0];
  if (!st) redirect('/merchant');
  const products = await catalog.merchantCatalog(s, actor, st.id);
  const variants = products.flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.title} — ${v.title} (${v.sku})`, priceMinor: v.priceMinor })));
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>New campaign</h1>
      <p className="muted">Drafts are private. Rules, dates, scoring weights and prize tiers freeze when the platform approves the campaign.</p>
      <CampaignWizard storeId={st.id} variants={variants} rules={defaultRules()} />
    </div>
  );
}
