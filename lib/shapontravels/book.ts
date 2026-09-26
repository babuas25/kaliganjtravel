import 'server-only';

import type { BookingContact, BookingTraveller, PrivateBookingRefs } from '@/lib/flights/booking';
import { BOOKING_CONTACT_DEFAULTS } from '@/lib/flights/booking';
import type { SupplierBookingOutcome } from '@/lib/triplover/book';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import { ShapontravelsWriteError, shapontravelsBookRequest } from './client';

function passengerInfo(traveller: BookingTraveller, index: number, contact: BookingContact) {
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
      documentNumber: traveller.passportNumber ?? '',
      expireDate: traveller.passportExpiry ?? '',
      issuingCountry: traveller.issuingCountry ?? '',
      nationality: traveller.nationality,
    },
    contactInfo: {
      countryCode: BOOKING_CONTACT_DEFAULTS.countryCode,
      cityName: BOOKING_CONTACT_DEFAULTS.cityName,
      email: contact.customerEmail,
      phone: contact.phoneCountryCode === '+880'
        ? contact.phone.replace(/^0(?=1\d{9}$)/, '')
        : contact.phone,
      phoneCountryCode: contact.phoneCountryCode,
    },
    isLeadPassenger: index === 0,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Books one accepted, holdable fare. Ticketing is never requested here. */
export async function bookShapontravelsHold(
  refs: PrivateBookingRefs,
  travellers: BookingTraveller[],
  contact: BookingContact,
  expectedPayable: number,
  idempotencyKey: string,
  hooks: SupplierWriteLifecycleHooks
): Promise<{ outcome: SupplierBookingOutcome; submittedPassengers: unknown[] }> {
  const submittedPassengers = travellers.map((traveller, index) =>
    passengerInfo(traveller, index, contact)
  );
  const response = await shapontravelsBookRequest({
    uniqueTransID: refs.uniqueTransId,
    itemCodeRef: refs.itemCodeRef,
    priceCodeRef: refs.priceCodeRef,
    passengerInfoes: submittedPassengers,
    directIssueIntent: false,
    taxRedemptions: [],
    commissionOnTaxes: [],
  }, idempotencyKey, hooks);
  const envelope = response.body as {
    item1?: Record<string, unknown>;
    item2?: { isSuccess?: boolean };
  };
  const receipt = envelope?.item1;
  const returnedPayable = (receipt?.fareBreakdown as { payable?: unknown } | undefined)?.payable;
  const expectedMinor = Math.round(expectedPayable * 100);
  const returnedMinor = typeof returnedPayable === 'string' &&
    /^(?:0|[1-9]\d*)\.\d{2}$/.test(returnedPayable)
      ? Math.round(Number(returnedPayable) * 100) : null;
  if (envelope?.item2?.isSuccess !== true || !receipt ||
      !nonEmpty(receipt.pnr) || receipt.pnr.trim().length <= 2 ||
      !nonEmpty(receipt.bookingCodeRef) ||
      !response.supplierPublicRef ||
      !nonEmpty(receipt.bookingStatus) ||
      receipt.uniqueTransID !== refs.uniqueTransId ||
      receipt.itemCodeRef !== refs.itemCodeRef ||
      receipt.priceCodeRef !== refs.priceCodeRef ||
      (returnedPayable !== undefined && returnedMinor !== expectedMinor) ||
      receipt.ticketCodeRef != null || receipt.ticketInfoes != null) {
    throw new ShapontravelsWriteError('protocol', 'UNVERIFIED_HOLD_RESPONSE', 200);
  }
  return {
    submittedPassengers,
    outcome: {
      status: 'held',
      pnr: receipt.pnr,
      // Shapontravels exposes the verified record locator as `pnr` and has
      // no separate airlinesPNR array in its hold receipt contract.
      airlinesPnr: [receipt.pnr],
      bookingRefNumber: nonEmpty(receipt.bookingRefNumber) ? receipt.bookingRefNumber : null,
      supplierPublicRef: response.supplierPublicRef,
      bookingStatus: receipt.bookingStatus,
      ticketingTimeLimit: nonEmpty(receipt.ticketingTimeLimit) ? receipt.ticketingTimeLimit : null,
      bookingCodeRef: receipt.bookingCodeRef,
      supplierRefs: refs,
      ticketCodeRef: null,
      ticketNumbers: [],
      warnings: [],
      message: null,
    },
  };
}
