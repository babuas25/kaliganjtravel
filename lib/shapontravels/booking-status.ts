import type { ShapontravelsBookingRead } from './client';

export type ShapontravelsExpectedBooking = {
  uniqueTransId: string;
  itemCodeRef: string;
  priceCodeRef: string;
  bookingCodeRef?: string | null;
  bookingRefNumber?: string | null;
  pnr?: string | null;
  supplierPublicRef?: string | null;
};

export type ShapontravelsBookingStatus = {
  result: 'verified' | 'pending' | 'not_found' | 'unverified' | 'mismatch';
  supplierStatus: string | null;
  supplierPublicRef: string | null;
  pnr: string | null;
  ticketingTimeLimit: string | null;
  ticketedEvidencePresent: boolean;
  checkedAt: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function shortText(value: unknown, max = 100): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim() : null;
}

/** Exact identity checks before a supplier read can be shown as verified. */
export function verifyShapontravelsBookingStatus(
  read: ShapontravelsBookingRead,
  expected: ShapontravelsExpectedBooking
): ShapontravelsBookingStatus {
  const base = {
    supplierStatus: null,
    supplierPublicRef: read.supplierPublicRef,
    pnr: null,
    ticketingTimeLimit: null,
    ticketedEvidencePresent: false,
    checkedAt: new Date().toISOString(),
  };
  if (read.httpStatus === 404) return { ...base, result: 'not_found' };
  if (expected.supplierPublicRef && read.supplierPublicRef &&
      expected.supplierPublicRef !== read.supplierPublicRef) {
    return { ...base, result: 'mismatch' };
  }
  if (read.httpStatus === 202) {
    const pending = object(read.body);
    if (expected.bookingCodeRef && shortText(pending?.bookingId) &&
        pending?.bookingId !== expected.bookingCodeRef) {
      return { ...base, result: 'mismatch' };
    }
    return { ...base, result: 'pending' };
  }

  const envelope = object(read.body);
  const receipt = object(envelope?.item1);
  const result = object(envelope?.item2);
  if (!receipt || result?.isSuccess !== true || !read.supplierPublicRef ||
      !shortText(receipt.bookingCodeRef) || !shortText(receipt.pnr) ||
      !shortText(receipt.bookingStatus)) {
    return { ...base, result: 'unverified' };
  }
  if (receipt.uniqueTransID !== expected.uniqueTransId ||
      receipt.itemCodeRef !== expected.itemCodeRef ||
      receipt.priceCodeRef !== expected.priceCodeRef ||
      (expected.bookingCodeRef && receipt.bookingCodeRef !== expected.bookingCodeRef) ||
      (expected.bookingRefNumber && receipt.bookingRefNumber !== expected.bookingRefNumber) ||
      (expected.pnr && receipt.pnr !== expected.pnr) ||
      (expected.supplierPublicRef && read.supplierPublicRef !== expected.supplierPublicRef)) {
    return { ...base, result: 'mismatch' };
  }
  return {
    ...base,
    result: 'verified',
    supplierStatus: shortText(receipt.bookingStatus),
    pnr: shortText(receipt.pnr),
    ticketingTimeLimit: shortText(receipt.ticketingTimeLimit),
    ticketedEvidencePresent: Boolean(shortText(receipt.ticketCodeRef)) ||
      (Array.isArray(receipt.ticketInfoes) && receipt.ticketInfoes.length > 0),
  };
}
