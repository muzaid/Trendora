import { z } from 'zod';
import { CampaignRulesSchema } from './rules';
import { ENGAGEMENT_TYPES, REPORT_REASONS, AGENT_KINDS, MERCHANT_ROLES } from './enums';

/** Versioned REST request schemas (spec §12). Responses are typed in ./responses. */

const uuid = z.uuid();
const currency = z.string().regex(/^[A-Z]{3}$/);
const minor = z.number().int().min(0).max(1_000_000_000_00);

export const CursorQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const CheckoutItem = z.object({ variantId: uuid, qty: z.number().int().min(1).max(20) });
export const CreateCheckoutBody = z.object({
  campaignId: uuid.optional(),
  items: z.array(CheckoutItem).min(1).max(20),
  couponCode: z.string().trim().min(4).max(40).optional(),
  shippingAddress: z.object({
    name: z.string().min(1).max(120),
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).optional(),
    city: z.string().min(1).max(100),
    region: z.string().max(100).optional(),
    postalCode: z.string().min(1).max(20),
    country: z.string().length(2),
  }),
});
export type CreateCheckoutInput = z.infer<typeof CreateCheckoutBody>;

export const CreateEntryBody = z.object({
  entitlementId: uuid,
  caption: z.string().max(300).default(''),
  commercialReuseConsent: z.boolean().default(false),
  contentType: z.string().max(100).default('video/mp4'),
});
export const SubmitEntryBody = z.object({ caption: z.string().max(300).optional() });
export const LikeBody = z.object({ active: z.boolean() });
export const EngagementBody = z.object({
  type: z.enum(['IMPRESSION', 'VIEW_COMPLETE'] as const satisfies readonly (typeof ENGAGEMENT_TYPES)[number][]),
  source: z.enum(['ORGANIC', 'EXPLORATION', 'PAID']).default('ORGANIC'),
  watchedMs: z.number().int().min(0).max(3_600_000).optional(),
});
export const CommentBody = z.object({ body: z.string().trim().min(1).max(500) });
export const ShareVisitBody = z.object({ token: z.string().min(16).max(200) });

export const PrizeTierInput = z
  .object({
    rankFrom: z.number().int().min(1),
    rankTo: z.number().int().min(1).nullable(),
    type: z.enum(['PRIZE', 'COUPON']),
    title: z.string().min(1).max(120),
    valueMinor: minor.default(0),
    percentOff: z.number().int().min(1).max(100).nullable().default(null),
  })
  .refine((t) => t.rankTo === null || t.rankTo >= t.rankFrom, { message: 'rankTo must be >= rankFrom' })
  .refine((t) => (t.type === 'COUPON') === (t.percentOff !== null), {
    message: 'Coupon tiers require percentOff; prize tiers must not set it',
  });
export type PrizeTierInputT = z.infer<typeof PrizeTierInput>;

export const CampaignSkuInput = z.object({
  variantId: uuid,
  requiredQty: z.number().int().min(1).max(10).default(1),
  offerMinor: minor,
});

export const CampaignDraftBody = z.object({
  storeId: uuid,
  title: z.string().trim().min(3).max(120),
  tagline: z.string().max(200).default(''),
  description: z.string().max(5000).default(''),
  startsAt: z.iso.datetime({ offset: true }),
  submissionEnd: z.iso.datetime({ offset: true }),
  voteEnd: z.iso.datetime({ offset: true }),
  appealDeadline: z.iso.datetime({ offset: true }),
  displayTimezone: z.string().min(1).max(64).default('UTC'),
  inventoryCap: z.number().int().min(1).max(1_000_000),
  skus: z.array(CampaignSkuInput).min(1).max(20),
  prizeTiers: z.array(PrizeTierInput).min(1).max(20),
  rules: CampaignRulesSchema,
});
export type CampaignDraftInput = z.infer<typeof CampaignDraftBody>;
export const CampaignPatchBody = CampaignDraftBody.omit({ storeId: true }).partial().extend({
  expectedVersion: z.number().int().min(1),
});
export const ReasonBody = z.object({ reason: z.string().trim().min(5).max(2000) });
export const FundingBody = z.object({
  method: z.enum(['ESCROW_PROVIDER', 'BANK_GUARANTEE', 'PREPAID_INVENTORY']),
  reference: z.string().min(3).max(200),
  amountMinor: minor,
});

export const FinalizeBody = z.object({
  expectedSnapshotId: uuid,
  reason: z.string().trim().min(5).max(2000),
});
export const SnapshotBody = z.object({ cutoff: z.iso.datetime({ offset: true }).optional() });

export const RubricBody = z.object({
  originality: z.number().int().min(0).max(100),
  productIntegration: z.number().int().min(0).max(100),
  execution: z.number().int().min(0).max(100),
  notes: z.string().max(1000).default(''),
});

