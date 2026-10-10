import type { DashboardSession } from '@/lib/dashboard/session';
import type { BookingRow } from '@/lib/db/flight-bookings';
import type { Role } from '@/lib/roles';
import { isExternalBookingSource } from '@/lib/impexp/booking-source';
import {
  shapontravelsCurrentStatusBlocksCancel,
  shapontravelsCurrentStatusBlocksIssue,
} from '@/lib/shapontravels/current-status-projection';

export type WalletOwner = {
  ownerType: 'user' | 'agency';
  ownerKey: string;
};

const IMPORTED_ISSUE_STAFF_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_support',
]);

const WALLET_READ_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_support',
  'staff_account',
]);

const WALLET_MUTATION_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_account',
]);

/** Read-only visibility into organization wallet queues and reporting. */
export function canReadWallet(role: Role): boolean {
  return WALLET_READ_ROLES.has(role);
}

/** Money movement and wallet-state changes. Support is deliberately excluded. */
export function canManageWallet(role: Role): boolean {
  return WALLET_MUTATION_ROLES.has(role);
}

/** Booking refunds prescribe money and are not a Support capability. */
export function canRefundBooking(role: Role): boolean {
  return canManageWallet(role);
}

/** Admin and staff identities deliberately never resolve to personal wallets. */
export function walletOwnerForSession(
  session: DashboardSession
): WalletOwner | null {
  if (session.role === 'customer') {
    return { ownerType: 'user', ownerKey: session.clerkId };
  }
  if (
    (session.role === 'b2b' || session.role === 'b2b_sub') &&
    session.agencyCode
  ) {
    return { ownerType: 'agency', ownerKey: session.agencyCode };
  }
  return null;
}

/** The durable wallet owner assigned to a booking, independent of the actor. */
export function walletOwnerForBooking(
  booking: Pick<BookingRow, 'booking_owner_type' | 'booking_owner_key'>
): WalletOwner | null {
  if (
    (booking.booking_owner_type !== 'user' &&
      booking.booking_owner_type !== 'agency') ||
    !booking.booking_owner_key
  ) {
    return null;
  }
  return {
    ownerType: booking.booking_owner_type,
    ownerKey: booking.booking_owner_key,
  };
}

/**
 * The wallet owner normally authorizes ticketing. SuperAdmin/Admin may also
 * issue on behalf of that owner; the booking owner remains the wallet charged.
 * Support remains operational-only and cannot issue.
 */
export function canIssueBooking(
  session: DashboardSession,
  booking: Pick<
    BookingRow,
    'booking_owner_type' | 'booking_owner_key' | 'status' | 'lifecycle_status'
  > & Partial<Pick<BookingRow, 'supplier' | 'shapon_current_status'>>
): boolean {
  if (session.role === 'staff_support') return false;
  if (shapontravelsCurrentStatusBlocksIssue(booking)) return false;
  if (booking.status !== 'on-hold' && booking.status !== 'pending') return false;
  if (booking.status === 'on-hold' && booking.lifecycle_status !== 'on-hold') return false;
  if (!booking.booking_owner_type || !booking.booking_owner_key) return false;
  if (session.role === 'superadmin' || session.role === 'admin') return true;
  if (session.role === 'staff_account') return true;
  // Pending is a rare controlled prerequisite state. It is not proof of a
  // supplier-wallet failure or prior customer charge, and only an authorized
  // operational/financial user may advance its explicit compatibility path.
  if (booking.status === 'pending') return false;
  const owner = walletOwnerForSession(session);
  return (
    owner?.ownerType === booking.booking_owner_type &&
    owner.ownerKey === booking.booking_owner_key
  );
}

/** Imported holds are payable only by the customer or shared agency owner. */
export function canAccessImportedBookingPayment(
  session: DashboardSession,
  booking: Pick<
    BookingRow,
    | 'import_source'
    | 'booking_owner_type'
    | 'booking_owner_key'
  >
): boolean {
  if (!isExternalBookingSource(booking.import_source)) return false;
  const owner = walletOwnerForSession(session);
  return owner?.ownerType === booking.booking_owner_type &&
    owner.ownerKey === booking.booking_owner_key;
}

/**
 * Imported Issue Now is normally owner-only. Authorized operations staff may
 * act on behalf of the assigned owner, but only that owner's wallet is used.
 */
export function canAccessImportedBookingIssue(
  session: DashboardSession,
  booking: Pick<
    BookingRow,
    'import_source' | 'booking_owner_type' | 'booking_owner_key'
  >
): boolean {
  if (!isExternalBookingSource(booking.import_source)) return false;
  if (IMPORTED_ISSUE_STAFF_ROLES.has(session.role)) {
    return walletOwnerForBooking(booking) !== null;
  }
  return canAccessImportedBookingPayment(session, booking);
}

export function canConfirmImportedBooking(
  session: DashboardSession,
  booking: Pick<
    BookingRow,
    | 'import_source'
    | 'booking_owner_type'
    | 'booking_owner_key'
    | 'status'
    | 'lifecycle_status'
    | 'payment_state'
  >
): boolean {
  if (
    !canAccessImportedBookingIssue(session, booking) ||
    booking.status !== 'on-hold' ||
    booking.lifecycle_status !== 'on-hold' ||
    booking.payment_state !== 'unpaid'
  ) {
    return false;
  }
  return true;
}

/** Cancel uses the wallet-owner boundary and rejects ticketed or active bookings. */
export function canCancelBooking(
  session: DashboardSession,
  booking: Pick<
    BookingRow,
    'booking_owner_type' | 'booking_owner_key' | 'status' | 'lifecycle_status' |
    'direct_ticketing' | 'issued_at'
  > & Partial<Pick<BookingRow,
    | 'supplier' | 'shapon_current_status' | 'operation_kind' | 'operation_request_id'
    | 'operation_started_at' | 'ticket_code_ref' | 'ticket_numbers'
    | 'payment_state' | 'captured_amount'
  >>
): boolean {
  if (shapontravelsCurrentStatusBlocksCancel(booking)) return false;
  if (booking.direct_ticketing || booking.issued_at) return false;
  if (booking.supplier === 'shapontravels') {
    if (!['on-hold', 'pending'].includes(booking.status) ||
        !['on-hold', 'pending', 'unconfirmed', 'expired'].includes(booking.lifecycle_status ?? '') ||
        booking.operation_kind || booking.operation_request_id || booking.operation_started_at ||
        booking.ticket_code_ref ||
        (booking.ticket_numbers != null &&
          (!Array.isArray(booking.ticket_numbers) || booking.ticket_numbers.length > 0)) ||
        (booking.captured_amount ?? 0) > 0 ||
        (booking.payment_state != null && !['unpaid', 'released'].includes(booking.payment_state))) {
      return false;
    }
  } else if (booking.status !== 'on-hold' || booking.lifecycle_status !== 'on-hold') {
    return false;
  }
  if (!booking.booking_owner_type || !booking.booking_owner_key) return false;
  if (canManageWallet(session.role)) return true;
  const owner = walletOwnerForSession(session);
  return owner?.ownerType === booking.booking_owner_type
    && owner.ownerKey === booking.booking_owner_key;
}

export function canCreateOwnBooking(role: Role): boolean {
  return role === 'customer' || role === 'b2b' || role === 'b2b_sub';
}
