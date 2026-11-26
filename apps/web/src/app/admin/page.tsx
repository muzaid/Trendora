import Link from 'next/link';
import { redirect } from 'next/navigation';
import { platformCan } from '@trendora/core';
import { entries, ranking, trust, payments, getSetting } from '@trendora/services';
import { services } from '@/server/runtime';
import { currentActor } from '@/server/session';
import { when, statusTone } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';

const TABS = [
  { key: 'campaigns', label: 'Campaigns', perm: 'moderation' },
  { key: 'moderation', label: 'Moderation', perm: 'moderation' },
  { key: 'rubric', label: 'Creativity rubric', perm: 'moderation' },
  { key: 'trust', label: 'Reports, appeals & flags', perm: 'moderation' },
  { key: 'merchants', label: 'Merchants', perm: 'admin' },
  { key: 'finance', label: 'Finance', perm: 'finance' },
  { key: 'platform', label: 'Platform', perm: 'admin' },
] as const;

type Row = Record<string, unknown>;

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?next=/admin');
  if (!actor.platformRoles.length) redirect('/');
  const s = services();
  const allowed = TABS.filter((t) => platformCan(actor.platformRoles, t.perm));
  const { tab: raw } = await searchParams;
  const tab = allowed.find((t) => t.key === raw)?.key ?? allowed[0]!.key;
  return (
    <div className="stack">
      <h1>Platform operations</h1>
      <p className="small muted">Roles: {actor.platformRoles.join(', ')}. Every decision is recorded in the immutable audit log. AI may flag but never decides winners.</p>
      <nav className="tabs" aria-label="Admin sections">{allowed.map((t) => <Link key={t.key} href={`/admin?tab=${t.key}`} aria-current={tab === t.key ? 'page' : undefined}>{t.label}</Link>)}</nav>
      {tab === 'campaigns' && <CampaignsTab actor={actor} />}
      {tab === 'moderation' && <Moderation rows={await entries.moderationQueue(s, actor)} alt={(await trust.pendingAlternativeEntries(s, actor)) as Row[]} />}
      {tab === 'rubric' && <Rubric rows={await ranking.rubricQueue(s, actor)} />}
      {tab === 'trust' && <Trust reports={(await trust.listReports(s, actor)) as Row[]} appeals={(await trust.listAppeals(s, actor)) as Row[]} flags={(await trust.listFlags(s, actor)) as Row[]} />}
      {tab === 'merchants' && <Merchants rows={(await trust.pendingOrganizations(s, actor)) as Row[]} />}
      {tab === 'finance' && <Finance recon={await payments.reconcile(s, actor)} campaigns={(await trust.fundingQueue(s, actor)) as Row[]} />}
      {tab === 'platform' && <Platform audit={await trust.auditLog(s, actor)} kill={(await getSetting<{ commerceFrozen: boolean; payoutsFrozen: boolean }>(s.db, 'kill_switch')) ?? { commerceFrozen: false, payoutsFrozen: false }} sandbox={s.config.SANDBOX_MODE} offsetMs={s.dbClock?.offset ?? 0} now={s.clock.now().toISOString()} />}
    </div>
  );
}

async function CampaignsTab({ actor }: { actor: NonNullable<Awaited<ReturnType<typeof currentActor>>> }) {
  const s = services();
  const rows = (await trust.campaignAdminQueue(s, actor)) as Row[];
  const readiness = await Promise.all(rows.filter((c) => c.status === 'REVIEWING').map(async (c) => ({ id: String(c.id), ...(await ranking.finalizationReadiness(s, actor, String(c.id))) })));
  return <Campaigns rows={rows} readiness={readiness} actorIsAdmin={actor.platformRoles.includes('ADMIN')} />;
}

