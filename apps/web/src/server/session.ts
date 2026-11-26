import 'server-only';
import { cookies, headers } from 'next/headers';
import { identity, type Actor } from '@trendora/services';
import { services, freshClock } from './runtime';

export const SESSION_COOKIE = 'trendora_session';

/** Actor for server components (cookie session). */
export async function currentActor(): Promise<Actor | null> {
  await freshClock();
  const jar = await cookies();
  const h = await headers();
  const bearer = h.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  return identity.actorFromToken(services(), bearer ?? jar.get(SESSION_COOKIE)?.value ?? null);
}
