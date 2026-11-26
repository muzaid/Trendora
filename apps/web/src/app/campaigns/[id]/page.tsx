import Link from 'next/link';
import { notFound } from 'next/navigation';
import { campaigns, engagement, ranking } from '@trendora/services';
import { isAppError } from '@trendora/contracts';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { money, when } from '@/lib/format';
import { Leaderboard } from '@/components/leaderboard';
import { FeedList } from '@/components/feed-list';
import { EntryPanel } from './entry-panel';

const WEIGHT_LABELS: Record<string, string> = { likes: 'Verified likes', shares: 'Qualified shares', creativity: 'Creativity (human rubric)', completion: 'Watch completion', comments: 'Meaningful comments', growth: 'Audience growth' };

export default async function ArenaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = services();
  const actor = await currentActor();
  const c = await campaigns.publicCampaign(s, id, actor).catch((e) => { if (isAppError(e)) notFound(); throw e; });
  const board = await ranking.leaderboard(s, id, undefined, 50);
  const feed = await engagement.feed(s, actor, undefined, 4, id);
  const tz = c.displayTimezone;
  const viewer = c.viewer as null | { eligible: boolean; ineligibleReason: string | null; alternativeEntryStatus: string | null; entitlements: { id: string; source: string; status: string; entryId: string | null; entryStatus: string | null }[] };
  const sku = c.skus[0];
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="hero stack">
        <div className="row"><span className="badge violet">{c.status.replace('_', ' ')}</span><span className="badge sandbox">Sponsored by {c.store.name}</span>{c.frozen && <span className="badge bad">Paused</span>}</div>
        <h1>{c.title}</h1>
        <p className="muted" style={{ maxWidth: 720 }}>{c.tagline}</p>
        <div className="row small">
          <span>Starts {when(c.startsAt, tz)}</span><span>· Submissions close {when(c.submissionEnd, tz)}</span><span>· Voting ends {when(c.voteEnd, tz)}</span><span>· Appeals until {when(c.appealDeadline, tz)}</span>
        </div>
        {sku && (
          <div className="row">
            <span><span className="price-old">{money(sku.regularMinor, c.currency)}</span><span className="price-new" style={{ fontSize: 22 }}>{money(sku.offerMinor, c.currency)}</span> {sku.productTitle}</span>
            {c.status === 'OPEN' && <Link className="btn primary" href={`/products/${sku.productId}?campaign=${c.id}`}>Buy & enter</Link>}
          </div>
        )}
      </section>

      <div className="split">
        <div className="stack">
          <section className="card stack" aria-labelledby="your-entry">
            <h2 id="your-entry" style={{ margin: 0 }}>Your entry</h2>
            {!actor ? <p><Link href={`/login?next=/campaigns/${id}`}>Sign in</Link> to see your eligibility and upload your video.</p> : (
              <EntryPanel campaignId={id} status={c.status} viewer={viewer!} rules={{ alternativeEntry: c.rules.eligibility.alternativeEntry, instructions: c.rules.eligibility.alternativeEntryInstructions, milestone: c.rules.eligibility.entitlementMilestone }} />
            )}
          </section>
          <section aria-labelledby="lb">
            <h2 id="lb">Leaderboard</h2>
            <Leaderboard campaignId={id} initial={board} />
          </section>
          <section>
            <h2>Entries</h2>
            <FeedList initial={feed.items} nextCursor={feed.nextCursor} signedIn={!!actor} campaignId={id} />
          </section>
        </div>
        <aside className="stack">
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Prizes</h2>
            <ul style={{ paddingInlineStart: 18 }}>
              {c.prizeTiers.map((t) => (
                <li key={t.id}><strong>{t.rankFrom === t.rankTo ? `#${t.rankFrom}` : t.rankTo ? `#${t.rankFrom}–${t.rankTo}` : `#${t.rankFrom}+ (all remaining eligible)`}</strong>: {t.title}{t.type === 'PRIZE' ? ` (value ${money(t.valueMinor, c.currency)})` : ''}</li>
              ))}
            </ul>
            <p className="small muted">No fee to claim prizes. Coupons: {c.rules.coupon.exclusionsText} Valid {c.rules.coupon.validityDays} days, max discount {money(c.rules.coupon.maxDiscountMinor, c.currency)}.</p>
          </section>
          <section className="card">
            <h2 style={{ marginTop: 0 }}>How ranking works</h2>
            <p className="small">{c.rules.disclosures.skillCriteria}</p>
            {Object.entries(c.rules.scoring.weights).map(([k, w]) => (
              <div key={k} className="small" style={{ marginBottom: 6 }}><div className="row" style={{ justifyContent: 'space-between' }}><span>{WEIGHT_LABELS[k] ?? k}</span><strong>{w}%</strong></div><div className="bar" aria-hidden><span style={{ width: `${w}%` }} /></div></div>
            ))}
            <p className="small muted">Rate metrics use Bayesian smoothing against published reference rates (capped at 100). Ties: higher creativity, then qualified shares, then earlier approval. Self-votes, bot bursts and paid exposure never count.</p>
          </section>
          <section className="card small">
            <h2 style={{ marginTop: 0 }}>Rules & eligibility</h2>
            <ul style={{ paddingInlineStart: 18 }}>
              <li>Open to residents of {c.rules.eligibility.countries.join(', ')} aged {c.rules.eligibility.minAge}+.</li>
              <li>Entry unlocked when your order is {c.rules.eligibility.entitlementMilestone.toLowerCase()}; max {c.rules.eligibility.maxEntriesPerUser} entr{c.rules.eligibility.maxEntriesPerUser > 1 ? 'ies' : 'y'} per person.</li>
              <li>{c.rules.disclosures.noPurchaseNecessary}</li>
              <li>Videos {Math.round(c.rules.entry.minDurationMs / 1000)}–{Math.round(c.rules.entry.maxDurationMs / 1000)}s. Unsafe challenges are prohibited. No reward for positive reviews.</li>
              <li>Minimum {c.rules.minEntries} entries.</li>
              <li>{c.rules.disclosures.sponsor}</li>
            </ul>
            <p className="muted">Rules version {c.rulesVersion}{c.rulesHash ? ` · hash ${c.rulesHash.slice(0, 12)}…` : ''}. Published rules are immutable; amendments require platform approval.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
