import type { CampaignStatus, EntryStatus, OrderStatus, FinancialStatus, RewardStatus } from './enums';
import type { CampaignRules } from './rules';

export interface Money { amountMinor: number; currency: string }

export interface FeedItem {
  entryId: string;
  campaignId: string;
  campaignTitle: string;
  storeSlug: string;
  storeName: string;
  creatorHandle: string;
  creatorName: string;
  caption: string;
  playbackUrl: string | null;
  posterUrl: string | null;
  durationMs: number | null;
  likeCount: number;
  likedByMe: boolean;
  sponsorDisclosure: string;
  productTags: { productId: string; title: string; offerMinor: number; regularMinor: number; currency: string }[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface VariantDto {
  id: string; sku: string; title: string; priceMinor: number; currency: string;
  attributes: Record<string, string>; inStock: boolean; available?: number;
}
export interface ProductDto {
  id: string; storeId: string; title: string; description: string; imageUrls: string[]; variants: VariantDto[];
  campaignOffers: { campaignId: string; variantId: string; offerMinor: number; requiredQty: number }[];
}
export interface StoreDto {
  id: string; slug: string; name: string; description: string; currency: string; country: string;
  shippingPolicy: string; returnPolicy: string; products: ProductDto[]; activeCampaigns: CampaignSummaryDto[];
}
export interface CampaignSummaryDto {
  id: string; title: string; tagline: string; status: CampaignStatus; storeId: string;
  startsAt: string; submissionEnd: string; voteEnd: string; currency: string;
}
export interface PrizeTierDto {
  id: string; rankFrom: number; rankTo: number | null; type: 'PRIZE' | 'COUPON'; title: string;
  valueMinor: number; percentOff: number | null;
}
export interface CampaignDto extends CampaignSummaryDto {
  description: string; appealDeadline: string; displayTimezone: string; rules: CampaignRules;
  rulesVersion: number; rulesHash: string | null; prizeTiers: PrizeTierDto[];
  skus: { variantId: string; productId: string; productTitle: string; variantTitle: string; requiredQty: number; offerMinor: number; regularMinor: number }[];
  store: { id: string; slug: string; name: string };
  entryCount: number; frozen: boolean; inventoryCap: number;
}
export interface CheckoutDto { checkoutId: string; orderId: string; hostedUrl: string; expiresAt: string; totalMinor: number; discountMinor: number; currency: string }
export interface OrderDto {
  id: string; storeId: string; storeName: string; status: OrderStatus; financialStatus: FinancialStatus;
  currency: string; subtotalMinor: number; discountMinor: number; totalMinor: number; createdAt: string;
  paidAt: string | null; shippedAt: string | null; deliveredAt: string | null; tracking: unknown;
  items: { id: string; variantId: string; title: string; qty: number; unitMinor: number; campaignId: string | null }[];
}
export interface EntitlementDto { id: string; campaignId: string; campaignTitle: string; source: 'PURCHASE' | 'ALTERNATIVE'; status: string; entryId: string | null; createdAt: string }
export interface EntryDto {
  id: string; campaignId: string; status: EntryStatus; caption: string; videoStatus: string;
  moderationStatus: string; playbackUrl: string | null; submittedAt: string | null; approvedAt: string | null;
  rejectionReason: string | null; createdAt: string;
}
export interface CreateEntryDto { entryId: string; uploadUrl: string; uploadExpiresAt: string; provider: string }
export interface LeaderboardRow { rank: number; entryId: string; creatorHandle: string; score: number; components: Record<string, number> }
export interface LeaderboardDto { campaignId: string; snapshotId: string | null; status: 'NONE' | 'PROVISIONAL' | 'FINAL'; cutoff: string | null; updatedAt: string | null; rows: LeaderboardRow[]; nextCursor: string | null }
export interface CouponDto { id: string; code: string; percentOff: number; maxDiscountMinor: number; minSpendMinor: number; currency: string; expiresAt: string; status: string; storeSlug: string; usedCount: number; usageLimit: number; exclusions: string }
export interface RewardDto { id: string; campaignId: string; campaignTitle: string; rank: number; type: 'PRIZE' | 'COUPON'; title: string; status: RewardStatus; valueMinor: number; deliveryDeadline: string | null; coupon: CouponDto | null; fulfillment: unknown }
