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

export type SupplierBookingOutcome = {
  status: 'held' | 'ticketed';
  pnr: string;
  airlinesPnr: string[];
  bookingRefNumber: string | null;
  bookingStatus: string | null;
  ticketingTimeLimit: string | null;
  bookingCodeRef: string;
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
    ticketCodeRef?: string;
    ticketInfoes?: { ticketNumbers?: unknown }[];
    warnings?: unknown;
    message?: string;
  };
  const pnr = raw.pnr || raw.bookingRefNumber || '';
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
  const ticketNumbers = Array.isArray(raw.ticketInfoes)
    ? raw.ticketInfoes.flatMap((ticket) =>
        Array.isArray(ticket.ticketNumbers)
          ? ticket.ticketNumbers.filter(
              (value): value is string => typeof value === 'string'
            )
          : []
      )
    : [];
  const hasDirectTicketPayload = Array.isArray(raw.ticketInfoes);
  if (hasDirectTicketPayload && ticketNumbers.length === 0) {
    throw new TriploverError(
      'protocol',
      'Triplover Book returned a direct-ticket response without ticket numbers.'
    );
  }
  const directTicketed = hasDirectTicketPayload && ticketNumbers.length > 0;
  const ticketCodeRef = raw.ticketCodeRef?.trim() || null;
  if (directTicketed && !ticketCodeRef) {
    throw new TriploverError(
      'protocol',
      'Triplover Book returned tickets without a ticketCodeRef.'
    );
  }

  return {
    submittedPassengers,
    outcome: {
      status: directTicketed ? 'ticketed' : 'held',
      pnr,
      airlinesPnr: validAirlinePnrs(raw.airlinesPNR),
      bookingRefNumber: raw.bookingRefNumber ?? null,
      bookingStatus: raw.bookingStatus ?? null,
      // A successful Book response must be persisted immediately. PNR is a
      // safe enrichment, but its propagation retries can outlive a serverless
      // request and must never leave a real airline booking unfinalized.
      // A later PNR refresh replaces this provisional supplier value with
      // PNR.lastTicketTime.
      ticketingTimeLimit: raw.ticketingTimeLimit ?? null,
      bookingCodeRef,
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
