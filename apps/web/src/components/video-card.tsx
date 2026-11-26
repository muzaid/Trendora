'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, type ApiError } from './client';

export interface CardItem {
  entryId: string; campaignId: string; campaignTitle: string; storeSlug: string; storeName: string; creatorHandle: string; caption: string;
  playbackUrl: string | null; likeCount: number; likedByMe: boolean; sponsorDisclosure: string; exploration?: boolean;
  productTags: { productId: string; title: string; offerMinor: number; regularMinor: number; currency: string }[];
}

const fmt = (m: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(m / 100);

/**
 * Vertical video card. Never autoplays audio: videos start paused and muted;
 * impressions are reported once ≥50% visible; completion on `ended`.
 */
export function VideoCard({ item, signedIn }: { item: CardItem; signedIn: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const reported = useRef(false);
  const [liked, setLiked] = useState(item.likedByMe);
  const [likes, setLikes] = useState(item.likeCount);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.intersectionRatio >= 0.5) && !reported.current) {
        reported.current = true;
        void api(`/v1/entries/${item.entryId}/events`, { body: { type: 'IMPRESSION', source: item.exploration ? 'EXPLORATION' : 'ORGANIC' } }).catch(() => undefined);
      }
    }, { threshold: [0.5] });
    io.observe(el);
    return () => io.disconnect();
  }, [item.entryId, item.exploration]);

  const fail = (e: unknown) => setMsg((e as ApiError).message ?? 'Something went wrong');

  return (
    <article className="video-card" ref={ref} aria-label={`Entry by @${item.creatorHandle} in ${item.campaignTitle}`} data-testid="video-card">
      <div className="video-wrap">
        {item.playbackUrl ? (
          <video src={item.playbackUrl} controls muted playsInline preload="metadata" aria-label={item.caption || 'Creator video'}
            onEnded={(e) => void api(`/v1/entries/${item.entryId}/events`, { body: { type: 'VIEW_COMPLETE', source: 'ORGANIC', watchedMs: Math.round((e.currentTarget.duration || 0) * 1000) } }).catch(() => undefined)}>
          </video>
        ) : <div className="muted" style={{ padding: 24 }}>Video processing…</div>}
        <span className="disclosure badge sandbox" title={item.sponsorDisclosure}>Sponsored · {item.storeName}</span>
      </div>
      <div style={{ padding: '12px 12px 0' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>@{item.creatorHandle}</strong>
          {item.exploration && <span className="badge violet" title="New entries get fair exploration exposure">New</span>}
        </div>
        <p style={{ margin: '6px 0' }}>{item.caption}</p>
        <Link href={`/campaigns/${item.campaignId}`} className="small">{item.campaignTitle} →</Link>
        {item.productTags.map((t) => (
          <div key={t.productId} className="small" style={{ marginTop: 6 }}>
            🏷️ <Link href={`/products/${t.productId}?campaign=${item.campaignId}`}>{t.title}</Link>{' '}
            <span className="price-old">{fmt(t.regularMinor, t.currency)}</span><span className="price-new">{fmt(t.offerMinor, t.currency)}</span>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="btn sm" aria-pressed={liked} data-testid="like-button" onClick={async () => {
          if (!signedIn) return setMsg('Sign in to vote');
          try { const r = await api<{ active: boolean; changed: boolean }>(`/v1/entries/${item.entryId}/like`, { method: 'PUT', body: { active: !liked } }); if (r.changed) setLikes((n) => n + (r.active ? 1 : -1)); setLiked(r.active); } catch (e) { fail(e); }
        }}>{liked ? '♥' : '♡'} <span>{likes}</span><span className="visually-hidden"> likes</span></button>
        <button className="btn sm" onClick={async () => {
          if (!signedIn) return setMsg('Sign in to get your share link');
          try { const r = await api<{ url: string }>(`/v1/entries/${item.entryId}/share`, { body: {} }); await navigator.clipboard?.writeText(r.url).catch(() => undefined); setMsg(`Share link copied: ${r.url}`); } catch (e) { fail(e); }
        }}>Share</button>
        <Link className="btn sm" href={`/entries/${item.entryId}`}>Comments</Link>
        <Link className="btn sm primary" href={`/campaigns/${item.campaignId}`}>Join challenge</Link>
        {item.productTags[0] && <Link className="btn sm" href={`/products/${item.productTags[0].productId}?campaign=${item.campaignId}`}>Shop</Link>}
        <button className="btn sm" onClick={async () => {
          if (!signedIn) return setMsg('Sign in to report');
          const reason = window.prompt('Report reason: SPAM, HARASSMENT, UNSAFE_CHALLENGE, COPYRIGHT, MISLEADING, UNDERAGE or OTHER', 'OTHER');
          if (!reason) return;
          try { await api('/v1/reports', { body: { targetType: 'ENTRY', targetId: item.entryId, reason: reason.toUpperCase(), details: '' } }); setMsg('Thanks — our moderators will review this.'); } catch (e) { fail(e); }
        }}>Report</button>
      </div>
      {msg && <p className="small" role="status" style={{ padding: '0 12px 12px', margin: 0, wordBreak: 'break-all' }}>{msg}</p>}
    </article>
  );
}
