import { SITE_EMAIL } from '@/lib/site';
import type { BookingStatus } from '@/lib/flights/booking-status';
import type { FareBreakdown, ItineraryLeg } from '@/lib/flights/types';
import type { PricingSnapshot } from '@/lib/markup';

/**
 * The flights a draft books, kept so checkout can render an itinerary without
 * re-running Search. Display data only — no supplier reference tokens.
 */
export type BookedItinerary = {
  carrierCode: string;
  carrierName: string;
  refundable: boolean;
  legs: ItineraryLeg[];
};

export type BookingPassengerType = 'ADT' | 'CHD' | 'CNN' | 'INF' | 'INS';
export type BookingTitle = 'Mr' | 'Mrs' | 'Ms' | 'Mstr' | 'Miss';
export type BookingGender = 'Male' | 'Female';

/** The title choices airlines accept for the traveller's age category and gender. */
export function titleOptionsForPassenger(
  passengerType: BookingPassengerType,
  gender: BookingGender
): readonly BookingTitle[] {
  if (passengerType === 'ADT') {
    return gender === 'Male' ? ['Mr'] : ['Ms', 'Mrs'];
  }
  return gender === 'Male' ? ['Mstr'] : ['Miss'];
}

export function isValidTitleForPassenger(
  passengerType: BookingPassengerType,
  gender: BookingGender,
  title: BookingTitle
) {
  return titleOptionsForPassenger(passengerType, gender).includes(title);
}

export type BookingTraveller = {
  passengerType: BookingPassengerType;
  title: BookingTitle;
  firstName: string;
  lastName: string;
  gender: BookingGender;
  dateOfBirth: string;
  /** Empty on a domestic itinerary — see `BookingOffer.passportRequired`. */
  passportNumber?: string;
  passportExpiry?: string;
  issuingCountry?: string;
  nationality: string;
};

export type BookingContact = {
  /** Customer phone stored with the booking and sent to the supplier. */
  phone: string;
  phoneCountryCode: string;
  /** Customer-facing address for confirmations and booking communications. */
  customerEmail: string;
};

/** Legacy import contact defaults and booking location defaults.
 * New supplier bookings use the customer's submitted email and phone.
 */
export const BOOKING_CONTACT_DEFAULTS = {
  email: SITE_EMAIL,
  countryCode: 'BD',
  cityName: 'Kaligonj',
} as const;

export type BookingSubmission = {
  bookingId: string;
  accessToken: string;
  travellers: BookingTraveller[];
  contact: BookingContact;
};

/**
 * The commercial half of an itinerary, identical whether it is still an open
 * attempt or a booking that exists.
 *
 * Split out so the checkout panels can render either without knowing which
 * they hold — and so neither carries an operational state that a client has no
 * business seeing.
 */
export type BookingOffer = {
  currency: string;
  totalPrice: number;
  serviceMargin: number;
  passengerCounts: Partial<Record<BookingPassengerType, number>>;
  travelDate: string;
  directTicketing: boolean;
  /**
   * False for an itinerary that never leaves one country, which is where the
   * traveller form stops asking for a passport. Decided server-side.
   */
  passportRequired: boolean;
  /** The flights themselves, for the itinerary and baggage panels. */
  itinerary: BookedItinerary | null;
  /** Per-passenger-type money, including the AIT the search page never shows. */
  fares: FareBreakdown[];
  repricedAt: string;
};

/**
 * An open attempt, as the checkout sees it.
 *
 * Deliberately has no status field. `draft` and `submitting` are internal to
 * `booking_attempts`; a client that can read this simply has an attempt still
 * open, and one that cannot gets an error instead.
 */
export type PublicBookingAttempt = BookingOffer & {
  attemptId: string;
  /** When the held quote stops being bookable. */
  expiresAt: string;
  submissionEnabled: boolean;
  /** Separate operational gate for calls that can issue a paid ticket. */
  ticketingEnabled: boolean;
  /** Editable contact seed from the signed-in B2B user's saved profile. */
  suggestedContact?: Pick<BookingContact, 'phone' | 'phoneCountryCode'>;
};

/** A booking that exists, carrying only the seven business statuses. */
export type PublicBooking = BookingOffer & {
  /** Internal id. Never shown; `publicRef` is what a customer quotes. */
  bookingId: string;
  /** KTT + GDS PNR + first airline PNR, with a unique suffix when needed. */
  publicRef: string;
  status: BookingStatus;
  /** Customer-safe In Progress explanation; never an internal operation code. */
  statusMessage?: string | null;
  paymentState:
    | 'unpaid'
    | 'held'
    | 'captured'
    | 'released'
    | 'reconciliation'
    | 'partially-refunded'
    | 'refunded';
  headerContact: {
    name: string;
    licenseNo: string;
    mobile: string;
    email: string;
    address: string;
    logoUrl: string | null;
  };
  pnr: string | null;
  /**
   * The airline's own record locator(s) — what a traveller quotes on the
   * carrier's site rather than on ours. Usually the same string as `pnr`, but a
   * multi-carrier itinerary returns one per airline, and an empty list is
   * precisely what makes a held booking Un-Confirmed.
   */
  airlinesPnr: string[];
  /** The supplier's own booking number, when it differs from the PNR. */
  bookingRefNumber: string | null;
  /** The supplier's own wording, e.g. `"Created"`. Display only. */
  bookingStatus: string | null;
  /** The deadline exactly as the supplier wrote it, for display. */
  ticketingTimeLimit: string | null;
  /** The same deadline as an unambiguous instant, for counting down. */
  ticketingDeadlineAt: string | null;
  ticketNumbers: string[];
  warnings: string[];
  /** When the booking record was created. */
  bookedAt: string;
  /** Actual active-operation claim/start instant; null outside In Progress. */
  processingSince?: string | null;
  /** When the tickets were issued; null while the seats are only held. */
  issuedAt: string | null;
  /** When the booking was cancelled; null unless cancellation is final. */
  cancelledAt: string | null;
};

export type PrivateBookingRefs = {
  uniqueTransId: string;
  itemCodeRef: string;
  priceCodeRef: string;
};

export type BookingDraftPricing = Pick<
  PricingSnapshot,
  | 'audience'
  | 'agencyCode'
  | 'sellingPrice'
  | 'serviceMarginAmount'
  | 'ruleId'
  | 'basis'
> & Partial<Pick<PricingSnapshot, 'supplierTotalPrice' | 'grossPrice'>>;
