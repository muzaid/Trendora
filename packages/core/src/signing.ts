import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Stripe-style webhook signature: header `t=<unix>,v1=<hex hmac of "t.rawBody">`.
 * Rejects stale timestamps to prevent replay.
 */
export function signWebhook(secret: string, rawBody: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${rawBody}`)}`;
}

export function verifyWebhook(secret: string, rawBody: string, header: string | null, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  return safeEqualHex(hmacHex(secret, `${t}.${rawBody}`), parts.v1);
}

/** Signed, expiring opaque tokens: payload.b64 + "." + hmac. Used for upload URLs and share links. */
export function signToken(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacHex(secret, body).slice(0, 48)}`;
}

export function verifyToken<T extends Record<string, unknown>>(secret: string, token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqualHex(hmacHex(secret, body).slice(0, 48), sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Stable canonical JSON (sorted keys) for hashing published rules. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
