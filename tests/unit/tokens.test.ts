import { describe, expect, it } from 'vitest';
import { colors, contrastRatio, minTarget, dirFor, formatMoney } from '@trendora/ui';
import { CampaignRulesSchema, defaultRules, ScoringWeightsSchema } from '@trendora/contracts';
import { buildOpenApi } from '@trendora/contracts';

describe('design tokens', () => {
  it('meet WCAG AA contrast on the ink and surface backgrounds', () => {
    expect(contrastRatio(colors.text, colors.ink)).toBeGreaterThan(7);
    expect(contrastRatio(colors.textMuted, colors.ink)).toBeGreaterThan(4.5);
    expect(contrastRatio(colors.textMuted, colors.surface)).toBeGreaterThan(4.5);
    expect(contrastRatio(colors.text, colors.violet)).toBeGreaterThan(4.5);
    expect(minTarget).toBeGreaterThanOrEqual(44);
  });
  it('RTL readiness and localized money', () => {
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('ar-SA')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
    expect(formatMoney(4900, 'USD')).toBe('$49.00');
    expect(formatMoney(1000, 'JPY', 'ja-JP')).toMatch(/1,000/);
  });
});

describe('contracts', () => {
  it('default rules validate; weights must sum to 100', () => {
    expect(CampaignRulesSchema.safeParse(defaultRules()).success).toBe(true);
    expect(ScoringWeightsSchema.safeParse({ likes: 30, shares: 20, creativity: 20, completion: 15, comments: 10, growth: 6 }).success).toBe(false);
  });
  it('publishes an OpenAPI document', () => {
    const doc = buildOpenApi();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/checkouts');
    expect(JSON.stringify(doc.paths['/v1/checkouts'])).toContain('Idempotency-Key');
  });
});
