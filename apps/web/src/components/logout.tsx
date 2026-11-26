'use client';
import { useRouter } from 'next/navigation';
import { api } from './client';

export function LogoutButton() {
  const router = useRouter();
  return (
    <button className="btn sm" onClick={async () => { await api('/v1/auth/logout', { body: {} }); router.push('/'); router.refresh(); }}>
      Sign out
    </button>
  );
}
