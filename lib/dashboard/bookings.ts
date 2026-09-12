import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import type {
  BookingDashboardListDbRow,
  BookingScope,
} from '@/lib/db/flight-bookings';
import { listBookingDashboardPage } from '@/lib/db/flight-bookings';
import { listTicketManagementRequestReferencesForBookings } from '@/lib/db/ticket-management';
import { listStaffBookingLifecycle } from '@/lib/db/booking-lifecycle';
import {
  bookingLifecycleAccessForRole,
  type StaffBookingLifecycle,
} from '@/lib/dashboard/booking-lifecycle';
import type { DashboardSession } from '@/lib/dashboard/session';
import type { Role } from '@/lib/roles';
import type { BookingPassengerType } from '@/lib/flights/booking';
import {
  resolvePublicBookingStatus,
  type BookingStatus,
} from '@/lib/flights/booking-status';
import { customerStatusMessage } from '@/lib/flights/customer-status';
import type { BookingListQuery } from '@/lib/dashboard/booking-list-query';
import type { TicketManagementRequestReference } from '@/lib/ticket-management/types';

/** One row of the My Bookings list, ready to render. */
export type BookingListRow = {
  id: string;
  /** Ours, shown in the Ref No column. */
  referenceNo: string;
  /** Refund, Reissue/Exchange, and VOID request references for this booking. */
  ticketManagementReferences: TicketManagementRequestReference[];
  /** Staff-only supplier transaction reference (for example, `FST...`). */
  supplierReference?: string;
  createDate: string;
  /** Airline record locator(s), distinct from the supplier's booking locator. */
  airlinePnr: string;
  pnr: string;
  name: string;
  lifecycleAt: string | null;
  fare: number;
  /** Customer-facing gross amount; null on bookings created before it was saved. */
  gross: number | null;
  route: string;
  airline: string;
  flyDate: string;
  passengerType: string;
  /** Authoritative supplier amount; null for legacy snapshots that predate it. */
  supplierPayable: number | null;
  createdBy: string;
  status: BookingStatus;
  /** Customer-safe subtype sentence; internal codes remain staff-only. */
  statusMessage: string | null;
  /** Staff-only indication; customer scopes never receive hidden rows. */
  hiddenFromUser: boolean;
  /** Whether the booking belongs to a B2B agency rather than a B2C user. */
  isAgencyBooking: boolean;
  /** Staff-only normalized operational context; absent for every customer role. */
  lifecycleIndicator?: BookingLifecycleIndicator;
};

export type BookingLifecycleIndicator = {
  operationKind: string | null;
  operationState: string | null;
  operationElapsedSeconds: number | null;
  reconciliationType: string | null;
  reconciliationState: string | null;
  assignedTeam: string | null;
  assigneeUserId: string | null;
  dueAt: string | null;
  slaBreached: boolean;
  evidenceIsFresh: boolean;
  paymentConflictCode: string | null;
  terminalConflict: boolean;
  attentionRequired: boolean;
};

export type BookingPiiAccess = 'full' | 'masked-passport' | 'financial-only';

/** The passenger fields a role may receive from the rendered dashboard. */
export function bookingPiiAccessFor(role: Role): BookingPiiAccess {
  if (role === 'staff_account') return 'financial-only';
  if (role === 'staff_support') return 'masked-passport';
  return 'full';
}

/**
 * What this session is allowed to list.
 *
 * An agency user with no resolved `agencyCode` gets their own bookings rather
 * than an agency's — `session.agencyCode` is null both for someone outside an
 * agency and when the lookup failed, and the second case must not widen what
 * they can see.
 */
export function bookingScopeFor(session: DashboardSession): BookingScope {
  const { role, agencyCode, clerkId } = session;
  if (
    role === 'superadmin' ||
    role === 'admin' ||
    role === 'staff_support' ||
    role === 'staff_account'
  ) {
    return { kind: 'all' };
  }
  if ((role === 'b2b' || role === 'b2b_sub') && agencyCode) {
    return { kind: 'agency', agencyCode };
  }
  return { kind: 'user', clerkId };
}

/** `"MD ALAMIN PRAMANIK (+2)"` — the lead traveller, and how many others. */
function leadName(name: string | null, total: number): string {
  const trimmed = name?.trim() ?? '';
  const safeTotal = Math.max(0, total);
  if (!trimmed) return '—';
  const others = Math.max(0, safeTotal - 1);
  return others > 0 ? `${trimmed} (+${others})` : trimmed;
}

