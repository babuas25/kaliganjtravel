import 'server-only';

import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';
import type {
  TicketManagementAction,
  TicketManagementRequestReference,
  TicketManagementRequestType,
  TicketManagementStatus,
} from '@/lib/ticket-management/types';

export type TicketManagementRpcResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  requestId?: string;
  publicRef?: string;
  status?: string;
  version?: number;
  [key: string]: unknown;
};

export type TicketManagementReadActor = {
  clerkId: string;
  role: Role;
  agencyCode: string | null;
};

export type TicketManagementPassengerAvailability = {
  passengerIndex: number;
  available: boolean;
  reasonCode:
    | 'ACTIVE_REQUEST'
    | 'REFUNDED'
    | 'VOIDED'
    | 'REISSUED'
    | 'UNAVAILABLE'
    | null;
  message: string | null;
};

type JsonRecord = Record<string, unknown>;

const STAFF_READ_ROLES = new Set<Role>([
  'staff_support',
  'staff_account',
  'admin',
  'superadmin',
]);

const CUSTOMER_EVENT_TYPES = new Set([
  'requested',
  'accepted',
  'staff-rejected',
  'quotation-published',
  'customer-approved',
  'customer-rejected',
  'confirmation-expired',
  'requote-started',
]);

/**
 * Returns screen-only, customer-safe request references for bookings that the
 * caller has already authorized. Do not call with unscoped booking ids.
 */
export async function listTicketManagementRequestReferencesForBookings(
  bookingIds: readonly string[]
): Promise<Map<string, TicketManagementRequestReference[]>> {
  const references = new Map<string, TicketManagementRequestReference[]>();
  const uniqueIds = Array.from(new Set(bookingIds.filter(Boolean)));
  if (uniqueIds.length === 0) return references;

  const supabase = supabaseAdmin();
  if (!supabase) return references;
  const { data, error } = await supabase
    .from('ticket_management_requests')
    .select('booking_id,action,public_ref,status,terminal_outcome,created_at')
    .in('booking_id', uniqueIds)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const bookingId = typeof row.booking_id === 'string' ? row.booking_id : null;
    const action = row.action;
    const publicRef = typeof row.public_ref === 'string' ? row.public_ref : null;
    const status = row.status;
    const terminalOutcome =
      typeof row.terminal_outcome === 'string' ? row.terminal_outcome : null;
    if (
      !bookingId ||
      !publicRef ||
      !['refund', 'reissue', 'void'].includes(String(action)) ||
      !['requested', 'in-progress', 'awaiting-confirmation', 'approved', 'completed', 'rejected', 'expired'].includes(String(status))
    ) {
      continue;
    }
    const items = references.get(bookingId) ?? [];
    items.push({
      action: action as TicketManagementAction,
      publicRef,
      status: status as TicketManagementStatus,
      terminalOutcome:
        terminalOutcome === 'staff-rejected' ||
        terminalOutcome === 'customer-rejected' ||
        terminalOutcome === 'confirmation-expired' ||
        terminalOutcome === 'refunded' ||
        terminalOutcome === 'reissued' ||
        terminalOutcome === 'voided'
          ? terminalOutcome
          : null,
    });
    references.set(bookingId, items);
  }
  return references;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function databaseErrorCode(message: string): string {
  for (const code of [
    'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE',
    'VOID_REQUEST_WINDOW_CLOSED',
    'TICKET_MANAGEMENT_ACTION_UNAVAILABLE',
    'selected passenger entitlement is unavailable',
    'selected passenger entitlement is already claimed',
    'selected route is unavailable',
  ]) {
    if (message.includes(code)) {
      if (code === 'selected route is unavailable') return 'INVALID_ROUTE_SELECTION';
      return code.startsWith('selected') ? 'ENTITLEMENT_UNAVAILABLE' : code;
    }
  }
  return 'STORAGE_ERROR';
}

