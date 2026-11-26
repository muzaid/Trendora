'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ErrorBox, type ApiError } from '@/components/client';

/** Records a qualified share visit (distinct recipient) then opens the entry. */
export function ShareLanding({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    api<{ entryId: string }>('/v1/share-visits', { body: { token } })
      .then((r) => router.replace(`/entries/${r.entryId}`))
      .catch(setError);
  }, [token, router]);
  return <div className="stack"><p className="muted">Opening shared video…</p><ErrorBox error={error} /></div>;
}
