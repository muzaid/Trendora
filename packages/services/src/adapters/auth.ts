import { SignJWT, jwtVerify } from 'jose';

/**
 * Session tokens. TRENDORA verifies two token kinds with the same code path:
 *  - its own HS256 tokens (sandbox login, tests, mobile dev builds);
 *  - Supabase Auth access tokens (HS256 project JWT secret), when configured.
 * `aal` carries the MFA assurance level used to gate privileged routes.
 */
export interface TokenClaims {
  sub: string;
  aal: 'aal1' | 'aal2';
}

const enc = (s: string) => new TextEncoder().encode(s);

export async function issueToken(secret: string, issuer: string, claims: TokenClaims, ttlSeconds = 60 * 60 * 12): Promise<string> {
  return new SignJWT({ aal: claims.aal, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc(secret));
}

export async function verifyToken(token: string, cfg: { secret: string; issuer: string; supabaseSecret?: string; supabaseUrl?: string }): Promise<TokenClaims | null> {
  const attempts: { secret: string; issuer?: string }[] = [{ secret: cfg.secret, issuer: cfg.issuer }];
  if (cfg.supabaseSecret) attempts.push({ secret: cfg.supabaseSecret, ...(cfg.supabaseUrl ? { issuer: `${cfg.supabaseUrl}/auth/v1` } : {}) });
  for (const a of attempts) {
    try {
      const { payload } = await jwtVerify(token, enc(a.secret), { algorithms: ['HS256'], audience: 'authenticated', ...(a.issuer ? { issuer: a.issuer } : {}) });
      if (typeof payload.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sub)) return null;
      return { sub: payload.sub, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1' };
    } catch {
      // try next verifier
    }
  }
  return null;
}
