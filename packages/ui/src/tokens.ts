/** Shared design tokens (spec §4). Used by web (CSS variables) and mobile (StyleSheet). */
export const colors = {
  ink: '#101022',
  violet: '#7748EB',
  violetStrong: '#5B2FD6',
  violetSoft: '#B9A2F6',
  surface: '#23233C',
  surfaceRaised: '#2E2E4D',
  border: '#3B3B5C',
  text: '#FFFFFF',
  textMuted: '#C4C4D9', // 9.6:1 on ink
  success: '#3DDC97',
  warning: '#FFC857',
  danger: '#FF6B6B',
  sandbox: '#FFC857',
} as const;

export const radii = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
/** Minimum interactive target (spec §4: 44px). */
export const minTarget = 44;
export const fontStack = 'Inter, "Segoe UI", system-ui, -apple-system, "Noto Sans Hebrew", "Noto Sans Arabic", sans-serif';

export const tokens = { colors, radii, spacing, minTarget, fontStack } as const;
export type Tokens = typeof tokens;

/** Relative luminance contrast ratio (WCAG 2.1) for token validation tests. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(hexA), lum(hexB)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
