import { NextResponse } from 'next/server';
import { matchRoute } from '@/server/routes';
import { runRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function dispatch(req: Request) {
  const { pathname } = new URL(req.url);
  const m = matchRoute(req.method, pathname);
  if (!m) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: '-' } }, { status: 404 });
  if ('allowed' in m) return NextResponse.json({ error: { code: 'INVALID_INPUT', message: 'Method not allowed', requestId: '-' } }, { status: 405, headers: { allow: m.allowed.join(', ') } });
  return runRoute(req, m.params, m.route.handler, { csrf: m.route.csrf });
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
