import type { TicketManagementRequestReference } from '@/lib/ticket-management/types';

/** The plain-language action label that precedes an on-screen request link. */
export function ticketManagementRequestLabel(
  reference: TicketManagementRequestReference
): string {
  if (reference.terminalOutcome === 'refunded') return 'Refunded';
  if (reference.terminalOutcome === 'reissued') return 'Reissued';
  if (reference.terminalOutcome === 'voided') return 'Voided';
  if (reference.action === 'refund') return 'Refund';
  if (reference.action === 'reissue') return 'Reissue';
  return 'VOID';
}

/** Opens the matching request directly in the Manage workspace. */
export function ticketManagementRequestHref(
  reference: TicketManagementRequestReference
): string {
  const status =
    reference.status === 'completed' ? 'approved' : reference.status;
  const query = new URLSearchParams({
    tab: 'manage',
    action: reference.action,
    status,
    request: reference.publicRef,
  });
  return `/dashboard/bookings?${query.toString()}`;
}
