import { services } from '@/server/runtime';
import { SandboxLogin } from './sandbox-login';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const s = services();
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Sign in</h1>
      {s.config.SANDBOX_MODE ? (
        <>
          <p className="muted">Sandbox sign-in: choose a seeded account. Each role sees different tools (consumer, merchant console, moderation, finance, administration). Production uses Supabase Auth with MFA for privileged roles.</p>
          <SandboxLogin next={next && next.startsWith('/') ? next : '/'} />
        </>
      ) : (
        <div className="alert">Sign in with your TRENDORA account via Supabase Auth, then send the access token as a Bearer token. Privileged roles require MFA.</div>
      )}
    </div>
  );
}
