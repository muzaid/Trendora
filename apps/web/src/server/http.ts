import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, ERROR_STATUS, isAppError, type ApiErrorBody } from '@trendora/contracts';
import { identity, type Actor, type RequestMeta } from '@trendora/services';
import { services, freshClock } from './runtime';
import { SESSION_COOKIE } from './session';

export interface RouteCtx {
  req: Request;
  params: Record<string, string>;
  actor: Actor | null;
  meta: RequestMeta & { visitorId: string };
  url: URL;
  /** Parsed + validated JSON body. */
  body<T extends z.ZodType>(schema: T): Promise<z.infer<T>>;
  query<T extends z.ZodType>(schema: T): z.infer<T>;
  setCookie?: { name: string; value: string; maxAge: number } | null;
  responseHeaders: Headers;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function errorResponse(e: unknown, requestId: string) {
  const s = services();
  let code: ApiErrorBody['error']['code'] = 'INTERNAL';
  let message = 'Something went wrong';
  let details: unknown;
  if (isAppError(e)) {
    code = (e as AppError).code;
    message = (e as AppError).message;
    details = (e as AppError).details;
  } else if (e instanceof z.ZodError || (e as { name?: string })?.name === 'ZodError') {
    code = 'INVALID_INPUT';
    message = 'Request validation failed';
    details = (e as z.ZodError).issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if ((e as { code?: string })?.code === '23505') {
    code = 'CONFLICT';
    message = 'This action conflicts with existing data';
  } else if ((e as { code?: string })?.code === '23514') {
    code = 'CONFLICT';
    message = 'This action violates a business rule';
  } else {
    s.log.error('unhandled error', { requestId, err: (e as Error)?.message, stack: (e as Error)?.stack?.split('\n').slice(0, 4).join(' | ') });
  }
  const body: ApiErrorBody = { error: { code, message, requestId, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status: ERROR_STATUS[code], headers: { 'x-request-id': requestId } });
}

/**
 * Wrap a route: request id, actor resolution (Bearer or session cookie), CSRF
 * origin check for cookie-authenticated mutations, typed errors, structured logs.
 */
export async function runRoute(req: Request, params: Record<string, string>, fn: (c: RouteCtx) => Promise<unknown>, opts: { csrf?: boolean } = {}): Promise<Response> {
  const requestId = req.headers.get('x-request-id')?.slice(0, 64) || randomUUID();
  const started = Date.now();
  const s = services();
  const url = new URL(req.url);
  try {
    await freshClock();
    const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const cookieToken = cookieValue(req, SESSION_COOKIE);
    if (!bearer && cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && opts.csrf !== false) {
      const origin = req.headers.get('origin');
      const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
      if (!origin || new URL(origin).host !== host) throw new AppError('FORBIDDEN', 'Cross-site request blocked');
    }
    const actor = await identity.actorFromToken(s, bearer ?? cookieToken);
    const visitorId = cookieValue(req, 'trendora_vid') ?? randomUUID();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
    let bodyCache: unknown;
    const responseHeaders = new Headers({ 'x-request-id': requestId });
    const ctx: RouteCtx = {
      req, params, actor, url, responseHeaders,
      meta: { requestId, ip, userAgent: req.headers.get('user-agent'), deviceId: req.headers.get('x-device-id') ?? cookieValue(req, 'trendora_vid'), visitorId },
      async body(schema) {
        if (bodyCache === undefined) {
          const text = await req.text();
          if (text.length > 1_000_000) throw new AppError('INVALID_INPUT', 'Request body too large');
          try {
            bodyCache = text ? JSON.parse(text) : {};
          } catch {
            throw new AppError('INVALID_INPUT', 'Body must be JSON');
          }
        }
        return schema.parse(bodyCache);
      },
      query(schema) {
        return schema.parse(Object.fromEntries(url.searchParams));
      },
      setCookie: null,
    };
    const result = await fn(ctx);
    const res = result instanceof Response ? result : NextResponse.json(result ?? { ok: true }, { status: req.method === 'POST' ? 201 : 200 });
    responseHeaders.forEach((v, k) => res.headers.set(k, v));
    if (!cookieValue(req, 'trendora_vid')) res.headers.append('set-cookie', `trendora_vid=${visitorId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    if (ctx.setCookie) {
      const secure = s.config.APP_URL.startsWith('https') ? '; Secure' : '';
      res.headers.append('set-cookie', `${ctx.setCookie.name}=${ctx.setCookie.value}; Path=/; Max-Age=${ctx.setCookie.maxAge}; SameSite=Lax; HttpOnly${secure}`);
    }
    s.log.info('request', { requestId, method: req.method, path: url.pathname, status: res.status, ms: Date.now() - started, actor: actor?.userId ?? null });
    return res;
  } catch (e) {
    const res = errorResponse(e, requestId);
    s.log.info('request', { requestId, method: req.method, path: url.pathname, status: res.status, ms: Date.now() - started });
    return res;
  }
}