export const ClaimRewardBody = z.object({
  shippingAddress: CreateCheckoutBody.shape.shippingAddress,
  acceptTerms: z.literal(true),
});
export const FulfillRewardBody = z.object({
  carrier: z.string().min(2).max(60),
  trackingNumber: z.string().min(3).max(80),
  notes: z.string().max(1000).default(''),
});

export const AppealBody = z.object({ entryId: uuid, reason: z.string().trim().min(10).max(2000) });
export const AppealDecisionBody = z.object({ decision: z.enum(['UPHELD', 'DENIED']), resolution: z.string().min(5).max(2000) });
export const ReportBody = z.object({
  targetType: z.enum(['ENTRY', 'COMMENT', 'PROFILE', 'PRODUCT', 'STORE']),
  targetId: uuid,
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(2000).default(''),
});
export const ReportDecisionBody = z.object({ decision: z.enum(['ACTIONED', 'DISMISSED']), resolution: z.string().min(3).max(2000) });
export const ModerationBody = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().max(1000).default('') });
export const AlternativeEntryBody = z.object({ statement: z.string().trim().min(10).max(2000) });
export const AlternativeDecisionBody = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) });

export const StoreBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
  description: z.string().max(2000).default(''),
  currency: currency.default('USD'),
  country: z.string().length(2).default('US'),
  shippingPolicy: z.string().max(2000).default(''),
  returnPolicy: z.string().max(2000).default(''),
});
export const OnboardBody = z.object({
  organizationName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(200),
  country: z.string().length(2),
  store: StoreBody,
});
export const VariantInput = z.object({
  sku: z.string().trim().min(1).max(64),
  title: z.string().max(120).default('Default'),
  priceMinor: minor,
  stock: z.number().int().min(0).max(10_000_000),
  attributes: z.record(z.string(), z.string()).default({}),
});
export const ProductBody = z.object({
  storeId: uuid,
  title: z.string().trim().min(1).max(160),
  description: z.string().max(5000).default(''),
  imageUrls: z.array(z.url({ protocol: /^https$/ })).max(10).default([]),
  status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
  variants: z.array(VariantInput).min(1).max(50),
});
export const PriceBody = z.object({ priceMinor: minor });
export const InventoryAdjustBody = z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000), expectedVersion: z.number().int().min(0) });
export const CsvImportBody = z.object({ storeId: uuid, csv: z.string().min(1).max(500_000) });
export const OrderTransitionBody = z.object({
  to: z.enum(['FULFILLING', 'SHIPPED', 'DELIVERED']),
  carrier: z.string().max(60).optional(),
  trackingNumber: z.string().max(80).optional(),
});
export const RefundBody = z.object({ amountMinor: z.number().int().min(1), reason: z.string().trim().min(3).max(500) });
export const MembershipBody = z.object({ userHandle: z.string().min(3).max(30), role: z.enum(MERCHANT_ROLES) });
export const OrgDecisionBody = z.object({ decision: z.enum(['VERIFIED', 'REJECTED', 'SUSPENDED']), notes: z.string().max(1000).default('') });
export const CampaignReviewBody = z.object({ decision: z.enum(['APPROVE', 'REJECT']), notes: z.string().min(3).max(2000) });
export const KillSwitchBody = z.object({ frozen: z.boolean(), reason: z.string().trim().min(5).max(1000) });
export const ProfilePatchBody = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  privacySettings: z.object({ showOnLeaderboard: z.boolean(), marketingEmails: z.boolean() }).partial().optional(),
});
export const AgentRunBody = z.object({
  agent: z.enum(AGENT_KINDS),
  orgId: uuid.optional(),
  campaignId: uuid.optional(),
  prompt: z.string().max(4000).default(''),
});
export const AgentDecisionBody = z.object({ decision: z.enum(['APPROVED', 'DISMISSED']) });
export const ClockBody = z.object({ offsetMs: z.number().int().min(0).max(400 * 86_400_000) });
export const SandboxLoginBody = z.object({ handle: z.string().min(3).max(30) });
export const SandboxPayBody = z.object({ outcome: z.enum(['succeeded', 'failed']) });

// ---- Direct (off-platform) coupon redemption --------------------------------
const couponCode = z.string().trim().min(4).max(40);
export const CouponLookupBody = z.object({ code: couponCode });
export const DirectRedeemBody = z.object({
  code: couponCode,
  /** Purchase total at the business, in minor units. */
  purchaseMinor: z.number().int().min(1).max(1_000_000_000_00),
  /** Portion of the purchase the coupon applies to (defaults to the full total). */
  eligibleMinor: z.number().int().min(1).max(1_000_000_000_00).optional(),
  /** Receipt / order number in the business's own system. Retries with the same value are idempotent. */
  reference: z.string().trim().min(1).max(120),
});
export type DirectRedeemInput = z.infer<typeof DirectRedeemBody>;
export const StoreApiKeyBody = z.object({ name: z.string().trim().min(1).max(80) });