async function callTicketManagementRpc(
  name: string,
  args: Record<string, unknown>
): Promise<TicketManagementRpcResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`[db] Ticket Management ${name} failed:`, error.message);
    return { ok: false, code: databaseErrorCode(error.message) };
  }
  const result = record(data);
  return result
    ? (result as TicketManagementRpcResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

export function createTicketManagementRequest(input: {
  bookingId: string;
  action: TicketManagementAction;
  actorUserId: string;
  requestKey: string;
  requestPayloadHash: string;
  passengerIndexes: number[];
  routeIndexes: number[];
  requestType: TicketManagementRequestType;
  note?: string | null;
}) {
  return callTicketManagementRpc('create_ticket_management_request_v4', {
    p_booking_id: input.bookingId,
    p_action: input.action,
    p_actor_user_id: input.actorUserId,
    p_request_key: input.requestKey,
    p_request_payload_hash: input.requestPayloadHash,
    p_passenger_indexes: input.passengerIndexes,
    p_route_indexes: input.routeIndexes,
    p_request_type: input.requestType,
    p_note: input.note ?? null,
  });
}

export function reviewTicketManagementRequest(input: {
  requestId: string;
  decision: 'accept' | 'reject';
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  note?: string | null;
}) {
  return callTicketManagementRpc('review_ticket_management_request_v1', {
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_note: input.note ?? null,
  });
}

export function publishTicketManagementQuote(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  action: TicketManagementAction;
  direction: 'credit' | 'debit' | 'none';
  currency: string;
  userPayableEntitlementAmount: number;
  fareDifference: number;
  airlineFee: number;
  voidFee: number;
  serviceFee: number;
  customerAmount: number;
  confirmationDeadlineAt: string;
  details?: string | null;
  reissueFareDifferenceAllocations?: Array<{
    entitlementId: string;
    fareDifferenceAmount: number;
  }>;
}) {
  if (input.action === 'reissue') {
    return callTicketManagementRpc(
      'publish_ticket_management_reissue_quote_v2',
      {
        p_request_id: input.requestId,
        p_actor_user_id: input.actorUserId,
        p_expected_version: input.expectedVersion,
        p_request_key: input.requestKey,
        p_direction: input.direction,
        p_currency: input.currency,
        p_fare_difference: input.fareDifference,
        p_airline_fee: input.airlineFee,
        p_service_fee: input.serviceFee,
        p_customer_amount: input.customerAmount,
        p_confirmation_deadline_at: input.confirmationDeadlineAt,
        p_fare_difference_allocations:
          input.reissueFareDifferenceAllocations ?? [],
        p_details: input.details ?? null,
      }
    );
  }
  return callTicketManagementRpc('publish_ticket_management_quote_v2', {
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_direction: input.direction,
    p_currency: input.currency,
    p_user_payable_entitlement_amount:
      input.userPayableEntitlementAmount,
    p_fare_difference: input.fareDifference,
    p_airline_fee: input.airlineFee,
    p_void_fee: input.voidFee,
    p_service_fee: input.serviceFee,
    p_customer_amount: input.customerAmount,
    p_confirmation_deadline_at: input.confirmationDeadlineAt,
    p_details: input.details ?? null,
  });
}

export function decideTicketManagementQuote(input: {
  requestId: string;
  quoteId: string;
  decision: 'approved' | 'rejected';
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  note?: string | null;
}) {
  return callTicketManagementRpc('decide_ticket_management_quote_v2', {
    p_request_id: input.requestId,
    p_quote_id: input.quoteId,
    p_decision: input.decision,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_note: input.note ?? null,
  });
}

export function reopenTicketManagementRequest(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}) {
  return callTicketManagementRpc('reopen_ticket_management_request_v1', {
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_reason: input.reason,
  });
}

export function assignTicketManagementSettlement(input: {
  requestId: string;
  assigneeUserId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  reason?: string | null;
}) {
  return callTicketManagementRpc('assign_ticket_management_settlement_v1', {
    p_request_id: input.requestId,
    p_assignee_user_id: input.assigneeUserId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_reason: input.reason ?? null,
  });
}

export function completeTicketManagementRefund(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  note?: string | null;
}) {
  return callTicketManagementRpc('complete_ticket_management_refund_v2', {
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_note: input.note ?? null,
  });
}

