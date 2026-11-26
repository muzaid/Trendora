import { notFound } from 'next/navigation';
import { engagement } from '@trendora/services';
import { isAppError } from '@trendora/contracts';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { VideoCard } from '@/components/video-card';
import { ApiForm, ActionButton } from '@/components/client';
import { when } from '@/lib/format';

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  const entry = await engagement.entryDetail(services(), actor, id).catch((e) => { if (isAppError(e)) notFound(); throw e; });
  const comments = entry.comments as { id: string; body: string; createdAt: string; authorHandle: string }[];
  return (
    <div className="split">
      <VideoCard item={entry} signedIn={!!actor} />
      <section className="stack" aria-label="Comments">
        <h2 style={{ marginTop: 0 }}>Comments</h2>
        {actor && <ApiForm path={`/v1/entries/${id}/comments`} submitLabel="Comment" fields={[{ name: 'body', label: 'Add a comment', type: 'textarea', required: true }]} />}
        {actor && <ActionButton path={`/v1/entries/${id}/follow`} className="btn sm">Follow @{entry.creatorHandle}</ActionButton>}
        {comments.length === 0 && <p className="muted">No comments yet.</p>}
        {comments.map((c) => <div key={c.id} className="card"><strong>@{c.authorHandle}</strong> <span className="small muted">{when(c.createdAt)}</span><p style={{ margin: '4px 0 0' }}>{c.body}</p></div>)}
      </section>
    </div>
  );
}
