import Link from 'next/link';
import { notFound } from 'next/navigation';
import { catalog } from '@trendora/services';
import { isAppError } from '@trendora/contracts';
import { services } from '@/server/runtime';
import { money, when } from '@/lib/format';

export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await catalog.publicStore(services(), slug).catch((e) => { if (isAppError(e)) notFound(); throw e; });
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="hero">
        <h1>{store.name}</h1>
        <p className="muted">{store.description}</p>
        <div className="row small muted"><span>🚚 {store.shippingPolicy}</span><span>↩︎ {store.returnPolicy}</span></div>
      </section>
      {store.activeCampaigns.length > 0 && (
        <section>
          <h2>Challenges</h2>
          <div className="grid">
            {store.activeCampaigns.map((c) => (
              <Link key={c.id} href={`/campaigns/${c.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                <span className="badge violet">{c.status.replace('_', ' ')}</span>
                <h3 style={{ marginTop: 8 }}>{c.title}</h3>
                <p className="small muted">{c.tagline}</p>
                <p className="small">Voting ends {when(c.voteEnd)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>Products</h2>
        <div className="grid">
          {store.products.map((p) => {
            const v = p.variants[0];
            const offer = p.campaignOffers[0];
            return (
              <Link key={p.id} href={`/products/${p.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                {p.imageUrls[0] && <img src={p.imageUrls[0]} alt="" width={400} height={400} style={{ width: '100%', height: 'auto', borderRadius: 10 }} />}
                <h3 style={{ marginTop: 10 }}>{p.title}</h3>
                {v && (offer ? <p><span className="price-old">{money(v.priceMinor, v.currency)}</span><span className="price-new">{money(offer.offerMinor, v.currency)}</span> <span className="badge violet">Challenge price</span></p> : <p>{money(v.priceMinor, v.currency)}</p>)}
                <p className="small muted">{p.variants.some((x) => x.inStock) ? 'In stock' : 'Out of stock'} · {p.variants.length} option{p.variants.length > 1 ? 's' : ''}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
