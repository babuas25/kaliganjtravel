import { NextRequest } from 'next/server';
import { after } from 'next/server';
import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  createTicketManagementRequest,
  listTicketManagementRequests,
} from '@/lib/db/ticket-management';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import {
  ticketManagementFail,
  ticketManagementOk,
  ticketManagementResultResponse,
} from '@/lib/ticket-management/http';
import { canCreateOwnTicketManagementRequest } from '@/lib/ticket-management/permissions';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';
import { ticketManagementActionsForBooking } from '@/lib/ticket-management/booking-actions';
import { dispatchPendingTicketManagementEmails } from '@/lib/email/ticket-management-delivery';
import {
  sanitizeTicketManagementResult,
  ticketManagementPayloadHash,
} from '@/lib/ticket-management/service';
import {
  TICKET_MANAGEMENT_ACTIONS,
  TICKET_MANAGEMENT_REQUEST_TYPES,
  TICKET_MANAGEMENT_STATUSES,
} from '@/lib/ticket-management/types';
import { isTicketVoidRequestOpen } from '@/lib/ticket-management/void-window';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  action: z.enum(TICKET_MANAGEMENT_ACTIONS),
  requestType: z.enum(TICKET_MANAGEMENT_REQUEST_TYPES),
  requestId: z.string().uuid(),
  passengerIndexes: z.array(z.number().int().min(0)).min(1).max(20),
  routeIndexes: z.array(z.number().int().min(0)).min(1).max(20),
  note: z.string().trim().max(2000).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.passengerIndexes).size !== value.passengerIndexes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['passengerIndexes'],
      message: 'Each passenger can be selected only once.',
    });
  }
  if (new Set(value.routeIndexes).size !== value.routeIndexes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['routeIndexes'],
      message: 'Each route can be selected only once.',
    });
  }
});

const listSchema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/).optional(),
  status: z.enum(TICKET_MANAGEMENT_STATUSES).optional(),
  action: z.enum(TICKET_MANAGEMENT_ACTIONS).optional(),
  requestType: z.enum(TICKET_MANAGEMENT_REQUEST_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return ticketManagementFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management is not enabled.'
    );
  }
  if (session.role === 'staff_media') {
    return ticketManagementFail(
      403,
      'TICKET_MANAGEMENT_READ_FORBIDDEN',
      'Ticket Management access is required.'
    );
  }
  const parsed = listSchema.safeParse({
    bookingReference: request.nextUrl.searchParams.get('bookingReference') ?? undefined,
    status: request.nextUrl.searchParams.get('status') ?? undefined,
    action: request.nextUrl.searchParams.get('action') ?? undefined,
    requestType: request.nextUrl.searchParams.get('requestType') ?? undefined,
    limit: request.nextUrl.searchParams.get('limit') ?? 50,
  });
  if (!parsed.success) {
    return ticketManagementFail(
      400,
      'INVALID_TICKET_MANAGEMENT_QUERY',
      'Check the request filters.'
    );
  }
  try {
    const { bookingReference, ...filters } = parsed.data;
    const booking = bookingReference
      ? await readBookingByPublicRef(bookingReference, bookingScopeFor(session))
      : null;
    if (bookingReference && !booking) {
      return ticketManagementOk([]);
    }
    const data = await listTicketManagementRequests({
      actor: {
        clerkId: session.clerkId,
        role: session.role,
        agencyCode: session.agencyCode,
      },
      ...filters,
      ...(booking ? { bookingId: booking.id } : {}),
    });
    return ticketManagementOk(data);
  } catch (error) {
    console.error('[ticket-management] list failed:', error);
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_READ_UNAVAILABLE',
      'Ticket Management requests are temporarily unavailable.'
    );
  }
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) {
    return ticketManagementFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management is not enabled.'
    );
  }
  if (!canCreateOwnTicketManagementRequest(session.role)) {
    return ticketManagementFail(
      403,
      'REQUEST_CREATE_FORBIDDEN',
      'Only a booking owner can create this request.'
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ticketManagementFail(
      400,
      'INVALID_TICKET_MANAGEMENT_REQUEST',
      parsed.error.issues[0]?.message ?? 'Check the request.'
    );
  }
  const limit = await checkActionLimit(
    'ticketManagementCustomer',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return ticketManagementFail(
      429,
      'TICKET_MANAGEMENT_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) {
    return ticketManagementFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  }
  const availableActions = ticketManagementActionsForBooking({
    status: booking.lifecycle_status ?? booking.status,
    directTicketing: booking.direct_ticketing,
    importSource: booking.import_source,
    bookingOrigin: booking.booking_origin,
  });
  if (!availableActions.includes(parsed.data.action)) {
    return ticketManagementFail(
      409,
      'TICKET_MANAGEMENT_ACTION_UNAVAILABLE',
      'This action is not available for the booking status or ticket source.'
    );
  }
  if (
    parsed.data.action === 'void' &&
    !isTicketVoidRequestOpen(booking.issued_at)
  ) {
    return ticketManagementFail(
      410,
      'VOID_REQUEST_WINDOW_CLOSED',
      'VOID requests are available only on the ticket issue date until 23:30 Bangladesh time.'
    );
  }
  const bookingLimit = await checkActionLimit(
    'ticketManagementCustomer',
    `booking:${booking.id}`
  );
  if (!bookingLimit.ok) {
    return ticketManagementFail(
      429,
      'TICKET_MANAGEMENT_RATE_LIMITED',
      rateLimitMessage(bookingLimit.retryAfterSeconds),
      { retryAfterSeconds: bookingLimit.retryAfterSeconds }
    );
  }
  const payload = {
    bookingId: booking.id,
    action: parsed.data.action,
    requestType: parsed.data.requestType,
    passengerIndexes: [...parsed.data.passengerIndexes].sort((a, b) => a - b),
    routeIndexes: [...parsed.data.routeIndexes].sort((a, b) => a - b),
    note: parsed.data.note ?? null,
  };
  const result = await createTicketManagementRequest({
    bookingId: booking.id,
    action: parsed.data.action,
    requestType: parsed.data.requestType,
    actorUserId: session.clerkId,
    requestKey: parsed.data.requestId,
    requestPayloadHash: ticketManagementPayloadHash(payload),
    passengerIndexes: payload.passengerIndexes,
    routeIndexes: payload.routeIndexes,
    note: payload.note,
  });
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'ticket_management.request.create',
    targetType: 'flight_booking',
    targetId: booking.id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      requestAction: parsed.data.action,
      requestType: parsed.data.requestType,
      passengerCount: parsed.data.passengerIndexes.length,
      routeCount: parsed.data.routeIndexes.length,
      replay: result.replay ?? false,
      failureCode: result.ok ? null : result.code ?? 'REQUEST_FAILED',
      walletMutation: false,
    },
  });
  if (!result.ok) return ticketManagementResultResponse(result);
  if (typeof result.requestId === 'string') {
    after(async () => {
      try {
        await dispatchPendingTicketManagementEmails(10, result.requestId as string);
      } catch (error) {
        console.error('[ticket-management] request email dispatch failed:', error);
      }
    });
  }
  const safe = sanitizeTicketManagementResult(result, session.role);
  return ticketManagementOk(safe, result.replay ? 200 : 201);
}