function Campaigns({ rows, readiness, actorIsAdmin }: { rows: Row[]; readiness: { id: string; snapshot: { id: string; version: number; cutoff: string | null } | null; blockers: string[]; ready: boolean }[]; actorIsAdmin: boolean }) {
  return (
    <div className="stack">
      {rows.map((c) => {
        const id = String(c.id);
        const r = readiness.find((x) => x.id === id);
        return (
          <article key={id} className="card stack" data-testid={`admin-campaign-${id}`}>
            <div className="row"><strong>{String(c.title)}</strong><span className={`badge ${statusTone(String(c.status))}`}>{String(c.status)}</span><span className="small muted">{String(c.storeName)} · org {String(c.orgVerification)} · funding {String(c.fundingStatus)} · {String(c.approvedEntries)} approved entries{c.frozen ? ' · FROZEN' : ''}</span>
              <Link className="small" href={`/campaigns/${id}`}>Arena</Link></div>
            <div className="row">
              {c.status === 'REVIEW' && actorIsAdmin && <>
                <ActionButton className="btn primary sm" path={`/v1/admin/campaigns/${id}/review`} body={{ decision: 'APPROVE', notes: 'Rules, disclosures, eligibility and funding verified' }}>Approve & publish</ActionButton>
                <ActionButton className="btn sm" path={`/v1/admin/campaigns/${id}/review`} body={{ decision: 'REJECT', notes: 'Changes requested — see rules and disclosures' }}>Return to draft</ActionButton>
              </>}
              {c.status === 'VOTING_CLOSED' && <ActionButton className="btn primary sm" path={`/v1/admin/campaigns/${id}/start-review`}>Start results review (cutoff snapshot)</ActionButton>}
              {['OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED', 'REVIEWING'].includes(String(c.status)) && <ActionButton className="btn sm" path={`/v1/admin/campaigns/${id}/snapshots`}>Recompute snapshot</ActionButton>}
              {actorIsAdmin && !['FINALIZED', 'FULFILLED', 'CANCELED', 'DRAFT'].includes(String(c.status)) && <ActionButton className="btn sm danger" path={`/v1/admin/campaigns/${id}/freeze`} body={{ frozen: !c.frozen, reason: 'Incident response: preserve evidence' }} confirm={c.frozen ? 'Unfreeze this campaign?' : 'Freeze all purchases, votes and submissions for this campaign?'}>{c.frozen ? 'Unfreeze' : 'Freeze (kill switch)'}</ActionButton>}
            </div>
            {r && (
              <div className="stack">
                <p className="small">Snapshot {r.snapshot ? `v${r.snapshot.version} (cutoff ${when(r.snapshot.cutoff)})` : 'none'} · {r.ready ? <span className="badge ok">Ready to finalize</span> : <span className="badge warn">Blocked</span>}</p>
                {r.blockers.length > 0 && <ul className="small">{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
                {r.ready && r.snapshot && actorIsAdmin && <ActionButton className="btn primary" idempotent path={`/v1/admin/campaigns/${id}/finalize`} body={{ expectedSnapshotId: r.snapshot.id, reason: 'Provisional results reviewed; appeals resolved; fraud review complete' }} confirm="Finalize results and issue rewards? This happens once and cannot be undone.">Finalize & issue rewards</ActionButton>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Moderation({ rows, alt }: { rows: Awaited<ReturnType<typeof entries.moderationQueue>>; alt: Row[] }) {
  return (
    <div className="stack">
      {rows.length === 0 && <p className="muted">Moderation queue is empty.</p>}
      <div className="grid">
        {rows.map((e) => (
          <article key={e.entryId} className="card stack" data-testid="moderation-item">
            {e.playbackUrl && <video src={e.playbackUrl} controls muted playsInline preload="metadata" style={{ width: '100%', maxHeight: 360, background: '#000' }} aria-label={`Entry by @${e.creatorHandle}`} />}
            <strong>@{e.creatorHandle}</strong><span className="small muted">{e.campaignTitle} · {((e.durationMs ?? 0) / 1000).toFixed(1)}s · reuse consent {e.commercialReuseConsent ? 'yes' : 'no'}</span>
            <p className="small">{e.caption}</p>
            {e.openFlags > 0 && <span className="badge bad">{e.openFlags} open fraud flag(s)</span>}
            <div className="row">
              <ActionButton className="btn primary sm" path={`/v1/admin/entries/${e.entryId}/moderate`} body={{ decision: 'APPROVED', reason: 'Meets rubric and safety policy' }}>Approve</ActionButton>
              <ActionButton className="btn sm danger" path={`/v1/admin/entries/${e.entryId}/moderate`} body={{ decision: 'REJECTED', reason: 'Violates content policy' }}>Reject</ActionButton>
            </div>
          </article>
        ))}
      </div>
      <h2>Free alternative entry requests</h2>
      {alt.length === 0 && <p className="muted">None pending.</p>}
      {alt.map((r) => (
        <div key={String(r.id)} className="card row"><span><strong>@{String(r.handle)}</strong> · {String(r.campaignTitle)}: {String(r.statement)}</span>
          <ActionButton className="btn sm primary" path={`/v1/admin/alternative-entries/${String(r.id)}/decision`} body={{ decision: 'APPROVED' }}>Approve</ActionButton>
          <ActionButton className="btn sm" path={`/v1/admin/alternative-entries/${String(r.id)}/decision`} body={{ decision: 'REJECTED' }}>Reject</ActionButton></div>
      ))}
    </div>
  );
}

function Rubric({ rows }: { rows: Awaited<ReturnType<typeof ranking.rubricQueue>> }) {
  return (
    <div className="stack">
      <p className="small muted">Two independent scores per entry (originality, product integration, execution, 0–100). If they differ by more than the published threshold, a third reviewer adjudicates.</p>
      {rows.length === 0 && <p className="muted">No entries need your score.</p>}
      <div className="grid">
        {rows.map((r) => (
          <article key={r.entryId} className="card stack">
            {r.playbackUrl && <video src={r.playbackUrl} controls muted playsInline preload="metadata" style={{ width: '100%', maxHeight: 300, background: '#000' }} aria-label={`Entry by @${r.creatorHandle}`} />}
            <strong>@{r.creatorHandle}</strong><span className="small muted">{r.campaignTitle} · {r.independentScores}/2 scores{r.adjudicationNeeded ? ' · adjudication needed' : ''}</span>
            <ApiForm path={`/v1/admin/entries/${r.entryId}/rubric`} submitLabel={r.adjudicationNeeded ? 'Submit adjudication' : 'Submit score'}
              fields={[{ name: 'originality', label: 'Originality', type: 'number', required: true, defaultValue: 70 }, { name: 'productIntegration', label: 'Product integration', type: 'number', required: true, defaultValue: 70 }, { name: 'execution', label: 'Execution', type: 'number', required: true, defaultValue: 70 }, { name: 'notes', label: 'Notes', type: 'textarea' }]} />
          </article>
        ))}
      </div>
    </div>
  );
}

function Trust({ reports, appeals, flags }: { reports: Row[]; appeals: Row[]; flags: Row[] }) {
  return (
    <div className="stack">
      <h2>Fraud & eligibility flags</h2>
      {flags.length === 0 && <p className="muted">No open flags.</p>}
      {flags.map((f) => (
        <div key={String(f.id)} className="card stack">
          <div className="row"><span className="badge warn">{String(f.kind)}</span><span className="small muted">{String(f.source)} · confidence {Number(f.confidence).toFixed(2)} · {String(f.campaignTitle)} {f.actorHandle ? `· @${String(f.actorHandle)}` : ''}</span></div>
          <pre className="json">{JSON.stringify(f.evidence, null, 1)}</pre>
          <div className="row">
            <ActionButton className="btn sm danger" path={`/v1/admin/flags/${String(f.id)}/resolve`} body={{ decision: 'CONFIRMED', reason: 'Reviewed evidence; violation confirmed' }}>Confirm</ActionButton>
            <ActionButton className="btn sm" path={`/v1/admin/flags/${String(f.id)}/resolve`} body={{ decision: 'DISMISSED', reason: 'Reviewed evidence; no violation' }}>Dismiss</ActionButton>
          </div>
        </div>
      ))}
      <h2>Appeals</h2>
      {appeals.length === 0 && <p className="muted">No open appeals.</p>}
      {appeals.map((a) => (
        <div key={String(a.id)} className="card stack"><span><strong>@{String(a.handle)}</strong> · {String(a.campaignTitle)} · entry {String(a.entryStatus)}</span><p className="small">{String(a.reason)}</p>
          <div className="row">
            <ActionButton className="btn sm primary" path={`/v1/admin/appeals/${String(a.id)}/decision`} body={{ decision: 'UPHELD', resolution: 'Appeal upheld after review' }}>Uphold</ActionButton>
            <ActionButton className="btn sm" path={`/v1/admin/appeals/${String(a.id)}/decision`} body={{ decision: 'DENIED', resolution: 'Original decision stands under published rules' }}>Deny</ActionButton>
          </div></div>
      ))}
      <h2>Reports</h2>
      {reports.length === 0 && <p className="muted">No open reports.</p>}
      {reports.map((r) => (
        <div key={String(r.id)} className="card row"><span className="badge">{String(r.reason)}</span><span className="small">{String(r.targetType)} {String(r.targetId).slice(0, 8)} by @{String(r.reporterHandle)} {String(r.details)}</span>
          <ActionButton className="btn sm danger" path={`/v1/admin/reports/${String(r.id)}/decision`} body={{ decision: 'ACTIONED', resolution: 'Content removed under policy' }}>Action</ActionButton>
          <ActionButton className="btn sm" path={`/v1/admin/reports/${String(r.id)}/decision`} body={{ decision: 'DISMISSED', resolution: 'No violation found' }}>Dismiss</ActionButton></div>
      ))}
    </div>
  );
}

function Merchants({ rows }: { rows: Row[] }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Organization</th><th>Legal name</th><th>Country</th><th>Status</th><th>Decision</th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={String(o.id)}><td>{String(o.name)}</td><td>{String(o.legalName ?? '')}</td><td>{String(o.country ?? '')}</td><td><span className={`badge ${statusTone(String(o.verificationStatus))}`}>{String(o.verificationStatus)}</span></td>
          <td className="row">
            <ActionButton className="btn sm primary" path={`/v1/admin/organizations/${String(o.id)}/decision`} body={{ decision: 'VERIFIED', notes: 'Business documents verified' }}>Verify</ActionButton>
            <ActionButton className="btn sm danger" path={`/v1/admin/organizations/${String(o.id)}/decision`} body={{ decision: 'SUSPENDED', notes: 'Suspended pending investigation' }}>Suspend</ActionButton>
          </td></tr>
      ))}</tbody>
    </table></div>
  );
}

function Finance({ recon, campaigns }: { recon: Awaited<ReturnType<typeof payments.reconcile>>; campaigns: Row[] }) {
  const m = (n: number) => `$${(n / 100).toFixed(2)}`;
  return (
    <div className="stack">
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Ledger reconciliation <span className={`badge ${recon.ok ? 'ok' : 'bad'}`}>{recon.ok ? 'BALANCED' : 'MISMATCH'}</span></h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {[['Captured', recon.capturedMinor], ['Refunded', recon.refundedMinor], ['Disputed', recon.disputedMinor], ['Expected clearing', recon.expectedClearingMinor], ['Ledger clearing', recon.ledgerClearingMinor], ['Platform commission', recon.platformCommissionMinor]].map(([k, v]) => <div key={String(k)}><div className="kpi">{m(Number(v))}</div><div className="small muted">{k}</div></div>)}
        </div>
        <p className="small muted">Unbalanced journals: {recon.unbalancedJournals}. Journals are immutable, integer minor units, sum to zero.</p>
      </section>
      <h2>Prize funding awaiting verification</h2>
      {campaigns.length === 0 && <p className="muted">None.</p>}
      {campaigns.map((c) => (
        <div key={String(c.id)} className="card stack"><strong>{String(c.title)}</strong><pre className="json">{JSON.stringify(c.fundingEvidence, null, 1)}</pre>
          <div className="row">
            <ActionButton className="btn sm primary" path={`/v1/admin/campaigns/${String(c.id)}/funding`} body={{ verified: true, reason: 'Escrow/guarantee confirmed with provider' }}>Verify funding</ActionButton>
            <ActionButton className="btn sm danger" path={`/v1/admin/campaigns/${String(c.id)}/funding`} body={{ verified: false, reason: 'Evidence could not be verified' }}>Reject</ActionButton>
          </div></div>
      ))}
    </div>
  );
}

function Platform({ audit, kill, sandbox, offsetMs, now }: { audit: Awaited<ReturnType<typeof trust.auditLog>>; kill: { commerceFrozen: boolean; payoutsFrozen: boolean }; sandbox: boolean; offsetMs: number; now: string }) {
  const days = Math.round(offsetMs / 86_400_000 * 10) / 10;
  return (
    <div className="stack">
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>Kill switches</h2>
        <div className="row">
          <ActionButton className={`btn ${kill.commerceFrozen ? 'primary' : 'danger'}`} path="/v1/admin/kill-switch" body={{ commerceFrozen: !kill.commerceFrozen, reason: 'Incident response (operator)' }} confirm="Toggle platform-wide checkout?">{kill.commerceFrozen ? 'Resume checkout' : 'Freeze all checkout'}</ActionButton>
          <ActionButton className={`btn ${kill.payoutsFrozen ? 'primary' : 'danger'}`} path="/v1/admin/kill-switch" body={{ payoutsFrozen: !kill.payoutsFrozen, reason: 'Incident response (operator)' }} confirm="Toggle reward issuance & fulfilment?">{kill.payoutsFrozen ? 'Resume rewards' : 'Freeze rewards'}</ActionButton>
        </div>
      </section>
      {sandbox && (
        <section className="card stack">
          <h2 style={{ marginTop: 0 }}>Sandbox clock <span className="badge sandbox">SANDBOX</span></h2>
          <p className="small">Server time {when(now)} (offset {days} days). Move time forward to close submissions/voting without editing published rules.</p>
          <div className="row">
            {[0, 5, 12, 15].map((d) => <ActionButton key={d} className="btn sm" path="/v1/admin/sandbox/clock" body={{ offsetMs: d * 86_400_000 }}>{d === 0 ? 'Reset to real time' : `+${d} days`}</ActionButton>)}
          </div>
        </section>
      )}
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Audit log</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
          <tbody>{audit.map((a) => <tr key={a.id}><td className="small">{when(a.at)}</td><td>@{a.actorHandle}</td><td><code>{a.action}</code></td><td className="small">{a.targetType} {a.targetId.slice(0, 8)}</td><td className="small">{a.reason}</td></tr>)}</tbody>
        </table></div>
      </section>
    </div>
  );
}
