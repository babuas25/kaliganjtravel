import {
  TICKET_MANAGEMENT_ACTIONS,
  type TicketManagementAction,
} from '@/lib/ticket-management/types';

export type TicketManagementBookingActionContext = {
  status?: string | null;
  directTicketing?: boolean | null;
  importSource?: string | null;
  bookingOrigin?: string | null;
};

export function ticketManagementActionsForBooking(
  booking: TicketManagementBookingActionContext
): TicketManagementAction[] {
  if (booking.status !== 'confirmed') return [];

  const reissueOnly =
    booking.directTicketing === true ||
    booking.importSource === 'IMP_EXP' ||
    booking.importSource === 'MANUAL' ||
    booking.bookingOrigin === 'supplier_reference_import';

  return reissueOnly ? ['reissue'] : [...TICKET_MANAGEMENT_ACTIONS];
}
