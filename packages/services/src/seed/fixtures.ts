import { createHash } from 'node:crypto';

/** Deterministic UUID from a label so fixtures are stable across runs. */
export function fixtureId(label: string): string {
  const h = createHash('sha256').update(`trendora-fixture:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const SEED_USERS = [
  { handle: 'admin_alex', name: 'Alex (Platform Admin)', roles: ['ADMIN'] as const },
  { handle: 'mod_ava', name: 'Ava (Moderator)', roles: ['MODERATOR'] as const },
  { handle: 'mod_ben', name: 'Ben (Moderator)', roles: ['MODERATOR'] as const },
  { handle: 'finance_fin', name: 'Fin (Finance)', roles: ['FINANCE'] as const },
  { handle: 'glow_owner', name: 'Gloria (GlowLab Owner)', roles: [] as const },
  { handle: 'glow_staff', name: 'Sam (GlowLab Fulfilment)', roles: [] as const },
  ...Array.from({ length: 10 }, (_, i) => ({ handle: `creator_${String(i + 1).padStart(2, '0')}`, name: `Creator ${i + 1}`, roles: [] as const })),
  ...Array.from({ length: 6 }, (_, i) => ({ handle: `viewer_${String(i + 1).padStart(2, '0')}`, name: `Viewer ${i + 1}`, roles: [] as const })),
  { handle: 'buyer_bea', name: 'Bea (Shopper)', roles: [] as const },
] as const;

export const CREATOR_CAPTIONS = [
  'Morning glow routine in 30 seconds ✨',
  'Serum vs. no serum — side by side',
  'Desk-to-dinner glow-up with one drop',
  'My skin after 7 days of Glow Serum',
  'Gym bag essentials: the 10-second refresh',
  'Golden hour test — no filter',
  'Explaining the serum to my grandma',
  'Travel-size glow on a red-eye flight',
  'Layering guide: mist, serum, lip oil',
  'Stop-motion unboxing, 200 frames',
];

/** Inline SVG product art (no third-party hosting). */
export function productSvg(label: string, hue: number): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,60%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,35%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><rect x="150" y="80" width="100" height="220" rx="24" fill="rgba(255,255,255,.85)"/><rect x="170" y="50" width="60" height="40" rx="8" fill="#101022"/><text x="200" y="360" font-family="sans-serif" font-size="30" fill="#fff" text-anchor="middle">${label}</text></svg>`,
  )}`;
}
