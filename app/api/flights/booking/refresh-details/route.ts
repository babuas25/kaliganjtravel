import { NextRequest } from 'next/server';
import { z } from 'zod';
import { usesStoredBookingReferences } from '@/lib/booking-lifecycle/ticketing-flow';

import { getDashboardSession } from '@/lib/dashboard/session';
import { canRefreshBookingSupplierDetails } from '@/lib/dashboard/booking-lifecycle';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import {
  readBookingByPublicRef,
  syncAirTicketingDetails,
  syncPnrDetails,
} from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import {
  readAirTicketingDetails,
  readLatestAirTicketingDetails,
  type AirTicketingDetails,
} from '@/lib/triplover/air-ticketing-details';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';
import type { NormalizedSupplierEvidence } from '@/lib/booking-lifecycle/supplier-evidence';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
});

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRefreshBookingSupplierDetails(session.role)) {
    return walletFail(
      403,
      'REFRESH_FORBIDDEN',
      'Only Super Admin, Admin, or Staff can refresh supplier ticket details.'
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_REFRESH_REQUEST', 'Check the booking reference.');
  }

  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (usesStoredBookingReferences(booking) &&
      booking.status !== 'confirmed' && booking.status !== 'cancelled') {
    return walletFail(
      409,
      'HELD_BOOKING_REFRESH_UNAVAILABLE',
      'This held booking uses its saved details. Availability is checked when the ticket is issued.'
    );
  }
  if (booking.import_source === 'MANUAL' || booking.supplier !== 'triplover') {
    return walletFail(
      409,
      'EXTERNAL_SUPPLIER_BOOKING',
      booking.import_source === 'MANUAL'
        ? 'Manual bookings do not support supplier refresh or sync actions.'
        : 'This imported booking must be refreshed in its external supplier system.'
    );
  }
  if (!isTriploverSupplier(booking.supplier_account)) {
    return walletFail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  const supplierAccount = booking.supplier_account;
  const uniqueTransId = booking.supplier_refs?.uniqueTransId;
  if (!uniqueTransId) {
    return walletFail(
      409,
      'SUPPLIER_REFERENCE_MISSING',
      'This booking has no supplier transaction ID.'
    );
  }

  try {
    let details: Omit<AirTicketingDetails, 'evidence'> & {
      evidence: NormalizedSupplierEvidence;
    };
    let ticketingDeadlineAt = booking.ticketing_deadline_at;
    let source: 'ticketing' | 'pnr' = 'ticketing';

    if (booking.status === 'confirmed' || booking.status === 'cancelled') {
      const ticketingDetails = await readLatestAirTicketingDetails(
        uniqueTransId,
        supplierAccount
      );
      const refreshed = await syncAirTicketingDetails(
        booking.id,
        ticketingDetails,
        session,
        'ordinary_sync'
      );
      ticketingDeadlineAt = refreshed.ticketing_deadline_at;
      details = ticketingDetails;
    } else {
      const locators = pnrLookupLocators({
        pnr: booking.pnr,
        bookingRefNumber: booking.booking_ref_number,
      });
      if (!locators || !booking.booking_code_ref ||
          !booking.supplier_refs.itemCodeRef || !booking.supplier_refs.priceCodeRef) {
        throw new Error('This booking is missing the references required for a live PNR refresh.');
      }
      const pnr = await readPnr({
        ...booking.supplier_refs,
        supplier: supplierAccount,
        ...locators,
        bookingCodeRef: booking.booking_code_ref,
        carrierCode: booking.itinerary?.carrierCode,
        deadlineNotBefore: booking.submission_started_at ?? booking.created_at,
      });
      const normalized = pnr.status?.trim().toLowerCase();
      if (normalized === 'cancelled' || normalized === 'canceled') {
        const ticketingDetails = await readAirTicketingDetails(
          uniqueTransId,
          'Cancelled',
          supplierAccount
        );
        const refreshed = await syncAirTicketingDetails(
          booking.id,
          ticketingDetails,
          session,
          'ordinary_sync'
        );
        ticketingDeadlineAt = refreshed.ticketing_deadline_at;
        details = ticketingDetails;
      } else if (normalized === 'confirmed' || normalized === 'issued') {
        const ticketingDetails = await readAirTicketingDetails(
          uniqueTransId,
          'Confirmed',
          supplierAccount
        );
        const refreshed = await syncAirTicketingDetails(
          booking.id,
          ticketingDetails,
          session,
          'ordinary_sync'
        );
        ticketingDeadlineAt = refreshed.ticketing_deadline_at;
        details = ticketingDetails;
      } else {
        const refreshed = await syncPnrDetails(
          booking.id,
          pnr,
          session,
          'ordinary_sync'
        );
        ticketingDeadlineAt = refreshed.ticketing_deadline_at;
        source = 'pnr';
        details = {
          supplierStatus: pnr.status,
          pnr: pnr.pnr,
          airlinesPnr: pnr.airlinesPnr,
          ticketCodeRef: null,
          ticketNumbers: [],
          passengerCount: null,
          passengerIdentityHashes: [],
          routeSignature: null,
          segments: [],
          issuedAt: null,
          cancelledAt: null,
          evidence: pnr.evidence,
        };
      }
    }
    await dispatchBookingStatusEmails(booking.id);
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.ticket_details.refresh',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'succeeded',
      metadata: { supplierStatus: details.supplierStatus, source },
    });
    return walletOk({ details, source, ticketingDeadlineAt });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Ticket details refresh failed.';
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.ticket_details.refresh',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: { reason: message.slice(0, 500) },
    });
    return walletFail(502, 'TICKET_DETAILS_REFRESH_FAILED', message);
  }
}
