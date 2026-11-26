'use client';
import { useState } from 'react';
import { api } from './client';
import { VideoCard, type CardItem } from './video-card';

export function FeedList({ initial, nextCursor, signedIn, campaignId }: { initial: CardItem[]; nextCursor: string | null; signedIn: boolean; campaignId?: string }) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(nextCursor);
  const [busy, setBusy] = useState(false);
  return (
    <div className="feed" aria-live="polite">
      {items.length === 0 && <p className="muted">No approved videos yet.</p>}
      {items.map((it) => <VideoCard key={it.entryId} item={it} signedIn={signedIn} />)}
      {cursor && (
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true);
          const qs = new URLSearchParams({ cursor, limit: '5', ...(campaignId ? { campaignId } : {}) });
          const r = await api<{ items: CardItem[]; nextCursor: string | null }>(`/v1/feed?${qs}`);
          setItems((x) => [...x, ...r.items]);
          setCursor(r.nextCursor);
          setBusy(false);
        }}>{busy ? 'Loading…' : 'Load more'}</button>
      )}
    </div>
  );
}
