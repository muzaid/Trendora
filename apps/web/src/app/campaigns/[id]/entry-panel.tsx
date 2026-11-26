'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiForm, ErrorBox, type ApiError } from '@/components/client';

interface Viewer { eligible: boolean; ineligibleReason: string | null; alternativeEntryStatus: string | null; entitlements: { id: string; source: string; status: string; entryId: string | null; entryStatus: string | null }[] }

export function EntryPanel({ campaignId, status, viewer, rules }: { campaignId: string; status: string; viewer: Viewer; rules: { alternativeEntry: boolean; instructions: string; milestone: string } }) {
  if (!viewer.eligible) return <div className="alert warn">{viewer.ineligibleReason}</div>;
  if (viewer.entitlements.length === 0) {
    return (
      <div className="stack">
        <p>Buy the challenge bundle to unlock an entry. Your entry becomes available once the order is <strong>{rules.milestone.toLowerCase()}</strong>.</p>
        {rules.alternativeEntry && status === 'OPEN' && (
          viewer.alternativeEntryStatus ? <p className="small">Free alternative entry request: <span className="badge warn">{viewer.alternativeEntryStatus}</span></p> : (
            <details>
              <summary>No purchase necessary — request a free entry</summary>
              <p className="small muted">{rules.instructions}</p>
              <ApiForm path={`/v1/campaigns/${campaignId}/alternative-entry`} submitLabel="Request free entry" fields={[{ name: 'statement', label: 'How would you demonstrate the product?', type: 'textarea', required: true }]} successText="Request received. A moderator will review it." />
            </details>
          )
        )}
      </div>
    );
  }
  return <div className="stack">{viewer.entitlements.map((e) => <EntitlementRow key={e.id} ent={e} open={status === 'OPEN'} />)}</div>;
}

function EntitlementRow({ ent, open }: { ent: Viewer['entitlements'][number]; open: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [consent, setConsent] = useState(false);

  async function upload(entryId: string, uploadUrl: string, file: File) {
    setBusy('Uploading…');
    const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'video/mp4' } });
    if (!res.ok) throw ((await res.json()).error as ApiError);
    setBusy('Processing video…');
    for (let i = 0; i < 30; i++) {
      const mine = await api<{ id: string; videoStatus: string; videoFailure: string | null }[]>('/v1/me/entries');
      const e = mine.find((x) => x.id === entryId);
      if (e?.videoStatus === 'READY' || e?.videoStatus === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!ent.entryId) {
    if (!open) return <p className="muted">Submissions are closed.</p>;
    return (
      <form className="stack" onSubmit={async (ev) => {
        ev.preventDefault();
        const file = (ev.currentTarget.elements.namedItem('video') as HTMLInputElement).files?.[0];
        if (!file) return;
        setError(null);
        try {
          setBusy('Creating entry…');
          const r = await api<{ entryId: string; uploadUrl: string }>('/v1/entries', { body: { entitlementId: ent.id, caption, commercialReuseConsent: consent, contentType: file.type } });
          await upload(r.entryId, r.uploadUrl, file);
          router.refresh();
        } catch (e) { setError(e as ApiError); } finally { setBusy(null); }
      }}>
        <p className="small"><span className="badge ok">Entry unlocked</span> via {ent.source === 'PURCHASE' ? 'your purchase' : 'free alternative entry'}.</p>
        <label>Caption<input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} /></label>
        <label>Video file (MP4/WebM/MOV)<input name="video" type="file" accept="video/mp4,video/webm,video/quicktime" required data-testid="video-input" /></label>
        <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I allow the merchant to reuse my video commercially (optional, separate from entering)</label>
        <ErrorBox error={error} />
        <button className="btn primary" disabled={!!busy}>{busy ?? 'Upload entry'}</button>
      </form>
    );
  }
  return (
    <div className="stack">
      <p>Entry status: <span className="badge">{ent.entryStatus}</span></p>
      {ent.entryStatus === 'PROCESSING' && (
        <div className="row">
          <button className="btn primary" disabled={!!busy} data-testid="submit-entry" onClick={async () => {
            setError(null);
            try { setBusy('Submitting…'); await api(`/v1/entries/${ent.entryId}/submit`, { body: {} }); router.refresh(); } catch (e) { setError(e as ApiError); } finally { setBusy(null); }
          }}>{busy ?? 'Submit for review'}</button>
          <span className="small muted">Submit once processing finishes. You can edit your caption until the submission deadline.</span>
        </div>
      )}
      {ent.entryStatus === 'DRAFT' && open && (
        <form className="stack" onSubmit={async (ev) => {
          ev.preventDefault();
          const file = (ev.currentTarget.elements.namedItem('video') as HTMLInputElement).files?.[0];
          if (!file) return;
          try { const r = await api<{ uploadUrl: string }>(`/v1/entries/${ent.entryId}/upload-url`, { body: {} }); await upload(ent.entryId!, r.uploadUrl, file); router.refresh(); } catch (e) { setError(e as ApiError); } finally { setBusy(null); }
        }}>
          <p className="small">Your last upload could not be processed. Please upload a different file.</p>
          <input name="video" type="file" accept="video/mp4,video/webm,video/quicktime" required />
          <button className="btn primary" disabled={!!busy}>{busy ?? 'Re-upload'}</button>
        </form>
      )}
      {ent.entryStatus === 'REVIEW' && <p className="small muted">A moderator is reviewing your video.</p>}
      {(ent.entryStatus === 'REJECTED' || ent.entryStatus === 'APPROVED') && (
        <details>
          <summary>File an appeal</summary>
          <ApiForm path="/v1/appeals" extra={{ entryId: ent.entryId }} submitLabel="Submit appeal" fields={[{ name: 'reason', label: 'What should be reconsidered?', type: 'textarea', required: true }]} successText="Appeal filed." />
        </details>
      )}
      {['DRAFT', 'PROCESSING', 'REVIEW', 'APPROVED'].includes(ent.entryStatus ?? '') && open && (
        <button className="btn danger sm" onClick={async () => {
          if (!window.confirm('Withdraw this entry? This cannot be undone.')) return;
          try { await api(`/v1/entries/${ent.entryId}/withdraw`, { body: {} }); router.refresh(); } catch (e) { setError(e as ApiError); }
        }}>Withdraw entry</button>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
