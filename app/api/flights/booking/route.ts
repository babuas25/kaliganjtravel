import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { createOperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import { classifySupplierWriteFailure } from '@/lib/booking-lifecycle/supplier-uncertainty';
import { bookingAttemptSupplierWriteHooks } from '@/lib/booking-lifecycle/supplier-write-hooks';
import {
  claimBookingAttempt,
  readBookingAttempt,
  resolveBookingAttempt,
  restoreClaimedBookingAttempt,
} from '@/lib/db/booking-attempts';
import { recordSupplierWriteUncertainty } from '@/lib/db/booking-operations';
import {
  createBookingFromAttempt,
  publicBookingWithHeaderContact,
  readBookingByAttemptId,
  syncAirTicketingDetails,
} from '@/lib/db/flight-bookings';
import {
  isValidTitleForPassenger,
  type BookingPassengerType,
  type BookingTraveller,
} from '@/lib/flights/booking';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { requestActorKey } from '@/lib/http/actor-key';
import { bookFlight } from '@/lib/triplover/book';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import { readAirTicketingDetails } from '@/lib/triplover/air-ticketing-details';
import { isTriploverSupplier } from '@/lib/triplover/config';
import {
  beginDirectTicket,
  captureBookingReservation,
  markReservationForReconciliation,
  releaseReservation,
} from '@/lib/db/wallet';
import { walletOperationResponse } from '@/lib/wallet/http';
import {
  dispatchBookingStatusEmails,
  sendBookingStatusEmailOnce,
} from '@/lib/email/booking-status-delivery';
import { canCreateBookingOnBehalf } from '@/lib/flights/staff-booking.server';
import { recordSecurityAuditEvent } from '@/lib/db/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const name = z.string().trim().min(1).max(60).regex(/^[\p{L}][\p{L} .'-]*$/u);
const passportNumber = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,20}$/);
const traveller = z.object({
  passengerType: z.enum(['ADT', 'CHD', 'CNN', 'INF', 'INS']),
  title: z.enum(['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss']),
  firstName: name,
  lastName: name,
  gender: z.enum(['Male', 'Female']),
  dateOfBirth: date,
  // Optional at parse time and re-checked against the draft below: only an
  // itinerary that leaves the country actually needs a passport, and the draft
  // is the server's own record of which kind this is.
  passportNumber: z.union([passportNumber, z.literal('')]).optional(),
  passportExpiry: z.union([date, z.literal('')]).optional(),
  issuingCountry: z.union([country, z.literal('')]).optional(),
  nationality: country,
});
// Validated customer contact is saved with the booking and sent to the supplier.
const contact = z.object({
  phone: z.string().trim().regex(/^[0-9]{6,15}$/),
  phoneCountryCode: z.string().trim().regex(/^\+[0-9]{1,4}$/),
  customerEmail: z.string().trim().toLowerCase().email().max(254),
});
const schema = z.object({
  bookingId: z.string().uuid(),
  accessToken: z.string().min(32).max(128),
  travellers: z.array(traveller).min(1).max(9),
  contact,
});

function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function exactPassengerMix(
  expected: Partial<Record<BookingPassengerType, number>>,
  travellers: BookingTraveller[]
): boolean {
  const actual = travellers.reduce<Partial<Record<BookingPassengerType, number>>>(
    (counts, passenger) => {
      counts[passenger.passengerType] =
        (counts[passenger.passengerType] ?? 0) + 1;
      return counts;
    },
    {}
  );
  return (['ADT', 'CHD', 'CNN', 'INF', 'INS'] as const).every(
    (type) => (actual[type] ?? 0) === (expected[type] ?? 0)
  );
}

