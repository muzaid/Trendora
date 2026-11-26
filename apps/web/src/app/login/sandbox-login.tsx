'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, type ApiError } from '@/components/client';

interface U { handle: string; name: string; roles: string[] }
const groups: { title: string; test: (u: U) => boolean }[] = [
  { title: 'Shoppers & creators', test: (u) => u.handle.startsWith('creator_') || u.handle === 'buyer_bea' },
  { title: 'Viewers / voters', test: (u) => u.handle.startsWith('viewer_') },
  { title: 'Merchant (GlowLab)', test: (u) => u.handle.startsWith('glow_') },
  { title: 'Platform staff', test: (u) => u.roles.length > 0 },
];

export function SandboxLogin({ next }: { next: string }) {
  const router = useRouter();
  const [users, setUsers] = useState<U[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { api<U[]>('/v1/auth/sandbox-users').then(setUsers).catch(setError); }, []);
  return (
    <div className="stack">
      <ErrorBox error={error} />
      {groups.map((g) => (
        <section key={g.title} className="card">
          <h2 style={{ marginTop: 0 }}>{g.title}</h2>
          <div className="row">
            {users.filter(g.test).map((u) => (
              <button key={u.handle} className="btn" data-testid={`login-${u.handle}`} onClick={async () => {
                try {
                  await api('/v1/auth/sandbox-login', { body: { handle: u.handle } });
                  router.push(next);
                  router.refresh();
                } catch (e) { setError(e as ApiError); }
              }}>
                {u.name} <span className="muted small">@{u.handle}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