export function completeTicketManagementReissue(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  newTickets: Array<{
    predecessorEntitlementId: string;
    newTicketNumber: string;
    fareDifferenceAmount: number;
  }>;
  note?: string | null;
}) {
  return callTicketManagementRpc('complete_ticket_management_reissue_v2', {
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_new_tickets: input.newTickets,
    p_note: input.note ?? null,
  });
}

export function releaseAndReopenTicketManagementReissue(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}) {
  return callTicketManagementRpc(
    'release_and_reopen_ticket_management_reissue_v2',
    {
      p_request_id: input.requestId,
      p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    }
  );
}

export function completeTicketManagementVoid(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  note?: string | null;
}) {
  return callTicketManagementRpc('complete_ticket_management_void_v2', {
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_request_key: input.requestKey,
    p_note: input.note ?? null,
  });
}

export function releaseAndReopenTicketManagementVoid(input: {
  requestId: string;
  actorUserId: string;
  expectedVersion: number;
  requestKey: string;
  reason: string;
}) {
  return callTicketManagementRpc(
    'release_and_reopen_ticket_management_void_v2',
    {
      p_request_id: input.requestId,
      p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    }
  );
}

export function expireTicketManagementQuotes(limit = 200) {
  return callTicketManagementRpc('expire_ticket_management_quotes_v1', {
    p_limit: limit,
  });
}

function requestOwnedBy(row: JsonRecord, actor: TicketManagementReadActor) {
  if (
    actor.role === 'customer' &&
    row.booking_owner_type === 'user' &&
    row.booking_owner_key === actor.clerkId
  ) {
    return true;
  }
  return (
    (actor.role === 'b2b' || actor.role === 'b2b_sub') &&
    Boolean(actor.agencyCode) &&
    row.booking_owner_type === 'agency' &&
    row.booking_owner_key === actor.agencyCode
  );
}

/**
 * Returns only request-form eligibility. Ticket numbers, amounts, and internal
 * entitlement identifiers deliberately stay server-side.
 */
