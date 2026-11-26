import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

/** Typed client for the TRENDORA /v1 API (bearer token auth; never stores secrets in the bundle). */
const BASE: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:3000';
const TOKEN_KEY = 'trendora.token';

export interface ApiError { code: string; message: string; requestId: string }

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}
export async function setToken(token: string | null) {
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-device-id': 'expo' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw json.error as ApiError;
  return json as T;
}

export interface FeedItem {
  entryId: string; campaignId: string; campaignTitle: string; storeName: string; creatorHandle: string; caption: string;
  playbackUrl: string | null; likeCount: number; likedByMe: boolean; sponsorDisclosure: string;
  productTags: { productId: string; title: string; offerMinor: number; regularMinor: number; currency: string }[];
}
export interface LeaderboardRow { rank: number; entryId: string; creatorHandle: string; score: number }
export interface Reward { id: string; campaignTitle: string; rank: number; type: 'PRIZE' | 'COUPON'; title: string; status: string; coupon: { code: string; percentOff: number; expiresAt: string; status: string } | null }
