export const CAMPAIGN_STATUSES = [
  'DRAFT', 'REVIEW', 'SCHEDULED', 'OPEN', 'SUBMISSION_CLOSED', 'VOTING_CLOSED',
  'REVIEWING', 'FINALIZED', 'FULFILLED', 'CANCELED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ENTRY_STATUSES = ['DRAFT', 'PROCESSING', 'REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ORDER_STATUSES = ['PENDING', 'PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FINANCIAL_STATUSES = ['NONE', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'] as const;
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

export const MERCHANT_ROLES = ['OWNER', 'MANAGER', 'CATALOG', 'CAMPAIGNS', 'FULFILLMENT', 'ANALYST'] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

export const PLATFORM_ROLES = ['MODERATOR', 'FINANCE', 'ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const REWARD_STATUSES = ['ISSUED', 'CLAIMED', 'FULFILLING', 'FULFILLED', 'UNDER_REVIEW', 'FORFEITED'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const ENGAGEMENT_TYPES = ['IMPRESSION', 'VIEW_COMPLETE', 'LIKE', 'UNLIKE', 'SHARE_VISIT', 'COMMENT', 'FOLLOW'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'UNSAFE_CHALLENGE', 'COPYRIGHT', 'MISLEADING', 'UNDERAGE', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const AGENT_KINDS = ['TREND', 'CAMPAIGN', 'COMMERCE', 'VIDEO_STUDIO', 'TRUST', 'REWARDS', 'MARKETING', 'ANALYTICS'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
