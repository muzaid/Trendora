'use client';
import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LeaderboardDto } from '@trendora/contracts';
import { api } from './client';

const KEYS = ['likes', 'shares', 'creativity', 'completion', 'comments', 'growth'] as const;

export function Leaderboard({ campaignId, initial }: { campaignId: string; initial: LeaderboardDto }) {
  const [board, setBoard] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (board.status === 'FINAL') return;
    const t = setInterval(() => void api<LeaderboardDto>(`/v1/campaigns/${campaignId}/leaderboard?limit=50`).then(setBoard).catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [campaignId, board.status]);
  if (board.status === 'NONE') return <p className="muted">The leaderboard appears once entries are approved.</p>;
  return (
    <div className="card">
      <p className="small muted" role="status">
        {board.status === 'FINAL' ? 'Final results' : 'Provisional — refreshed every minute; subject to fraud review and appeals'} · cutoff {board.cutoff ? new Date(board.cutoff).toLocaleString() : '—'}
      </p>
      <div className="table-wrap">
        <table data-testid="leaderboard">
          <thead><tr><th scope="col">Rank</th><th scope="col">Creator</th><th scope="col">TrendScore</th><th scope="col"><span className="visually-hidden">Breakdown</span></th></tr></thead>
          <tbody>
            {board.rows.map((r) => (
              <Fragment key={r.entryId}>
                <tr>
                  <td><strong>#{r.rank}</strong></td>
                  <td><Link href={`/entries/${r.entryId}`}>@{r.creatorHandle}</Link></td>
                  <td>{r.score.toFixed(2)}</td>
                  <td><button className="btn sm" aria-expanded={open === r.entryId} onClick={() => setOpen(open === r.entryId ? null : r.entryId)}>Breakdown</button></td>
                </tr>
                {open === r.entryId && (
                  <tr><td colSpan={4}>
                    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                      {KEYS.map((k) => <div key={k} className="small"><div className="row" style={{ justifyContent: 'space-between' }}><span>{k}</span><span>{Number(r.components[k] ?? 0).toFixed(1)}</span></div><div className="bar"><span style={{ width: `${Math.min(100, Number(r.components[k] ?? 0))}%` }} /></div></div>)}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
