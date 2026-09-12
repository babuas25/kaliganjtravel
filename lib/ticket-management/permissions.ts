import type { Role } from '@/lib/roles';

const REQUEST_OWNER_ROLES = new Set<Role>(['customer', 'b2b', 'b2b_sub']);
const OPERATIONAL_ROLES = new Set<Role>([
  'staff_support',
  'admin',
  'superadmin',
]);
const FINANCIAL_ROLES = new Set<Role>([
  'staff_account',
  'admin',
  'superadmin',
]);

export function canCreateOwnTicketManagementRequest(role: Role): boolean {
  return REQUEST_OWNER_ROLES.has(role);
}

/**
 * Ticket Management is visible to booking owners and the staff roles that
 * operate or settle requests. Media Staff has neither booking-detail access
 * nor a Ticket Management responsibility.
 */
export function canViewTicketManagementRequest(role: Role): boolean {
  return role !== 'staff_media';
}

export function canOperateTicketManagementRequest(role: Role): boolean {
  return OPERATIONAL_ROLES.has(role);
}

export function canPublishTicketManagementQuote(role: Role): boolean {
  return OPERATIONAL_ROLES.has(role);
}

export function canAssignTicketManagementSettlement(role: Role): boolean {
  return OPERATIONAL_ROLES.has(role);
}

export function canFinalizeTicketManagementSettlement(role: Role): boolean {
  return FINANCIAL_ROLES.has(role);
}

export function canDirectlyFinalizeTicketManagementSettlement(role: Role): boolean {
  return role === 'admin' || role === 'superadmin';
}

export function isTicketManagementFinancialRole(role: Role): boolean {
  return FINANCIAL_ROLES.has(role);
}