function ageOn(dateOfBirth: string, travelDate: string): number | null {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const travel = new Date(`${travelDate}T00:00:00Z`);
  if (!Number.isFinite(dob.getTime()) || !Number.isFinite(travel.getTime())) return null;
  let age = travel.getUTCFullYear() - dob.getUTCFullYear();
  if (
    travel.getUTCMonth() < dob.getUTCMonth() ||
    (travel.getUTCMonth() === dob.getUTCMonth() &&
      travel.getUTCDate() < dob.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

function agesAreValid(travellers: BookingTraveller[], travelDate: string): boolean {
  return travellers.every((passenger) => {
    const age = ageOn(passenger.dateOfBirth, travelDate);
    if (age === null) return false;
    if (passenger.passengerType === 'ADT') return age >= 12;
    if (passenger.passengerType === 'CHD') return age >= 5 && age < 12;
    if (passenger.passengerType === 'CNN') return age >= 2 && age < 5;
    return age >= 0 && age < 2;
  });
}

/** Only enforced for itineraries the server itself decided are international. */
function passportsAreValid(
  travellers: BookingTraveller[],
  travelDate: string
): boolean {
  return travellers.every(
    (passenger) =>
      Boolean(passenger.passportNumber) &&
      Boolean(passenger.issuingCountry) &&
      Boolean(passenger.passportExpiry) &&
      (passenger.passportExpiry as string) >= travelDate
  );
}

function titlesAreValid(travellers: BookingTraveller[]): boolean {
  return travellers.every((passenger) =>
    isValidTitleForPassenger(passenger.passengerType, passenger.gender, passenger.title)
  );
}

/**
 * The booking attempt is the durable handoff from Prepare to Book. Treat a
 * malformed legacy/corrupt row as unavailable before taking a wallet hold,
 * claiming the attempt, or sending anything to the supplier.
 */
function hasRequiredSupplierReferences(value: {
  unique_trans_id: unknown;
  item_code_ref: unknown;
  price_code_ref: unknown;
}): boolean {
  return [value.unique_trans_id, value.item_code_ref, value.price_code_ref].every(
    (reference) => typeof reference === 'string' && reference.trim().length > 0
  );
}

export async function POST(request: NextRequest) {
  // Identity before anything else: an anonymous caller learns nothing about
  // this endpoint's operational state or about any draft.
  let session: Awaited<ReturnType<typeof getDashboardSession>> = null;
  try {
    session = await getDashboardSession();
  } catch (error) {
    console.error('[booking] session lookup failed:', error);
  }
  if (!session) {
    return fail(
      401,
      'SIGN_IN_REQUIRED',
      'Please sign in to complete this booking.'
    );
  }
  const userId = session.clerkId;
  const supplierControls = await getSupplierOperationalControls();
  if (!supplierControls.bookingEnabled) {
    return fail(
      503,
      'BOOKING_DISABLED',
      'Booking submission is awaiting operational approval.'
    );
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'INVALID_BODY', 'Expected a JSON body.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail(
      400,
      'INVALID_TRAVELLERS',
      parsed.error.issues[0]?.message ?? 'Check the traveller details.'
    );
  }

  const limit = await checkActionLimit(
    'flightBookingSubmit',
    requestActorKey(request, userId)
  );
  if (!limit.ok) {
    return NextResponse.json(
      {
        success: false,
        error: {
          errorCode: 'RATE_LIMITED',
          errorMessage: rateLimitMessage(limit.retryAfterSeconds),
        },
      },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(limit.retryAfterSeconds),
        },
      }
    );
  }

  const current = await readBookingAttempt(
    parsed.data.bookingId,
    parsed.data.accessToken
  );
  if (!current) {
    return fail(404, 'DRAFT_NOT_FOUND', 'This booking draft is unavailable.');
  }
  // The access token alone is a capability anyone holding the link would have.
  // An attempt is bookable only by the account it was prepared for.
  const staffOwnsAttempt =
    current.staff_on_behalf &&
    current.created_by_user_id === userId &&
    canCreateBookingOnBehalf(session.role);
  if (current.user_id !== userId && !staffOwnsAttempt) {
    return fail(
      403,
      'DRAFT_NOT_YOURS',
      'This booking belongs to a different account.'
    );
  }
  // Already sent. The client is told to stop rather than shown the outcome:
  // the attempt's state is internal, and the booking is reached through the
  // account, not through this token.
  if (current.state !== 'draft') {
    return fail(
      409,
      'BOOKING_ALREADY_STARTED',
      'This booking has already been submitted. Do not submit it again.'
    );
  }
  if (Date.parse(current.expires_at) <= Date.now()) {
    return fail(410, 'DRAFT_EXPIRED', 'This fare expired. Search and verify it again.');
  }
  if (!isTriploverSupplier(current.supplier_account)) {
    return fail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  if (!hasRequiredSupplierReferences(current)) {
    return fail(
      409,
      'BOOKING_REFERENCE_UNAVAILABLE',
      'This booking\'s verified fare reference is unavailable. Search and verify the fare again.'
    );
  }
  const supplierAccount = current.supplier_account;
  const offer = current.offer_snapshot;
  if (current.staff_on_behalf && offer.directTicketing) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.on_behalf.direct_ticket_denied',
      targetType: 'booking_attempt',
      targetId: current.id,
      outcome: 'denied',
      metadata: { assignedUserId: current.user_id },
    });
    return fail(
      409,
      'HOLD_FARE_REQUIRED',
      'Staff-created bookings must be On Hold and cannot use direct ticketing.'
    );
  }
  if (offer.directTicketing && !supplierControls.ticketingEnabled) {
    return fail(
      503,
      'TICKETING_DISABLED',
      'Direct ticket issuance is awaiting operational activation.'
    );
  }
  if (
    !exactPassengerMix(offer.passengerCounts, parsed.data.travellers) ||
    !agesAreValid(parsed.data.travellers, offer.travelDate) ||
    !titlesAreValid(parsed.data.travellers)
  ) {
    return fail(
      400,
      'PASSENGER_MISMATCH',
      'Traveller titles, ages, and passenger types must match the flight search.'
    );
  }
  if (
    offer.passportRequired !== false &&
    !passportsAreValid(parsed.data.travellers, offer.travelDate)
  ) {
    return fail(
      400,
      'PASSPORT_REQUIRED',
      'This itinerary needs a passport number, issuing country and an expiry date after travel.'
    );
  }

  const bookingOperationRequest = createOperationRequestIdentity({
    // The attempt UUID is minted by the server and remains stable on replay.
    clientRequestNonce: current.id,
    action: 'booking',
    subjectType: 'attempt',
    subjectId: current.id,
    payload: {
      uniqueTransId: current.unique_trans_id,
      itemCodeRef: current.item_code_ref,
      priceCodeRef: current.price_code_ref,
      travellers: parsed.data.travellers,
      carrierCode: offer.itinerary?.carrierCode ?? null,
      directTicketing: offer.directTicketing,
    },
  });

  // The lock. Same predicates as the draft flow it replaces — one winner among
  // concurrent confirms, and an expired quote never reaches the supplier.
  const claim = await claimBookingAttempt(
    parsed.data.bookingId,
    parsed.data.accessToken,
    // The durable snapshot contains the customer's editable contact identity,
    // not the static identity used for supplier correspondence.
    { travellers: parsed.data.travellers, contact: parsed.data.contact },
    bookingOperationRequest
  );
  if (!claim.ok) {
    // Nothing reached the supplier in either case, but a storage failure is
    // worth retrying and an already-claimed attempt is emphatically not.
    return claim.reason === 'storage'
      ? fail(
          503,
          'BOOKING_STORAGE_FAILED',
          'Booking storage is unavailable. Nothing was submitted — try again shortly.'
        )
      : fail(
          409,
          'BOOKING_ALREADY_STARTED',
          'This booking has already been submitted. Do not submit it again.'
        );
  }
  const claimed = claim.row;
  const directRequestId = bookingOperationRequest.requestKey;
  if (offer.directTicketing) {
    const reserved = await beginDirectTicket(
      claimed.id,
      session,
      directRequestId
    );
    if (!reserved.ok) {
      if (reserved.code === 'STORAGE_ERROR') {
        await markReservationForReconciliation(
          { attemptId: claimed.id },
          'Wallet reservation response was lost before supplier booking started'
        );
        return fail(
          503,
          'WALLET_RESERVATION_UNKNOWN',
          'No airline request was sent, but the wallet reservation outcome needs Accounts review.'
        );
      }
      const restored = await restoreClaimedBookingAttempt(claimed.id, userId);
      if (!restored) {
        return fail(
          503,
          'BOOKING_STORAGE_FAILED',
          'The wallet declined this ticket, but the booking attempt could not be reopened. Contact support.'
        );
      }
      return walletOperationResponse(reserved);
    }
  }

  const supplierLifecycle = bookingAttemptSupplierWriteHooks(
    claimed.id,
    bookingOperationRequest
  );

  try {
    const booked = await bookFlight(
      {
        uniqueTransId: claimed.unique_trans_id,
        itemCodeRef: claimed.item_code_ref,
        priceCodeRef: claimed.price_code_ref,
      },
      parsed.data.travellers,
      parsed.data.contact,
      supplierAccount,
      supplierLifecycle
    );
    // One transaction allocates the public reference, creates the business
    // record and resolves the attempt. A storage failure leaves the attempt in
    // `submitting` for reconciliation; it must never be resolved separately.
    const booking = await createBookingFromAttempt(
      claimed.id,
      booked.outcome,
      bookingOperationRequest
    );
    if (!booking) {
      if (offer.directTicketing) {
        await markReservationForReconciliation(
          { attemptId: claimed.id },
          'Supplier returned direct tickets but the booking record could not be finalized'
        );
      }
      return fail(
        500,
        'BOOKING_PERSIST_FAILED',
        'The airline answered, but the booking record could not be finalized. Contact support.'
      );
    }
    if (current.staff_on_behalf) {
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'booking.on_behalf.create',
        targetType: 'booking',
        targetId: booking.id,
        outcome: 'succeeded',
        metadata: {
          assignedUserId: current.user_id,
          bookingOwnerType: booking.booking_owner_type,
          bookingOwnerKey: booking.booking_owner_key,
          status: booking.status,
          walletMutation: false,
        },
      });
    }
    const publicResult = await publicBookingWithHeaderContact(booking);
    if (booked.outcome.status === 'held') {
      // A held supplier response can project as On Hold or Unconfirmed.
      await sendBookingStatusEmailOnce(booking);
    }
    if (offer.directTicketing) {
      if (booked.outcome.status !== 'ticketed') {
        const released = await releaseReservation(
          { attemptId: claimed.id },
          session,
          directRequestId,
          'Supplier created a hold instead of issuing direct tickets'
        );
        if (!released.ok) {
          await markReservationForReconciliation(
            { attemptId: claimed.id },
            'Supplier created a hold and the wallet reservation could not be released'
          );
          return fail(
            503,
            'HOLD_RELEASE_FAILED',
            'The airline created a held booking, but its wallet reservation needs reconciliation.'
          );
        }
        return NextResponse.json(
          { success: true, data: publicResult },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
      const captured = await captureBookingReservation(
        booking.id,
        session,
        directRequestId,
        { ...booked.outcome }
      );
      if (!captured.ok) {
        await markReservationForReconciliation(
          { bookingId: booking.id },
          `Direct tickets were issued but payment capture failed: ${captured.code ?? 'unknown'}`
        );
        return fail(
          503,
          'PAYMENT_RECONCILIATION_REQUIRED',
          'Tickets were issued, but payment finalization needs reconciliation. Do not submit again.'
        );
      }
      try {
        // Direct-ticket bookings also receive terminal details only through the
        // ticket report. A delayed report must not turn a successful ticket into
        // a failed checkout, so this remains a best-effort enrichment.
        const ticketDetails = await readAirTicketingDetails(
          claimed.unique_trans_id,
          'Confirmed',
          supplierAccount
        );
        await syncAirTicketingDetails(
          booking.id,
          ticketDetails,
          session,
          'ordinary_sync'
        );
      } catch (terminalRefreshError) {
        console.error(
          '[booking] direct-ticket terminal refresh failed:',
          terminalRefreshError
        );
      }
      const confirmedRow = await readBookingByAttemptId(claimed.id);
      if (confirmedRow) {
        await dispatchBookingStatusEmails(confirmedRow.id);
        return NextResponse.json(
          { success: true, data: await publicBookingWithHeaderContact(confirmedRow) },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }
    return NextResponse.json(
      { success: true, data: publicResult },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const supplierFailure = classifySupplierWriteFailure(
      error,
      supplierLifecycle.boundarySnapshot()
    );
    const unknown = supplierFailure.failureClass === 'uncertain';
    const duplicateRejected =
      supplierFailure.reasonCode === 'supplier_duplicate_booking';
    const terminalErrorCode = unknown
      ? 'BOOKING_OUTCOME_UNKNOWN'
      : duplicateRejected
        ? 'SUPPLIER_DUPLICATE_BOOKING'
        : 'BOOKING_FAILED';
    let uncertaintyOwned = false;
    if (unknown) {
      const recorded = await recordSupplierWriteUncertainty({
        subject: { attemptId: claimed.id },
        actorUserId: session.clerkId,
        actorRole: session.role,
        request: bookingOperationRequest,
        classification: supplierFailure,
        errorMessage:
          error instanceof Error ? error.message : 'Booking outcome unknown',
      });
      uncertaintyOwned = recorded.ok;
    }
    if (offer.directTicketing) {
      if (unknown) {
        if (!uncertaintyOwned) {
          await markReservationForReconciliation(
            { attemptId: claimed.id },
            `${supplierFailure.reasonCode}: ${
              error instanceof Error
                ? error.message
                : 'Direct ticket outcome unknown'
            }`
          );
        }
      } else {
        const released = await releaseReservation(
          { attemptId: claimed.id },
          session,
          directRequestId,
          error instanceof Error ? error.message : 'Supplier declined direct ticketing'
        );
        if (!released.ok) {
          return fail(
            503,
            'HOLD_RELEASE_FAILED',
            'The airline declined the booking, but the wallet hold could not be released. Contact Accounts.'
          );
        }
      }
    }
    if (!unknown || !uncertaintyOwned) {
      try {
        await resolveBookingAttempt(claimed.id, userId, {
          state: unknown ? 'unknown' : 'failed',
          errorCode: terminalErrorCode,
          supplierMessage: error instanceof Error ? error.message : null,
        });
      } catch (resolutionError) {
        console.error('Booking attempt resolution failed:', resolutionError);
        return fail(
          503,
          'BOOKING_STORAGE_FAILED',
          unknown
            ? 'The airline outcome is unknown and could not be recorded. Do not submit again; contact support.'
            : 'The airline declined the booking, but the outcome could not be recorded. Contact support.'
        );
      }
    }
    console.error('Flight Booking failed:', {
      error,
      supplierFailure,
    });
    return fail(
      unknown ? 503 : duplicateRejected ? 409 : 502,
      terminalErrorCode,
      unknown
        ? 'The airline outcome is unknown. Do not submit again; contact support.'
        : duplicateRejected
          ? 'The airline rejected this booking because the same passenger already has a booking for this flight. Please check My Bookings or contact support. Do not submit the same booking again.'
        : 'The airline declined the booking. Search and verify the fare again.'
    );
  }
}
