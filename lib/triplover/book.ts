import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import {
  BOOKING_CONTACT_DEFAULTS,
  type BookingContact,
  type BookingTraveller,
  type PrivateBookingRefs,
} from '@/lib/flights/booking';
import {
  TriploverError,
  triploverCall,
  type SupplierWriteLifecycleHooks,
} from '@/lib/triplover/client';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';

export type SupplierBookingOutcome = {
  status: 'held' | 'ticketed';
  pnr: string;
  airlinesPnr: string[];
  bookingRefNumber: string | null;
  /** Shapontravels' stable STR reference from X-Booking-Reference. */
  supplierPublicRef?: string;
  bookingStatus: string | null;
  ticketingTimeLimit: string | null;
  bookingCodeRef: string;
  supplierRefs: PrivateBookingRefs;
  ticketCodeRef: string | null;
  ticketNumbers: string[];
  warnings: string[];
  message: string | null;
};

function passengerInfo(
  traveller: BookingTraveller,
  index: number,
  contact: BookingContact
) {
  return {
    nameElement: {
      title: traveller.title,
      firstName: traveller.firstName,
      lastName: traveller.lastName,
    },
    gender: traveller.gender,
    passengerType: traveller.passengerType,
    dateOfBirth: traveller.dateOfBirth,
    documentInfo: {
      // Empty strings on a domestic itinerary, where no passport was collected.
      documentNumber: traveller.passportNumber ?? '',
      expireDate: traveller.passportExpiry ?? '',
      documentType: '',
      issuingCountry: traveller.issuingCountry ?? '',
      nationality: traveller.nationality,
      frequentFlyerNumber: '',
      passportCopy: '',
      visaCopy: '',
      postCode: '',
    },
    contactInfo: {
      countryCode: BOOKING_CONTACT_DEFAULTS.countryCode,
      cityName: BOOKING_CONTACT_DEFAULTS.cityName,
      email: contact.customerEmail,
      // Bangladesh's national trunk prefix is omitted after the calling code.
      phone: contact.phoneCountryCode === '+880'
        ? contact.phone.replace(/^0(?=1\d{9}$)/, '')
        : contact.phone,
      phoneCountryCode: contact.phoneCountryCode,
    },
    isLeadPassenger: index === 0,
  };
}

export async function bookFlight(
  refs: PrivateBookingRefs,
  travellers: BookingTraveller[],
  contact: BookingContact,
  supplier: TriploverSupplier,
  lifecycleHooks?: SupplierWriteLifecycleHooks
): Promise<{ outcome: SupplierBookingOutcome; submittedPassengers: unknown[] }> {
  const submittedPassengers = travellers.map((traveller, index) =>
    passengerInfo(traveller, index, contact)
  );
  const call = await triploverCall('Book', '/api/Book', {
    passengerInfoes: submittedPassengers,
    BookingWiseContactInfo: {},
    agentInfo: null,
    taxRedemptions: [],
    priceCodeRef: refs.priceCodeRef,
    uniqueTransID: refs.uniqueTransId,
    itemCodeRef: refs.itemCodeRef,
    commissionOnTaxes: [],
  }, { supplier, lifecycleHooks });
  if (!call.data || typeof call.data !== 'object') {
    throw new TriploverError('protocol', 'Triplover Book returned no booking.');
  }
  const raw = call.data as {
    pnr?: string;
    airlinesPNR?: unknown;
    bookingRefNumber?: string;
    bookingStatus?: string;
    ticketingTimeLimit?: string;
    bookingCodeRef?: string;
    uniqueTransID?: string;
    itemCodeRef?: string;
    priceCodeRef?: string;
    ticketCodeRef?: string;
    ticketInfoes?: { ticketNumbers?: unknown }[];
    warnings?: unknown;
    message?: string;
  };
  const pnr = raw.pnr?.trim() || raw.bookingRefNumber?.trim() || '';
  if (!pnr) {
    throw new TriploverError('protocol', 'Triplover Book returned no PNR.');
  }
  const bookingCodeRef = raw.bookingCodeRef?.trim() ?? '';
  if (!bookingCodeRef) {
    throw new TriploverError(
      'protocol',
      'Triplover Book returned no bookingCodeRef.'
    );
  }
  const hasDirectTicketPayload = raw.ticketInfoes != null;
  const ticketNumbers = hasDirectTicketPayload
    ? completeTicketNumbers(raw.ticketInfoes, travellers.length || undefined)
    : [];
  if (!ticketNumbers) {
    throw new TriploverError(
      'protocol',
      'Triplover Book returned an incomplete direct-ticket response.'
    );
  }
  const directTicketed = hasDirectTicketPayload;
  const ticketCodeRef = raw.ticketCodeRef?.trim() || null;
  if (directTicketed && !ticketCodeRef) {
    throw new TriploverError(
      'protocol',
      'Triplover Book returned tickets without a ticketCodeRef.'
    );
  }
  if (!directTicketed && (ticketCodeRef || !raw.bookingStatus?.trim())) {
    throw new TriploverError('protocol', 'Triplover Book returned no definite hold or ticket outcome.');
  }
  // Book may return updated item/price tokens. Keep them for delayed issue;
  // older supplier responses that omit echoes retain the submitted tokens.
  const returnedRef = (value: unknown, fallback: string): string => {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || !value.trim()) {
      throw new TriploverError('protocol', 'Triplover Book returned an invalid reference.');
    }
    return value;
  };
  const supplierRefs = {
    uniqueTransId: returnedRef(raw.uniqueTransID, refs.uniqueTransId),
    itemCodeRef: returnedRef(raw.itemCodeRef, refs.itemCodeRef),
    priceCodeRef: returnedRef(raw.priceCodeRef, refs.priceCodeRef),
  };
  if (supplierRefs.uniqueTransId !== refs.uniqueTransId) {
    throw new TriploverError('protocol', 'Triplover Book returned a different transaction reference.');
  }

  return {
    submittedPassengers,
    outcome: {
      status: directTicketed ? 'ticketed' : 'held',
      pnr,
      airlinesPnr: validAirlinePnrs(raw.airlinesPNR),
      bookingRefNumber: raw.bookingRefNumber ?? null,
      bookingStatus: raw.bookingStatus ?? null,
      // Persist the supplier's deadline with the booking. NewTicket uses saved
      // references even when this value is absent; there is no automatic PNR
      // lookup or invented hold duration in the certification flow.
      ticketingTimeLimit: raw.ticketingTimeLimit ?? null,
      bookingCodeRef,
      supplierRefs,
      ticketCodeRef,
      ticketNumbers,
      warnings: Array.isArray(raw.warnings)
        ? raw.warnings.filter(
            (value): value is string => typeof value === 'string'
          )
        : [],
      message: raw.message ?? null,
    },
  };
}
