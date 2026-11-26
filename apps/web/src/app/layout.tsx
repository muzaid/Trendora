import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { dirFor } from '@trendora/ui';
import { currentActor } from '@/server/session';
import { services } from '@/server/runtime';
import { LogoutButton } from '@/components/logout';
import './globals.css';

export const metadata: Metadata = { title: 'TRENDORA — Shop. Create. Compete. Win.', description: 'Competitive social commerce: buy, create product videos, compete for prizes and rank-based rewards.' };
export const viewport: Viewport = { themeColor: '#101022', width: 'device-width', initialScale: 1 };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor().catch(() => null);
  const sandbox = services().config.SANDBOX_MODE;
  const locale = 'en';
  const isMerchant = !!actor?.memberships.length;
  const isStaff = !!actor?.platformRoles.length;
  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {sandbox && <div className="sandbox-banner" role="note">SANDBOX MODE — payments, video processing and sign-in are simulated. No real money moves.</div>}
        <header className="top">
          <nav aria-label="Primary">
            <Link href="/" className="brand">TREND<span>ORA</span></Link>
            <Link className="navlink" href="/">Feed</Link>
            <Link className="navlink" href="/stores/glowlab">Stores</Link>
            {actor && <Link className="navlink" href="/me">My rewards</Link>}
            {isMerchant && <Link className="navlink" href="/merchant">Merchant</Link>}
            {isStaff && <Link className="navlink" href="/admin">Admin</Link>}
            <span className="spacer" />
            {actor ? (
              <span className="row small"><span className="muted">@{actor.handle}</span><LogoutButton /></span>
            ) : (
              <Link className="btn primary sm" href="/login">Sign in</Link>
            )}
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="muted small" style={{ textAlign: 'center', padding: 24 }}>
          Sponsored challenges are clearly labelled. Prizes are skill-judged under each campaign&apos;s published rules. No purchase necessary where a free entry is offered.
        </footer>
      </body>
    </html>
  );
}
