import { invalid, ineligible } from '@trendora/contracts';

/** Server-side repricing (spec §8): never trust client amounts. */
export interface CatalogVariant {
  id: string;
  storeId: string;
  priceMinor: number;
  currency: string;
  active: boolean;
}
export interface CampaignOffer { variantId: string; offerMinor: number; requiredQty: number }
export interface PricedLine { variantId: string; qty: number; unitMinor: number; regularMinor: number; campaignId: string | null }

export function priceCart(
  items: { variantId: string; qty: number }[],
  catalog: Map<string, CatalogVariant>,
  campaign: { id: string; storeId: string; currency: string; offerOpen: boolean; offers: CampaignOffer[] } | null,
): { storeId: string; currency: string; lines: PricedLine[]; subtotalMinor: number } {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.variantId, (merged.get(i.variantId) ?? 0) + i.qty);
  const lines: PricedLine[] = [];
  let storeId: string | null = null;
  let currency: string | null = null;
  for (const [variantId, qty] of merged) {
    const v = catalog.get(variantId);
    if (!v || !v.active) throw invalid(`Variant ${variantId} is not available`);
    storeId ??= v.storeId;
    currency ??= v.currency;
    if (v.storeId !== storeId) throw invalid('A checkout may only contain items from a single store');
    if (v.currency !== currency) throw invalid('A checkout may only use one currency');
    const offer = campaign?.offers.find((o) => o.variantId === variantId);
    lines.push({
      variantId,
      qty,
      unitMinor: offer && campaign?.offerOpen ? offer.offerMinor : v.priceMinor,
      regularMinor: v.priceMinor,
      campaignId: offer && campaign ? campaign.id : null,
    });
  }
  if (!storeId || !currency) throw invalid('Cart is empty');
  if (campaign) {
    if (campaign.storeId !== storeId) throw invalid('Campaign does not belong to this store');
    if (!campaign.offerOpen) throw ineligible('The campaign offer is not currently open');
    const qualifying = campaign.offers.some((o) => (merged.get(o.variantId) ?? 0) >= o.requiredQty);
    if (!qualifying) throw ineligible('Cart does not contain the qualifying bundle for this campaign');
  }
  const subtotalMinor = lines.reduce((s, l) => s + l.unitMinor * l.qty, 0);
  return { storeId, currency, lines, subtotalMinor };
}

/** Number of entitlements a paid order line qualifies for: one per completed bundle, capped by policy. */
export function entitlementsForLine(qty: number, requiredQty: number, maxPerUser: number): number {
  if (requiredQty <= 0) return 0;
  return Math.min(Math.floor(qty / requiredQty), maxPerUser);
}
