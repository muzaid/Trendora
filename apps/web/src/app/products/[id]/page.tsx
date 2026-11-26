import Link from 'next/link';
import { notFound } from 'next/navigation';
import { catalog } from '@trendora/services';
import { isAppError } from '@trendora/contracts';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money } from '@/lib/format';
import { BuyBox } from './buy-box';

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ campaign?: string }> }) {
  const { id } = await params;
  const { campaign } = await searchParams;
  const product = await catalog.publicProduct(services(), id).catch((e) => { if (isAppError(e)) notFound(); throw e; });
  const actor = await currentActor();
  return (
    <div className="split">
      <div className="stack">
        {product.imageUrls[0] && <img src={product.imageUrls[0]} alt={product.title} width={400} height={400} style={{ width: '100%', maxWidth: 480, height: 'auto', borderRadius: 16 }} />}
        <h1>{product.title}</h1>
        <p className="muted">{product.description}</p>
        <p className="small">Sold by <Link href={`/stores/${product.store.slug}`}>{product.store.name}</Link> · {product.store.shippingPolicy} · {product.store.returnPolicy}</p>
        {product.relatedEntries.length > 0 && (
          <section>
            <h2>Creator videos</h2>
            <ul>{product.relatedEntries.map((e) => <li key={e.entryId}><Link href={`/entries/${e.entryId}`}>@{e.creatorHandle}: {e.caption}</Link></li>)}</ul>
          </section>
        )}
        {product.priceHistory.length > 0 && <p className="small muted">Price history: {product.priceHistory.map((h) => money(h.priceMinor)).join(' ← ')}</p>}
      </div>
      <aside className="card stack" aria-label="Purchase">
        <BuyBox product={product} signedIn={!!actor} preferredCampaignId={campaign} />
      </aside>
    </div>
  );
}
