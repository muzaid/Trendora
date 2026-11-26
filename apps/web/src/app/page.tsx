import Link from 'next/link';
import { engagement } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { FeedList } from '@/components/feed-list';

export const dynamic = 'force-dynamic';

export default async function FeedPage() {
  const actor = await currentActor();
  const page = await engagement.feed(services(), actor, undefined, 5);
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="hero">
        <h1>Shop. Create. Compete. Win.</h1>
        <p className="muted" style={{ maxWidth: 680 }}>Discover products through creator demos. Buy at the challenge price, post your own video, and climb a transparent, skill-judged leaderboard — top ranks win prizes and every eligible entry earns a store coupon.</p>
        <div className="row"><Link className="btn primary" href="/stores/glowlab">Browse GlowLab</Link>{!actor && <Link className="btn" href="/login">Sign in to vote</Link>}</div>
      </section>
      <FeedList initial={page.items} nextCursor={page.nextCursor} signedIn={!!actor} />
    </div>
  );
}