export async function listTicketManagementPassengerAvailability(
  bookingId: string
): Promise<TicketManagementPassengerAvailability[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management storage is unavailable.');
  const entitlementResult = await supabase
    .from('ticket_management_ticket_entitlements')
    .select('id,passenger_index,state,entitlement_amount,consumed_amount,created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false });
  if (entitlementResult.error) throw new Error(entitlementResult.error.message);
  const entitlements = (entitlementResult.data ?? []) as JsonRecord[];
  const entitlementIds = entitlements
    .map((row) => row.id)
    .filter((value): value is string => typeof value === 'string');

  const activeClaims = new Map<string, JsonRecord>();
  if (entitlementIds.length > 0) {
    const claimsResult = await supabase
      .from('ticket_management_entitlement_claims')
      .select('entitlement_id,request_id,state')
      .in('entitlement_id', entitlementIds)
      .eq('state', 'active');
    if (claimsResult.error) throw new Error(claimsResult.error.message);
    for (const claim of (claimsResult.data ?? []) as JsonRecord[]) {
      if (typeof claim.entitlement_id === 'string') {
        activeClaims.set(claim.entitlement_id, claim);
      }
    }
  }

  const requestActions = new Map<string, string>();
  const requestIds = Array.from(activeClaims.values())
    .map((claim) => claim.request_id)
    .filter((value): value is string => typeof value === 'string');
  if (requestIds.length > 0) {
    const requestsResult = await supabase
      .from('ticket_management_requests')
      .select('id,action')
      .in('id', requestIds);
    if (requestsResult.error) throw new Error(requestsResult.error.message);
    for (const request of (requestsResult.data ?? []) as JsonRecord[]) {
      if (typeof request.id === 'string' && typeof request.action === 'string') {
        requestActions.set(request.id, request.action);
      }
    }
  }

  const byPassenger = new Map<number, JsonRecord[]>();
  for (const entitlement of entitlements) {
    const passengerIndex = Number(entitlement.passenger_index);
    if (!Number.isInteger(passengerIndex) || passengerIndex < 0) continue;
    const rows = byPassenger.get(passengerIndex) ?? [];
    rows.push(entitlement);
    byPassenger.set(passengerIndex, rows);
  }

  return Array.from(byPassenger.entries())
    .sort(([left], [right]) => left - right)
    .map(([passengerIndex, rows]) => {
      const usable = rows.find((row) =>
        row.state === 'active' &&
        Number(row.consumed_amount) < Number(row.entitlement_amount)
      );
      if (usable && typeof usable.id === 'string') {
        const claim = activeClaims.get(usable.id);
        if (!claim) {
          return { passengerIndex, available: true, reasonCode: null, message: null };
        }
        const action = typeof claim.request_id === 'string'
          ? requestActions.get(claim.request_id)
          : null;
        const label = action === 'void'
          ? 'VOID'
          : action === 'reissue'
            ? 'Reissue'
            : 'Refund';
        return {
          passengerIndex,
          available: false,
          reasonCode: 'ACTIVE_REQUEST' as const,
          message: `This ticket is already included in an active ${label} request.`,
        };
      }

      const terminalState = rows.find((row) =>
        ['refunded', 'voided', 'reissued'].includes(String(row.state))
      )?.state;
      if (terminalState === 'refunded') {
        return {
          passengerIndex,
          available: false,
          reasonCode: 'REFUNDED' as const,
          message: 'This airline ticket has already been refunded and cannot be managed again.',
        };
      }
      if (terminalState === 'voided') {
        return {
          passengerIndex,
          available: false,
          reasonCode: 'VOIDED' as const,
          message: 'This airline ticket has already been voided and cannot be managed again.',
        };
      }
      if (terminalState === 'reissued') {
        return {
          passengerIndex,
          available: false,
          reasonCode: 'REISSUED' as const,
          message: 'This ticket was reissued, but its replacement ticket is not available for another request.',
        };
      }
      return {
        passengerIndex,
        available: false,
        reasonCode: 'UNAVAILABLE' as const,
        message: 'This airline ticket is no longer available for another request.',
      };
    });
}

export async function listTicketManagementRequests(input: {
  actor: TicketManagementReadActor;
  bookingId?: string;
  status?: TicketManagementStatus;
  action?: TicketManagementAction;
  requestType?: TicketManagementRequestType;
  limit: number;
}) {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management storage is unavailable.');
  const staff = STAFF_READ_ROLES.has(input.actor.role);
  let query = supabase
    .from('ticket_management_requests')
    .select(
      'id,public_ref,booking_id,action,request_type,status,terminal_outcome,version,booking_owner_type,booking_owner_key,currency,active_quote_id,approved_quote_id,active_assignee_user_id,active_assignee_role,status_changed_at,created_at,updated_at'
    )
    .order('created_at', { ascending: false })
    .limit(input.limit);
  if (!staff) {
    if (input.actor.role === 'customer') {
      query = query
        .eq('booking_owner_type', 'user')
        .eq('booking_owner_key', input.actor.clerkId);
    } else if (
      (input.actor.role === 'b2b' || input.actor.role === 'b2b_sub') &&
      input.actor.agencyCode
    ) {
      query = query
        .eq('booking_owner_type', 'agency')
        .eq('booking_owner_key', input.actor.agencyCode);
    } else {
      return [];
    }
  }
  if (input.status) query = query.eq('status', input.status);
  if (input.action) query = query.eq('action', input.action);
  if (input.requestType) query = query.eq('request_type', input.requestType);
  if (input.bookingId) query = query.eq('booking_id', input.bookingId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as JsonRecord[];
  const bookingIds = rows
    .map((row) => row.booking_id)
    .filter((value): value is string => typeof value === 'string');
  const requestIds = rows
    .map((row) => row.id)
    .filter((value): value is string => typeof value === 'string');
  const bookings = new Map<string, JsonRecord>();
  if (bookingIds.length > 0) {
    const bookingResult = await supabase
      .from('flight_bookings')
      .select(
        'id,public_ref,itinerary,travel_date,issued_at,pricing_snapshot,supplier_gross_amount,user_payable_amount,currency'
      )
      .in('id', bookingIds);
    if (bookingResult.error) throw new Error(bookingResult.error.message);
    for (const booking of (bookingResult.data ?? []) as JsonRecord[]) {
      if (typeof booking.id === 'string') bookings.set(booking.id, booking);
    }
  }

  const passengersByRequest = new Map<string, JsonRecord[]>();
  const latestEventByRequest = new Map<string, JsonRecord>();
  if (requestIds.length > 0) {
    const [selectionsResult, eventsResult] = await Promise.all([
      supabase
        .from('ticket_management_request_selections')
        .select(
          'request_id,passenger_index,passenger_name,passenger_type,ticket_number_snapshot'
        )
        .in('request_id', requestIds)
        .order('passenger_index'),
      supabase
        .from('ticket_management_request_events')
        .select(
          'request_id,occurrence_number,actor_user_id,actor_role,effective_at'
        )
        .in('request_id', requestIds)
        .order('occurrence_number', { ascending: false }),
    ]);
    if (selectionsResult.error) throw new Error(selectionsResult.error.message);
    if (eventsResult.error) throw new Error(eventsResult.error.message);

    for (const selection of (selectionsResult.data ?? []) as JsonRecord[]) {
      if (typeof selection.request_id !== 'string') continue;
      const current = passengersByRequest.get(selection.request_id) ?? [];
      current.push(selection);
      passengersByRequest.set(selection.request_id, current);
    }
    for (const event of (eventsResult.data ?? []) as JsonRecord[]) {
      if (
        typeof event.request_id === 'string' &&
        !latestEventByRequest.has(event.request_id)
      ) {
        latestEventByRequest.set(event.request_id, event);
      }
    }
  }

  const agencyNames = new Map<string, string>();
  if (staff) {
    const agencyCodes = Array.from(new Set(
      rows
        .filter((row) => row.booking_owner_type === 'agency')
        .map((row) => row.booking_owner_key)
        .filter((value): value is string =>
          typeof value === 'string' && value.trim().length > 0
        )
    ));
    if (agencyCodes.length > 0) {
      const agenciesResult = await supabase
        .from('agencies')
        .select('agency_code,owner_user_id')
        .in('agency_code', agencyCodes);
      if (agenciesResult.error) {
        console.error(
          '[db] Ticket Management agency lookup failed:',
          agenciesResult.error.message
        );
      } else {
        const agencies = (agenciesResult.data ?? []) as JsonRecord[];
        const ownerIds = Array.from(new Set(
          agencies
            .map((agency) => agency.owner_user_id)
            .filter((value): value is string => typeof value === 'string')
        ));
        const profilesResult = ownerIds.length > 0
          ? await supabase
              .from('user_profiles')
              .select('clerk_id,agency_name')
              .in('clerk_id', ownerIds)
          : { data: [] as JsonRecord[], error: null };
        if (profilesResult.error) {
          console.error(
            '[db] Ticket Management agency profile lookup failed:',
            profilesResult.error.message
          );
        } else {
          const namesByOwner = new Map(
            ((profilesResult.data ?? []) as JsonRecord[]).flatMap((profile) =>
              typeof profile.clerk_id === 'string' &&
              typeof profile.agency_name === 'string' &&
              profile.agency_name.trim()
                ? [[profile.clerk_id, profile.agency_name.trim()] as const]
                : []
            )
          );
          for (const agency of agencies) {
            if (typeof agency.agency_code !== 'string') continue;
            const ownerId = typeof agency.owner_user_id === 'string'
              ? agency.owner_user_id
              : null;
            const name = ownerId ? namesByOwner.get(ownerId) : null;
            if (name) agencyNames.set(agency.agency_code, name);
          }
        }
      }
    }
  }

  const actorNames = new Map<string, string>();
  if (staff && latestEventByRequest.size > 0) {
    const actorIds = Array.from(
      new Set(
        Array.from(latestEventByRequest.values())
          .map((event) => event.actor_user_id)
          .filter((value): value is string => typeof value === 'string')
      )
    );
    if (actorIds.length > 0) {
      const usersResult = await supabase
        .from('app_users')
        .select('clerk_id,first_name,last_name,email')
        .in('clerk_id', actorIds);
      if (usersResult.error) {
        console.error(
          '[db] Ticket Management updater lookup failed:',
          usersResult.error.message
        );
      } else {
        for (const user of (usersResult.data ?? []) as JsonRecord[]) {
          if (typeof user.clerk_id !== 'string') continue;
          const name = [user.first_name, user.last_name]
            .filter((value): value is string =>
              typeof value === 'string' && value.trim().length > 0
            )
            .join(' ')
            .trim();
          const email = typeof user.email === 'string' ? user.email : '';
          actorNames.set(user.clerk_id, name || email || 'Staff');
        }
      }
    }
  }

  function roleLabel(value: unknown): string {
    if (value === 'superadmin') return 'Super Admin';
    if (value === 'admin') return 'Admin';
    if (value === 'staff_support') return 'Support Team';
    if (value === 'staff_account') return 'Accounts Team';
    if (value === 'b2b') return 'B2B Partner';
    if (value === 'b2b_sub') return 'Sub User';
    if (value === 'customer') return 'Customer';
    return 'System';
  }

  return rows.map((row) => ({
    ...(() => {
      const booking =
        typeof row.booking_id === 'string'
          ? bookings.get(row.booking_id) ?? null
          : null;
      const itinerary = record(booking?.itinerary);
      const pricing = record(booking?.pricing_snapshot);
      const carrierName =
        typeof itinerary?.carrierName === 'string' && itinerary.carrierName.trim()
          ? itinerary.carrierName.trim()
          : null;
      const carrierCode =
        typeof itinerary?.carrierCode === 'string' && itinerary.carrierCode.trim()
          ? itinerary.carrierCode.trim().toUpperCase()
          : null;
      const latestEvent =
        typeof row.id === 'string' ? latestEventByRequest.get(row.id) : undefined;
      const updaterRole = latestEvent?.actor_role;
      const updaterName =
        staff && typeof latestEvent?.actor_user_id === 'string'
          ? actorNames.get(latestEvent.actor_user_id)
          : null;
      const restrictedPassengers = input.actor.role === 'staff_account';
      const selections =
        typeof row.id === 'string' ? passengersByRequest.get(row.id) ?? [] : [];
      const grossFromSnapshot = Number(pricing?.grossPrice);
      const userPayableFromSnapshot = Number(pricing?.sellingPrice);
      const grossFare = Number.isFinite(grossFromSnapshot) && grossFromSnapshot >= 0
        ? Math.round(grossFromSnapshot * 100)
        : booking?.supplier_gross_amount !== null &&
            booking?.supplier_gross_amount !== undefined &&
            Number.isFinite(Number(booking.supplier_gross_amount))
          ? Number(booking.supplier_gross_amount)
          : null;
      const userPayable =
        Number.isFinite(userPayableFromSnapshot) && userPayableFromSnapshot >= 0
          ? Math.round(userPayableFromSnapshot * 100)
          : booking?.user_payable_amount !== null &&
              booking?.user_payable_amount !== undefined &&
              Number.isFinite(Number(booking.user_payable_amount))
            ? Number(booking.user_payable_amount)
            : null;
      const agencyId =
        staff && row.booking_owner_type === 'agency' &&
        typeof row.booking_owner_key === 'string'
          ? row.booking_owner_key
          : null;
      return {
        agencyName: agencyId ? agencyNames.get(agencyId) ?? null : null,
        agencyId,
        bookingReference:
          typeof booking?.public_ref === 'string' ? booking.public_ref : null,
        airline: carrierName ?? carrierCode,
        airlineCode: carrierCode,
        flightDate:
          typeof booking?.travel_date === 'string' ? booking.travel_date : null,
        issuedAt:
          typeof booking?.issued_at === 'string' ? booking.issued_at : null,
        passengerDetails: restrictedPassengers
          ? selections.length > 0
            ? [{
                passengerName: 'Restricted',
                passengerType: 'Passenger',
                ticketNumber: null,
              }]
            : []
          : selections.map((selection) => ({
              passengerName:
                typeof selection.passenger_name === 'string'
                  ? selection.passenger_name
                  : 'Passenger',
              passengerType:
                typeof selection.passenger_type === 'string'
                  ? selection.passenger_type
                  : '—',
              ticketNumber:
                typeof selection.ticket_number_snapshot === 'string'
                  ? selection.ticket_number_snapshot
                  : null,
            })),
        grossFare: input.actor.role === 'customer' ? null : grossFare,
        userPayable,
        updatedBy: updaterName ?? roleLabel(updaterRole),
        updatedByRole:
          typeof updaterRole === 'string' ? roleLabel(updaterRole) : null,
      };
    })(),
    id: row.id,
    publicRef: row.public_ref,
    action: row.action,
    requestType: row.request_type,
    status: row.status,
    terminalOutcome: row.terminal_outcome,
    version: row.version,
    currency: row.currency,
    activeQuoteId: row.active_quote_id,
    approvedQuoteId: row.approved_quote_id,
    ...(staff
      ? {
          assigneeUserId: row.active_assignee_user_id,
          assigneeRole: row.active_assignee_role,
        }
      : {}),
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function customerEventMetadata(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  const safe: JsonRecord = {};
  for (const key of [
    'quoteId',
    'quoteVersion',
    'confirmationDeadlineAt',
    'deadline',
    'outcome',
    'amount',
  ]) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return safe;
}

export async function readTicketManagementRequestDetail(
  requestId: string,
  actor: TicketManagementReadActor
) {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management storage is unavailable.');
  const requestResult = await supabase
    .from('ticket_management_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (requestResult.error) throw new Error(requestResult.error.message);
  const request = record(requestResult.data);
  if (!request) return null;
  const staff = STAFF_READ_ROLES.has(actor.role);
  if (!staff && !requestOwnedBy(request, actor)) return null;

  const [
    bookingResult,
    selectionsResult,
    routesResult,
    quotesResult,
    decisionsResult,
    eventsResult,
    reissueAllocationsResult,
  ] =
    await Promise.all([
      supabase
        .from('flight_bookings')
        .select('public_ref')
        .eq('id', request.booking_id)
        .maybeSingle(),
      supabase
        .from('ticket_management_request_selections')
        .select('*')
        .eq('request_id', requestId)
        .order('passenger_index'),
      supabase
        .from('ticket_management_request_routes')
        .select('*')
        .eq('request_id', requestId)
        .order('route_index'),
      supabase
        .from('ticket_management_quotes')
        .select('*')
        .eq('request_id', requestId)
        .order('quote_version'),
      supabase
        .from('ticket_management_customer_decisions')
        .select('*')
        .eq('request_id', requestId)
        .order('decided_at'),
      supabase
        .from('ticket_management_request_events')
        .select('*')
        .eq('request_id', requestId)
        .order('occurrence_number'),
      staff
        ? supabase
            .from('ticket_management_reissue_quote_allocations')
            .select('quote_id,entitlement_id,passenger_index,fare_difference_amount')
            .eq('request_id', requestId)
            .order('passenger_index')
        : Promise.resolve({ data: [], error: null }),
    ]);
  for (const result of [
    bookingResult,
    selectionsResult,
    routesResult,
    quotesResult,
    decisionsResult,
    eventsResult,
    reissueAllocationsResult,
  ]) {
    if (result.error) throw new Error(result.error.message);
  }
  const selections = (selectionsResult.data ?? []) as JsonRecord[];
  const routes = (routesResult.data ?? []) as JsonRecord[];
  const quotes = (quotesResult.data ?? []) as JsonRecord[];
  const decisions = (decisionsResult.data ?? []) as JsonRecord[];
  const events = (eventsResult.data ?? []) as JsonRecord[];
  const reissueAllocations = (reissueAllocationsResult.data ?? []) as JsonRecord[];
  const common = {
    id: request.id,
    publicRef: request.public_ref,
    bookingReference: record(bookingResult.data)?.public_ref ?? null,
    action: request.action,
    requestType: request.request_type,
    status: request.status,
    terminalOutcome: request.terminal_outcome,
    version: request.version,
    currency: request.currency,
    requestNote: request.request_note,
    activeQuoteId: request.active_quote_id,
    approvedQuoteId: request.approved_quote_id,
    statusChangedAt: request.status_changed_at,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
    passengers: selections.map((selection) => ({
      passengerIndex: selection.passenger_index,
      passengerName: selection.passenger_name,
      passengerType: selection.passenger_type,
      ticketNumber: selection.ticket_number_snapshot,
      ...(staff
        ? {
            entitlementId: selection.entitlement_id,
            entitlementAmount: selection.entitlement_amount_snapshot,
          }
        : {}),
    })),
    routes: routes.map((route) => ({
      routeIndex: route.route_index,
      label: route.route_label,
      origin: route.origin_code,
      destination: route.destination_code,
      departureAt: route.departure_at,
    })),
    quotes: quotes.map((quote) => ({
      id: quote.id,
      quoteVersion: quote.quote_version,
      currency: quote.currency,
      direction: quote.direction,
      userPayableEntitlementAmount: quote.user_payable_entitlement_amount,
      fareDifference: quote.fare_difference,
      airlineFee: quote.airline_fee,
      voidFee: quote.void_fee,
      serviceFee: quote.service_fee,
      customerAmount: quote.customer_amount,
      details: quote.details,
      confirmationDeadlineAt: quote.confirmation_deadline_at,
      publishedAt: quote.published_at,
      ...(staff
        ? {
            supplierGrossAmount: quote.supplier_gross_amount,
            supplierPayableAmount: quote.supplier_payable_amount,
            quoteHash: quote.quote_hash,
            publishedByUserId: quote.published_by_user_id,
            publishedByRole: quote.published_by_role,
            fareDifferenceAllocations: reissueAllocations
              .filter((allocation) => allocation.quote_id === quote.id)
              .map((allocation) => ({
                entitlementId: allocation.entitlement_id,
                passengerIndex: allocation.passenger_index,
                fareDifferenceAmount: allocation.fare_difference_amount,
              })),
          }
        : {}),
    })),
    decisions: decisions.map((decision) => ({
      decision: decision.decision,
      quoteId: decision.quote_id,
      decidedAt: decision.decided_at,
      ...(staff
        ? {
            decidedByUserId: decision.decided_by_user_id,
            decidedByRole: decision.decided_by_role,
          }
        : {}),
    })),
  };
  if (!staff) {
    return {
      ...common,
      events: events
        .filter((event) => CUSTOMER_EVENT_TYPES.has(String(event.event_type)))
        .map((event) => ({
          eventType: event.event_type,
          fromStatus: event.from_status,
          toStatus: event.to_status,
          effectiveAt: event.effective_at,
          metadata: customerEventMetadata(event.metadata),
        })),
    };
  }

  const [assignmentsResult, lineagesResult] = await Promise.all([
    supabase
      .from('ticket_management_assignments')
      .select('*')
      .eq('request_id', requestId)
      .order('assigned_at'),
    supabase
      .from('ticket_management_reissue_lineages')
      .select('*')
      .eq('request_id', requestId)
      .order('passenger_index'),
  ]);
  if (assignmentsResult.error) throw new Error(assignmentsResult.error.message);
  if (lineagesResult.error) throw new Error(lineagesResult.error.message);
  return {
    ...common,
    assigneeUserId: request.active_assignee_user_id,
    assigneeRole: request.active_assignee_role,
    walletResults: {
      holdLedgerEntryId: request.hold_ledger_entry_id,
      captureLedgerEntryId: request.capture_ledger_entry_id,
      releaseLedgerEntryId: request.release_ledger_entry_id,
      creditLedgerEntryId: request.credit_ledger_entry_id,
    },
    assignments: assignmentsResult.data ?? [],
    ticketLineage: lineagesResult.data ?? [],
    events: events.map((event) => ({
      eventType: event.event_type,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      requestVersion: event.request_version,
      actorUserId: event.actor_user_id,
      actorRole: event.actor_role,
      note: event.note,
      metadata: event.metadata,
      effectiveAt: event.effective_at,
    })),
  };
}

export async function listTicketManagementFinancialAssignees() {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management storage is unavailable.');
  const { data, error } = await supabase
    .from('app_users')
    .select('clerk_id,first_name,last_name,email,role')
    .in('role', ['staff_account', 'admin', 'superadmin'])
    .order('first_name')
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as JsonRecord[]).map((user) => ({
    userId: user.clerk_id,
    name:
      [user.first_name, user.last_name]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(' ') || user.email || 'Financial staff',
    role: user.role,
  }));
}