/** `"Adult 2, Child 1"`, merging the two child and two infant codes. */
function passengerTypeLabel(
  counts: Partial<Record<BookingPassengerType, number>>
): string {
  const adult = counts.ADT ?? 0;
  const child = (counts.CHD ?? 0) + (counts.CNN ?? 0);
  const infant = (counts.INF ?? 0) + (counts.INS ?? 0);
  return (
    [
      adult > 0 ? `Adult ${adult}` : '',
      child > 0 ? `Child ${child}` : '',
      infant > 0 ? `Infant ${infant}` : '',
    ]
      .filter(Boolean)
      .join(', ') || '—'
  );
}

function totalPassengers(
  counts: Partial<Record<BookingPassengerType, number>>
): number {
  return Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
}

function lifecycleTimestamp(
  row: BookingDashboardListDbRow,
  status: BookingStatus
): string | null {
  if (status === 'in-progress') return row.operation_started_at;
  if (status === 'confirmed') return row.issued_at;
  if (status === 'expired') return row.ticketing_deadline_at ?? row.last_lifecycle_event_at ?? null;
  if (status === 'cancelled') return row.cancelled_at ?? row.last_lifecycle_event_at ?? null;
  if (status === 'unconfirmed') return row.last_lifecycle_event_at ?? null;
  return null;
}

function creatorLabel(row: BookingDashboardListDbRow): string {
  const name = row.creator_name?.trim() || row.creator_email?.trim() || '—';
  const isInternalCreator =
    row.creator_role === 'superadmin' ||
    row.creator_role === 'admin' ||
    row.creator_role.startsWith('staff_');
  const bookingAgency =
    row.booking_agency_name?.trim() || row.booking_agency_code?.trim();
  const bookedForAgency =
    isInternalCreator && bookingAgency ? `For: ${bookingAgency}` : null;

  if (row.creator_role === 'superadmin' || row.creator_role === 'admin') {
    return [name, 'Admin', bookedForAgency].filter(Boolean).join('\n');
  }
  if (row.creator_role === 'staff_support') {
    return [name, 'Support Team', bookedForAgency].filter(Boolean).join('\n');
  }
  if (row.creator_role === 'staff_account') {
    return [name, 'Accounts Team', bookedForAgency].filter(Boolean).join('\n');
  }
  if (row.creator_role === 'staff_media') {
    return [name, 'Media Team', bookedForAgency].filter(Boolean).join('\n');
  }
  if (row.creator_role === 'b2b' || row.creator_role === 'b2b_sub') {
    return [
      name,
      row.creator_agency_name?.trim() || 'B2B Agency',
      row.creator_agency_code?.trim() || '—',
    ].join('\n');
  }
  if (row.creator_role === 'customer') return `${name}\nB2C User`;
  return name;
}

function toListRow(
  row: BookingDashboardListDbRow,
  piiAccess: BookingPiiAccess,
  includeSupplierReference: boolean,
  ticketManagementReferences: TicketManagementRequestReference[]
): BookingListRow {
  const financialOnly = piiAccess === 'financial-only';
  const supplierReference = row.supplier_reference?.trim();
  const status = resolvePublicBookingStatus({
    lifecycleStatus: row.lifecycle_status,
    status: row.status,
    airlinesPnr: row.airline_pnr ? [row.airline_pnr] : [],
    ticketingDeadlineAt: row.ticketing_deadline_at,
  });

  return {
    id: row.id,
    referenceNo: row.public_ref,
    ticketManagementReferences,
    ...(includeSupplierReference && supplierReference
      ? { supplierReference }
      : {}),
    createDate: row.created_at,
    airlinePnr: validAirlinePnrs(row.airline_pnr.split(',')).join(', '),
    pnr: row.pnr,
    name: financialOnly
      ? 'Restricted'
      : leadName(
          row.lead_name,
          row.traveller_count || totalPassengers(row.passenger_counts)
        ),
    lifecycleAt: lifecycleTimestamp(row, status),
    fare: Number(row.fare) || 0,
    gross: Number.isFinite(Number(row.gross))
      ? Number(row.gross)
      : null,
    route: row.route,
    airline: row.airline,
    flyDate: row.fly_date,
    passengerType: passengerTypeLabel(row.passenger_counts),
    supplierPayable: Number.isFinite(Number(row.supplier_payable))
      ? Number(row.supplier_payable)
      : null,
    createdBy: financialOnly ? 'Restricted' : creatorLabel(row),
    status,
    statusMessage: customerStatusMessage({
      status,
      importSource: row.import_source,
      paymentState: row.payment_state,
      operationKind: row.operation_kind,
      operationReason: row.operation_reason,
    }),
    hiddenFromUser: row.hidden_from_user,
    isAgencyBooking: Boolean(row.agency_code),
  };
}

