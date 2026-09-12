import { NextRequest } from 'next/server';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import {
  readImportedTicketingResolutionContext,
  resolveImportedTicketing,
} from '@/lib/db/impexp';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { canAccessImpExp } from '@/lib/impexp/access';
import { isExternalBookingSource } from '@/lib/impexp/booking-source';
import { importedTicketingResolutionSchema } from '@/lib/impexp/ticketing-resolution';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MESSAGE: Record<string, string> = {
  IMPORTED_RESOLUTION_FORBIDDEN:
    'Only authorized Support, Admin, or Super Admin staff can resolve imported ticketing.',
  IMPORTED_BOOKING_NOT_FOUND: 'Imported booking not found.',
  IMPORTED_BOOKING_ALREADY_RESOLVED: 'This imported booking is already resolved.',
  IMPORTED_BOOKING_NOT_RESOLVABLE:
    'This booking is not in the imported In Progress ticketing state.',
  IMPORTED_OPERATION_NOT_FOUND:
    'The imported ticketing operation is incomplete and requires reconciliation.',
  IMPORTED_CASE_NOT_FOUND:
    'The imported ticketing audit case is incomplete and requires reconciliation.',
  IMPORTED_RESERVATION_NOT_FOUND:
    'The imported wallet reservation is missing. No wallet movement was made.',
  IMPORTED_MULTIPLE_RESERVATIONS:
    'More than one wallet reservation matches this booking.',
  IMPORTED_RESERVATION_ACCOUNT_CONFLICT:
    'The imported reservation, wallet owner, amount, or currency does not agree.',
  IMPORTED_ACTIVE_HOLD_CONFLICT:
    'The imported reservation and actual Hold balance do not agree.',
  IMPORTED_LEGACY_CAPTURE_CONFLICT:
    'The legacy capture, reservation, and ledger do not agree.',
  IMPORTED_RESERVATION_STATE_CONFLICT:
    'The imported reservation is neither an active Hold nor a proven legacy capture.',
  IMPORTED_EFFECT_CONFIRMATION_REQUIRED:
    'Confirm the exact displayed wallet effect before applying this resolution.',
  IMPORTED_TICKET_EVIDENCE_REQUIRED:
    'Enter one unique ticket number per passenger and a valid Issued Date & Time.',
  IMPORTED_CANCELLATION_DETAILS_REQUIRED:
    'Enter Cancellation Date & Time and a cancellation reason.',
  IMPORTED_REFUND_DECISION_REQUIRED:
    'This legacy captured booking requires Full Refund, Partial Refund, No Refund, or Externally Settled.',
  IMPORTED_PARTIAL_REFUND_INVALID:
    'The partial refund must be above zero and below the outstanding captured amount.',
  IMPORTED_EXTERNAL_REFERENCE_REQUIRED:
    'Enter the external settlement reference.',
  IMPORTED_NOTHING_TO_REFUND: 'There is no outstanding captured amount to refund.',
  IMPORTED_HOLD_BALANCE_MISMATCH:
    'The Hold balance changed. Refresh before resolving the booking.',
  IMPORTED_ACCOUNTING_STATE_CHANGED:
    'The wallet or reservation changed. Refresh before resolving the booking.',
  IMPORTED_RESOLUTION_IDEMPOTENCY_CONFLICT:
    'This request identity was already used for a different resolution.',
};

function message(code: string | undefined): string {
  return (
    MESSAGE[code ?? ''] ??
    'The imported ticketing resolution was blocked because its accounting state is not safe.'
  );
}

function status(code: string | undefined): number {
  if (code === 'IMPORTED_RESOLUTION_FORBIDDEN') return 403;
  if (code === 'IMPORTED_BOOKING_NOT_FOUND') return 404;
  return 409;
}

async function authorized(reference: string) {
  const session = await getDashboardSession();
  if (!session) {
    return { response: walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.') };
  }
  if (!canAccessImpExp(session.role)) {
    return {
      response: walletFail(
        403,
        'IMPORTED_RESOLUTION_FORBIDDEN',
        MESSAGE.IMPORTED_RESOLUTION_FORBIDDEN,
      ),
    };
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return {
      response: walletFail(
        400,
        'INVALID_BOOKING_REFERENCE',
        'Check the booking reference.',
      ),
    };
  }
  const booking = await readBookingByPublicRef(reference, bookingScopeFor(session));
  if (!booking || !isExternalBookingSource(booking.import_source)) {
    return {
      response: walletFail(
        404,
        'IMPORTED_BOOKING_NOT_FOUND',
        MESSAGE.IMPORTED_BOOKING_NOT_FOUND,
      ),
    };
  }
  return { session, booking };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const { reference } = await params;
  const resolved = await authorized(reference);
  if (resolved.response) return resolved.response;
  const { session, booking } = resolved;
  try {
    const context = await readImportedTicketingResolutionContext({
      actorUserId: session.clerkId,
      bookingId: booking.id,
    });
    if (!context.ok) {
      return walletFail(
        status(context.code),
        context.code,
        message(context.code),
      );
    }
    return walletOk({ context });
  } catch (error) {
    console.error('[impexp] ticketing resolution context failed:', error);
    return walletFail(
      503,
      'STORAGE_ERROR',
      'Imported ticketing context is unavailable.',
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const { reference } = await params;
  const resolved = await authorized(reference);
  if (resolved.response) return resolved.response;
  const { session, booking } = resolved;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = importedTicketingResolutionSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_IMPORTED_RESOLUTION_REQUEST',
      parsed.error.issues[0]?.message ?? 'Check the resolution details.',
    );
  }
  const limit = await checkActionLimit(
    'manualBookingStatus',
    `user:${session.clerkId}`,
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
    );
  }
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.imported.ticketing_resolution',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      bookingReference: booking.public_ref,
      importSource: booking.import_source,
      decision: parsed.data.decision,
      requestId: parsed.data.requestId,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The resolution could not be audited and was not executed.',
    );
  }
  try {
    const result = await resolveImportedTicketing({
      actorUserId: session.clerkId,
      bookingId: booking.id,
      resolution: parsed.data,
    });
    if (!result.ok) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: 'failed',
        metadata: { ...audit.metadata, failureCode: result.code ?? 'UNKNOWN' },
      });
      return walletFail(status(result.code), result.code ?? 'CONFLICT', message(result.code));
    }
    try {
      await dispatchBookingStatusEmails(booking.id);
    } catch (emailError) {
      console.error(
        '[impexp] resolution committed; email dispatch deferred:',
        emailError,
      );
    }
    return walletOk({ result });
  } catch (error) {
    console.error('[impexp] ticketing resolution failed:', error);
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: { ...audit.metadata, failureCode: 'STORAGE_ERROR' },
    });
    return walletFail(
      503,
      'STORAGE_ERROR',
      'The resolution was not committed. No booking or wallet change was made.',
    );
  }
}
