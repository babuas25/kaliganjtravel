import 'server-only';

import { z } from 'zod';

import { publicBooking, type BookingRow } from '@/lib/db/flight-bookings';
import { bookingStatusEmail, type BookingEmailContent } from '@/lib/email/booking-template';
import type { BookingTraveller, PublicBooking } from '@/lib/flights/booking';
import { customerStatusMessage } from '@/lib/flights/customer-status';
import { BOOKING_STATUSES, STORED_BOOKING_STATUSES, type BookingStatus } from '@/lib/flights/booking-status';

const nullableString = z.string().nullable();
const headerContactSchema = z.object({
  name: z.string(),
  licenseNo: z.string(),
  mobile: z.string(),
  email: z.string(),
  address: z.string(),
  logoUrl: nullableString,
});
const travellerSchema = z.object({
  passengerType: z.enum(['ADT', 'CHD', 'CNN', 'INF', 'INS']),
  title: z.enum(['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss']),
  firstName: z.string(),
  lastName: z.string(),
  gender: z.enum(['Male', 'Female']),
  dateOfBirth: z.string(),
  nationality: z.string(),
});
const bookingSnapshotSchema = z.object({
  snapshotVersion: z.literal(1),
  bookingId: z.string().uuid(),
  publicRef: z.string().min(1),
  lifecycleStatus: z.enum(BOOKING_STATUSES),
  storedStatus: z.enum(STORED_BOOKING_STATUSES),
  audience: z.enum(['b2c', 'agency', 'superadmin']),
  agencyCode: nullableString,
  supplier: z.string(),
  importSource: z.enum(['IMP_EXP', 'MANUAL']).nullable(),
  paymentState: z.enum([
    'unpaid',
    'held',
    'captured',
    'released',
    'reconciliation',
    'partially-refunded',
    'refunded',
  ]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  pricingSnapshot: z.record(z.unknown()),
  supplierGrossAmount: z.number().nullable(),
  passengerCounts: z.record(z.unknown()),
  travelDate: z.string(),
  directTicketing: z.boolean(),
  passportRequired: z.boolean(),
  itinerary: z.unknown().nullable(),
  fares: z.array(z.unknown()),
  repricedAt: z.string(),
  pnr: nullableString,
  airlinesPnr: z.array(z.string()),
  bookingRefNumber: nullableString,
  bookingStatus: nullableString,
  ticketingTimeLimit: nullableString,
  ticketingDeadlineAt: nullableString,
  ticketNumbers: z.array(z.string()),
  warnings: z.array(z.string()),
  submissionStartedAt: nullableString,
  bookedAt: z.string(),
  processingSince: nullableString,
  issuedAt: nullableString,
  cancelledAt: nullableString,
  operationKind: z.enum(['ticketing', 'cancellation', 'reconciliation']).nullable(),
  operationReason: nullableString,
  headerContact: headerContactSchema,
  travellers: z.array(travellerSchema),
});
const eventSnapshotSchema = z.object({
  bookingSnapshot: bookingSnapshotSchema,
});

export type BookingEventEmailDocument = {
  booking: PublicBooking;
  travellers: BookingTraveller[];
};

/**
 * Reconstructs the email document only from the immutable event snapshot.
 * Missing/old snapshot versions fail closed; this function performs no read.
 */
export function bookingEmailDocumentFromEventSnapshot(
  eventSnapshot: unknown,
  expectedStatus: BookingStatus
): BookingEventEmailDocument {
  const { bookingSnapshot: snapshot } = eventSnapshotSchema.parse(eventSnapshot);
  if (snapshot.lifecycleStatus !== expectedStatus) {
    throw new Error('Notification snapshot status does not match its outbox occurrence.');
  }
  const row = {
    id: snapshot.bookingId,
    public_ref: snapshot.publicRef,
    status: snapshot.storedStatus,
    lifecycle_status: snapshot.lifecycleStatus,
    audience: snapshot.audience,
    agency_code: snapshot.agencyCode,
    supplier: snapshot.supplier,
    import_source: snapshot.importSource,
    payment_state: snapshot.paymentState,
    currency: snapshot.currency,
    pricing_snapshot: snapshot.pricingSnapshot,
    supplier_gross_amount: snapshot.supplierGrossAmount,
    passenger_counts: snapshot.passengerCounts,
    travel_date: snapshot.travelDate,
    direct_ticketing: snapshot.directTicketing,
    passport_required: snapshot.passportRequired,
    itinerary: snapshot.itinerary,
    fares: snapshot.fares,
    repriced_at: snapshot.repricedAt,
    pnr: snapshot.pnr,
    airlines_pnr: snapshot.airlinesPnr,
    booking_ref_number: snapshot.bookingRefNumber,
    booking_status: snapshot.bookingStatus,
    ticketing_time_limit: snapshot.ticketingTimeLimit,
    ticketing_deadline_at: snapshot.ticketingDeadlineAt,
    ticket_numbers: snapshot.ticketNumbers,
    warnings: snapshot.warnings,
    submission_started_at: snapshot.submissionStartedAt,
    created_at: snapshot.bookedAt,
    operation_started_at: snapshot.processingSince,
    issued_at: snapshot.issuedAt,
    cancelled_at: snapshot.cancelledAt,
    operation_kind: snapshot.operationKind,
    operation_reason: snapshot.operationReason,
  } as BookingRow;
  const booking = publicBooking(row);
  return {
    booking: {
      ...booking,
      status: snapshot.lifecycleStatus,
      statusMessage: customerStatusMessage({
        status: snapshot.lifecycleStatus,
        importSource: snapshot.importSource,
        paymentState: snapshot.paymentState,
        operationKind: snapshot.operationKind,
        operationReason: snapshot.operationReason,
      }),
      headerContact: snapshot.headerContact,
      bookedAt: snapshot.bookedAt,
      processingSince: snapshot.processingSince,
      issuedAt: snapshot.issuedAt,
      cancelledAt: snapshot.cancelledAt,
    },
    travellers: snapshot.travellers,
  };
}
export function bookingStatusEmailFromEventSnapshot(input: {
  eventSnapshot: unknown;
  status: BookingStatus;
  bookingUrl: string;
}): BookingEmailContent & BookingEventEmailDocument {
  const document = bookingEmailDocumentFromEventSnapshot(
    input.eventSnapshot,
    input.status
  );
  return {
    ...document,
    ...bookingStatusEmail(
      {
        booking: document.booking,
        travellers: document.travellers,
        bookingUrl: input.bookingUrl,
      },
      input.status
    ),
  };
}