function lifecycleIndicator(
  lifecycle: StaffBookingLifecycle
): BookingLifecycleIndicator {
  return {
    operationKind: lifecycle.operation?.kind ?? null,
    operationState: lifecycle.operation?.state ?? null,
    operationElapsedSeconds: lifecycle.operation?.elapsedSeconds ?? null,
    reconciliationType: lifecycle.reconciliation?.type ?? null,
    reconciliationState: lifecycle.reconciliation?.state ?? null,
    assignedTeam: lifecycle.reconciliation?.assignedTeam ?? null,
    assigneeUserId: lifecycle.reconciliation?.assigneeUserId ?? null,
    dueAt: lifecycle.reconciliation?.dueAt ?? null,
    slaBreached: lifecycle.reconciliation?.slaBreached ?? false,
    evidenceIsFresh: lifecycle.reconciliation?.evidenceIsFresh ?? false,
    paymentConflictCode: lifecycle.payment.conflictCode,
    terminalConflict: lifecycle.flags.terminalConflict,
    attentionRequired: lifecycle.flags.staffAttentionRequired,
  };
}

export type DashboardBookingList = {
  bookings: BookingListRow[];
  total: number;
  loadError: boolean;
};

/** One server-paginated page of bookings this session may see. */
export async function listDashboardBookings(
  session: DashboardSession,
  query: BookingListQuery
): Promise<DashboardBookingList> {
  const startedAt = performance.now();
  const { rows, total, loadError } = await listBookingDashboardPage(
    bookingScopeFor(session),
    query
  );
  const piiAccess = bookingPiiAccessFor(session.role);
  const includeSupplierReference =
    bookingLifecycleAccessForRole(session.role) !== null;
  const lifecycleByReference = new Map<string, BookingLifecycleIndicator>();
  const ticketManagementReferencesByBookingId = new Map<
    string,
    TicketManagementRequestReference[]
  >();

  if (rows.length > 0) {
    try {
      const references = await listTicketManagementRequestReferencesForBookings(
        rows.map((row) => row.id)
      );
      for (const [bookingId, items] of Array.from(references.entries())) {
        ticketManagementReferencesByBookingId.set(bookingId, items);
      }
    } catch (error) {
      // Ticket Management references must not prevent the booking list from
      // loading if its optional read model is temporarily unavailable.
      console.error('[dashboard] Ticket Management references unavailable:', error);
    }
  }

  if (bookingLifecycleAccessForRole(session.role) && rows.length > 0) {
    try {
      const references = rows.map((row) => row.public_ref);
      const lifecycleRows = await listStaffBookingLifecycle(session.role, {
        publicRefs: references,
        limit: references.length,
      });
      for (const lifecycle of lifecycleRows) {
        lifecycleByReference.set(
          lifecycle.publicRef,
          lifecycleIndicator(lifecycle)
        );
      }
    } catch (error) {
      // Expand/contract rollout: bookings remain usable if the read-only
      // observability view has not reached this environment yet.
      console.error('[dashboard] lifecycle indicators unavailable:', error);
    }
  }

  const bookings = rows.map((row) => {
    const booking = toListRow(
      row,
      piiAccess,
      includeSupplierReference,
      ticketManagementReferencesByBookingId.get(row.id) ?? []
    );
    const indicator = lifecycleByReference.get(row.public_ref);
    return indicator ? { ...booking, lifecycleIndicator: indicator } : booking;
  });
  if (process.env.BOOKING_TIMING === '1') {
    console.info('[timing] booking-dashboard-render-data', {
      durationMs: Math.round(performance.now() - startedAt),
      role: session.role,
      pageSize: query.pageSize,
      returned: bookings.length,
      total,
    });
  }
  return { bookings, total, loadError };
}
