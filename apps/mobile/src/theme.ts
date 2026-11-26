// Mirrors packages/ui tokens (kept dependency-free so the Expo app installs standalone).
export const colors = {
  ink: '#101022', violet: '#7748EB', surface: '#23233C', surfaceRaised: '#2E2E4D', border: '#3B3B5C',
  text: '#FFFFFF', textMuted: '#C4C4D9', success: '#3DDC97', warning: '#FFC857', danger: '#FF6B6B',
} as const;
export const minTarget = 44;
export const money = (minor: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
