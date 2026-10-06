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

const CURRENT_STATUSES = [
  'pending', 'on-hold', 'confirmed', 'in-progress', 'cancelled', 'expired', 'unconfirmed',
] as const;
const CURRENT_SOURCES = [
  'supplier_pnr', 'ticket_operation', 'cancellation_operation', 'admin_decision',
  'staff_manual', 'saved_booking', 'saved_import', 'public_receipt',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ShapontravelsCurrentStatus = {
  status: typeof CURRENT_STATUSES[number];
  bookingState: string | null;
  supplierStatus: string | null;
  supplierCheckedAt: string | null;
  verified: boolean;
  source: typeof CURRENT_SOURCES[number];
  checkedAt: string | null;
  reviewRequired: boolean | null;
  lastCheck: {
    checkedAt: string;
    verified: boolean;
    reasonCode: string | null;
  } | null;
};

export type ShapontravelsBookingStatus = {
  result: 'verified' | 'pending' | 'not_found' | 'unverified' | 'mismatch';
  currentStatus: ShapontravelsCurrentStatus | null;
  currentStatusState: 'available' | 'absent' | 'invalid';
  originalBookingStatus: string | null;
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

function nullableText(value: unknown, max = 100): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.trim() && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

/** Keep the saved timestamp and offset; a GET time is not a supplier check. */
function evidenceTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return undefined;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return undefined;
  return value;
}

type CurrentMetadata = Pick<ShapontravelsBookingStatus, 'currentStatus' | 'currentStatusState'>;

function currentMetadata(envelope: Record<string, unknown>, allowSavedPublic = false): CurrentMetadata {
  if (!Object.hasOwn(envelope, 'currentStatus')) {
    return { currentStatus: null, currentStatusState: 'absent' };
  }
  const invalid: CurrentMetadata = { currentStatus: null, currentStatusState: 'invalid' };
  const current = object(envelope.currentStatus);
  if (!current || !CURRENT_STATUSES.includes(current.status as ShapontravelsCurrentStatus['status'])) return invalid;
  // Public machine receipts deliberately withhold private state and supplier
  // check details. Keep their saved status without inventing that evidence.
  const compact = Object.keys(current).length === 2 &&
    Object.hasOwn(current, 'status') && Object.hasOwn(current, 'reviewRequired');
  const savedPublic = current.source === 'public_receipt' &&
    Object.keys(current).length === 9 && current.verified === false &&
    current.bookingState === null && current.supplierStatus === null &&
    current.supplierCheckedAt === null && current.checkedAt === null && current.lastCheck === null;
  if (compact || current.source === 'public_receipt') {
    if ((!compact && (!allowSavedPublic || !savedPublic)) ||
        typeof current.reviewRequired !== 'boolean') return invalid;
    let reviewRequired = current.reviewRequired;
    if (compact) {
      const receipt = object(envelope.publicReceipt);
      const actions = object(receipt?.actions);
      if (!receipt || receipt.status !== current.status ||
          typeof receipt.pendingReview !== 'boolean' || typeof actions?.canIssue !== 'boolean') return invalid;
      // A manually resolved or otherwise unusable hold can have review=false
      // while the public receipt correctly forbids issuing it.
      reviewRequired = reviewRequired || receipt.pendingReview ||
        (current.status === 'on-hold' && actions.canIssue !== true);
    }
    return {
      currentStatusState: 'available',
      currentStatus: {
        status: current.status as ShapontravelsCurrentStatus['status'],
        bookingState: null, supplierStatus: null, supplierCheckedAt: null,
        verified: false, source: 'public_receipt', checkedAt: null,
        reviewRequired, lastCheck: null,
      },
    };
  }
  if (
      !CURRENT_SOURCES.includes(current.source as ShapontravelsCurrentStatus['source']) ||
      typeof current.verified !== 'boolean') return invalid;
  const bookingState = nullableText(current.bookingState);
  const supplierStatus = nullableText(current.supplierStatus);
  const supplierCheckedAt = evidenceTime(current.supplierCheckedAt);
  const checkedAt = evidenceTime(current.checkedAt);
  if (bookingState === undefined || supplierStatus === undefined ||
      supplierCheckedAt === undefined || checkedAt === undefined ||
      (supplierStatus !== null && supplierCheckedAt === null)) return invalid;
  let reviewRequired: boolean | null = null;
  if (Object.hasOwn(current, 'reviewRequired')) {
    if (current.reviewRequired !== null && typeof current.reviewRequired !== 'boolean') return invalid;
    reviewRequired = current.reviewRequired;
  }
  let lastCheck: ShapontravelsCurrentStatus['lastCheck'] = null;
  if (Object.hasOwn(current, 'lastCheck') && current.lastCheck !== null) {
    const last = object(current.lastCheck);
    if (!last || typeof last.verified !== 'boolean') return invalid;
    const lastTime = evidenceTime(last.checkedAt);
    const reasonCode = Object.hasOwn(last, 'reasonCode') ? nullableText(last.reasonCode, 80) : null;
    if (!lastTime || reasonCode === undefined ||
        (reasonCode !== null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(reasonCode))) return invalid;
    lastCheck = { checkedAt: lastTime, verified: last.verified, reasonCode };
  }
  return {
    currentStatusState: 'available',
    currentStatus: {
      status: current.status as ShapontravelsCurrentStatus['status'],
      bookingState, supplierStatus, supplierCheckedAt, verified: current.verified,
      source: current.source as ShapontravelsCurrentStatus['source'], checkedAt,
      reviewRequired, lastCheck,
    },
  };
}

/** Validate saved current evidence without assigning receipt identity or freshness. */
export function parseShapontravelsCurrentStatus(value: unknown): ShapontravelsCurrentStatus | null {
  return currentMetadata({ currentStatus: value }, true).currentStatus;
}

/** Verify saved receipt identity before exposing independent current evidence. */
export function verifyShapontravelsBookingStatus(
  read: ShapontravelsBookingRead,
  expected: ShapontravelsExpectedBooking
): ShapontravelsBookingStatus {
  const base: Omit<ShapontravelsBookingStatus, 'result'> = {
    currentStatus: null,
    currentStatusState: 'absent',
    originalBookingStatus: null,
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
    const identityVerified = (!expected.supplierPublicRef || read.supplierPublicRef === expected.supplierPublicRef) &&
      (expected.bookingCodeRef ? pending?.bookingId === expected.bookingCodeRef
        : Boolean(expected.supplierPublicRef && read.supplierPublicRef === expected.supplierPublicRef));
    const metadata: CurrentMetadata = pending && identityVerified ? currentMetadata(pending) : {
      currentStatus: null,
      currentStatusState: pending && Object.hasOwn(pending, 'currentStatus') ? 'invalid' : 'absent',
    };
    return {
      ...base, ...metadata, result: 'pending',
      supplierStatus: metadata.currentStatus?.supplierStatus ?? null,
    };
  }

  const envelope = object(read.body);
  const receipt = object(envelope?.item1);
  const result = object(envelope?.item2);
  if (!envelope || !receipt || result?.isSuccess !== true || !read.supplierPublicRef ||
      !shortText(receipt.bookingCodeRef) || !shortText(receipt.pnr) ||
      !shortText(receipt.bookingStatus)) {
    return { ...base, result: 'unverified' };
  }
  // Current public receipts publish the PNR in this field; older local rows
  // retain the private UUID. All remaining receipt and PNR pins still match.
  const legacyPublicReference = UUID.test(expected.bookingRefNumber ?? '') &&
    Boolean(expected.pnr) && receipt.bookingRefNumber === expected.pnr;
  if (receipt.uniqueTransID !== expected.uniqueTransId ||
      receipt.itemCodeRef !== expected.itemCodeRef ||
      receipt.priceCodeRef !== expected.priceCodeRef ||
      (expected.bookingCodeRef && receipt.bookingCodeRef !== expected.bookingCodeRef) ||
      (expected.bookingRefNumber && receipt.bookingRefNumber !== expected.bookingRefNumber &&
        !legacyPublicReference) ||
      (expected.pnr && receipt.pnr !== expected.pnr) ||
      (expected.supplierPublicRef && read.supplierPublicRef !== expected.supplierPublicRef)) {
    return { ...base, result: 'mismatch' };
  }
  const metadata = currentMetadata(envelope);
  const originalBookingStatus = shortText(receipt.bookingStatus);
  return {
    ...base,
    ...metadata,
    result: 'verified',
    originalBookingStatus,
    supplierStatus: metadata.currentStatusState === 'absent'
      ? originalBookingStatus : metadata.currentStatus?.supplierStatus ?? null,
    pnr: shortText(receipt.pnr),
    ticketingTimeLimit: shortText(receipt.ticketingTimeLimit),
    ticketedEvidencePresent: Boolean(shortText(receipt.ticketCodeRef)) ||
      (Array.isArray(receipt.ticketInfoes) && receipt.ticketInfoes.length > 0),
  };
}
