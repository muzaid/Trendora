import type { MerchantRole, PlatformRole } from '@trendora/contracts';

export type MerchantPermission =
  | 'org.manage' | 'staff.manage' | 'catalog.write' | 'orders.manage' | 'orders.refund'
  | 'campaigns.write' | 'campaigns.publish' | 'rewards.fulfill' | 'analytics.read' | 'finance.read' | 'agents.run';

const MATRIX: Record<MerchantRole, MerchantPermission[]> = {
  OWNER: ['org.manage', 'staff.manage', 'catalog.write', 'orders.manage', 'orders.refund', 'campaigns.write', 'campaigns.publish', 'rewards.fulfill', 'analytics.read', 'finance.read', 'agents.run'],
  MANAGER: ['catalog.write', 'orders.manage', 'orders.refund', 'campaigns.write', 'rewards.fulfill', 'analytics.read', 'finance.read', 'agents.run'],
  CATALOG: ['catalog.write'],
  CAMPAIGNS: ['campaigns.write', 'analytics.read', 'agents.run'],
  FULFILLMENT: ['orders.manage', 'rewards.fulfill'],
  ANALYST: ['analytics.read'],
};

export function merchantCan(role: MerchantRole, perm: MerchantPermission): boolean {
  return MATRIX[role].includes(perm);
}
export const merchantPermissions = (role: MerchantRole) => [...MATRIX[role]];

export type PlatformPermission = 'moderation' | 'finance' | 'admin';
export function platformCan(roles: PlatformRole[], perm: PlatformPermission): boolean {
  if (roles.includes('ADMIN')) return true;
  if (perm === 'moderation') return roles.includes('MODERATOR');
  if (perm === 'finance') return roles.includes('FINANCE');
  return false;
}
