import { z } from 'zod';

/**
 * Campaign rules are frozen into an immutable, hashed version at publish time
 * (spec §5, §6, §7). Scoring weights and reference rates must be fixed before launch.
 */
export const ScoringWeightsSchema = z
  .object({
    likes: z.number().min(0).max(100),
    shares: z.number().min(0).max(100),
    creativity: z.number().min(0).max(100),
    completion: z.number().min(0).max(100),
    comments: z.number().min(0).max(100),
    growth: z.number().min(0).max(100),
  })
  .refine((w) => Math.abs(w.likes + w.shares + w.creativity + w.completion + w.comments + w.growth - 100) < 1e-9, {
    message: 'Scoring weights must sum to 100',
  });
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

const RateSet = z.object({
  likes: z.number().positive().max(1),
  shares: z.number().positive().max(1),
  completion: z.number().positive().max(1),
  comments: z.number().positive().max(1),
  growth: z.number().positive().max(1),
});

export const ScoringConfigSchema = z.object({
  algorithmVersion: z.literal('trendscore-v1'),
  weights: ScoringWeightsSchema,
  /** Published fixed reference rate per metric: smoothed rate / reference × 100, capped at 100. */
  referenceRates: RateSet,
  /** Prior rate used for Bayesian smoothing. */
  priorRates: RateSet,
  /** Prior weight (pseudo-exposures). Spec default: 100. */
  priorWeight: z.number().int().positive().default(100),
  /** Creativity rubric scores that differ by more than this require adjudication. */
  adjudicationThreshold: z.number().min(0).max(100).default(20),
  /** Minimum words for a comment to count as meaningful. */
  meaningfulCommentMinWords: z.number().int().min(1).default(4),
  /** Tie order (published beforehand). */
  tieBreak: z.tuple([z.literal('creativity'), z.literal('shares'), z.literal('approvedAt')]),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const CampaignRulesSchema = z.object({
  scoring: ScoringConfigSchema,
  eligibility: z.object({
    countries: z.array(z.string().length(2)).min(1),
    minAge: z.number().int().min(13).max(21),
    /** Entitlement created only after this order milestone. */
    entitlementMilestone: z.enum(['PAID', 'DELIVERED']),
    maxEntriesPerUser: z.number().int().min(1).max(10),
    alternativeEntry: z.boolean(),
    alternativeEntryInstructions: z.string().max(2000),
  }),
  entry: z.object({
    minDurationMs: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
    allowedContentTypes: z.array(z.string()).min(1),
  }),
  minEntries: z.number().int().min(1),
  coupon: z.object({
    validityDays: z.number().int().min(1).max(365),
    minSpendMinor: z.number().int().min(0),
    maxDiscountMinor: z.number().int().positive(),
    allowedVariantIds: z.array(z.uuid()).nullable(),
    excludedVariantIds: z.array(z.uuid()),
    usageLimit: z.number().int().min(1).max(10),
    exclusionsText: z.string().max(1000),
  }),
  exposure: z.object({
    explorationImpressions: z.number().int().min(0),
    minImpressionsPerEntry: z.number().int().min(0),
  }),
  voting: z.object({
    minAccountAgeHours: z.number().int().min(0),
    maxLikesPerMinute: z.number().int().min(1),
    viewCapPerUser: z.number().int().min(1),
  }),
  prizes: z.object({
    deliveryDays: z.number().int().min(1).max(180),
    claimWindowDays: z.number().int().min(1).max(180),
  }),
  moderationRubric: z.string().min(1),
  disclosures: z.object({
    sponsor: z.string().min(1),
    noPurchaseNecessary: z.string().min(1),
    skillCriteria: z.string().min(1),
  }),
});
export type CampaignRules = z.infer<typeof CampaignRulesSchema>;

export const DEFAULT_SCORING: ScoringConfig = {
  algorithmVersion: 'trendscore-v1',
  weights: { likes: 30, shares: 20, creativity: 20, completion: 15, comments: 10, growth: 5 },
  referenceRates: { likes: 0.2, shares: 0.05, completion: 0.6, comments: 0.05, growth: 0.03 },
  priorRates: { likes: 0.05, shares: 0.01, completion: 0.3, comments: 0.01, growth: 0.005 },
  priorWeight: 100,
  adjudicationThreshold: 20,
  meaningfulCommentMinWords: 4,
  tieBreak: ['creativity', 'shares', 'approvedAt'],
};

export function defaultRules(overrides: Partial<CampaignRules> = {}): CampaignRules {
  return {
    scoring: DEFAULT_SCORING,
    eligibility: {
      countries: ['US'],
      minAge: 18,
      entitlementMilestone: 'DELIVERED',
      maxEntriesPerUser: 1,
      alternativeEntry: true,
      alternativeEntryInstructions:
        'No purchase necessary. Submit a short statement describing how you would demonstrate the product; approved requests receive one free entry.',
    },
    entry: {
      minDurationMs: 1_000,
      maxDurationMs: 180_000,
      maxBytes: 200 * 1024 * 1024,
      allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    },
    minEntries: 5,
    coupon: {
      validityDays: 30,
      minSpendMinor: 0,
      maxDiscountMinor: 10_000,
      allowedVariantIds: null,
      excludedVariantIds: [],
      usageLimit: 1,
      exclusionsText: 'Valid on this store only. Not combinable with other coupons. Excludes gift cards.',
    },
    exposure: { explorationImpressions: 2, minImpressionsPerEntry: 0 },
    voting: { minAccountAgeHours: 0, maxLikesPerMinute: 30, viewCapPerUser: 3 },
    prizes: { deliveryDays: 30, claimWindowDays: 30 },
    moderationRubric: 'trendora-rubric-v1: originality, product integration, execution (0-100 each)',
    disclosures: {
      sponsor: 'Sponsored challenge. Prizes provided by the merchant.',
      noPurchaseNecessary: 'No purchase necessary to enter. A free alternative entry is available.',
      skillCriteria:
        'Winners are determined by the published TrendScore formula combining verified engagement and human-judged creativity — not by chance.',
    },
    ...overrides,
  };
}
