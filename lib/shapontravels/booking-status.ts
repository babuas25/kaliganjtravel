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
  'staff_manual', 'saved_booking', 'saved_import', 'airline_refresh', 'public_receipt', 'supplier_sync',
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
  canIssue?: boolean;
  canCancel?: boolean;
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

/** The reservation PNR is independent of the supplier's explicit airline locators. */
export function shapontravelsAirlinePnrs(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every(locator => typeof locator === 'string' && /^[A-Z0-9]{3,12}$/.test(locator))
    ? Array.from(new Set<string>(value)) : [];
}

export type ShapontravelsTicketNumberSource = 'airline_pnr' | 'platform_pnr' | null;

export type ShapontravelsPassengerTicket = {
  ticketNumbers: string[];
  ticketNumberSource: ShapontravelsTicketNumberSource;
};

export function isShapontravelsTicketNumberSource(value: unknown): value is ShapontravelsTicketNumberSource {
  return value === null || value === 'airline_pnr' || value === 'platform_pnr';
}

export function hasShapontravelsPlatformTickets(value: unknown): boolean {
  return Array.isArray(value) && value.some(row => object(row)?.ticketNumberSource === 'platform_pnr');
}

/** Immediate issue receipts use saved passenger order. Saved reads can expose explicit slots. */
export function shapontravelsTicketRowsInPassengerOrder(value: unknown, count: number): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length !== count || !count) return null;
  const rows = value.map(object);
  if (!rows.every((row): row is Record<string, unknown> => row !== null)) return null;
  if (!hasShapontravelsPlatformTickets(rows)) return rows;
  const ordered: Record<string, unknown>[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const slot = Object.hasOwn(row, 'passengerIndex') ? row.passengerIndex : index;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= count || ordered[slot]) return null;
    ordered[slot] = row;
  }
  return ordered;
}

type ReceiptEnvelope = {
  envelope: Record<string, unknown>;
  receipt: Record<string, unknown>;
  savedBooking: Record<string, unknown> | null;
};

function sameSavedData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameSavedData(value, right[index]));
  }
  const a = object(left), b = object(right);
  return Boolean(a && b && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => Object.hasOwn(b, key) && sameSavedData(a[key], b[key])));
}

/** Canonical rows may repeat one passenger ticket across multiple segments. */
function ticketIdentifierSet(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const identifiers = new Set<string>();
  for (const valueRow of value) {
    const row = object(valueRow);
    if (!row || !Array.isArray(row.ticketNumbers) || row.ticketNumbers.length === 0 ||
        row.ticketNumbers.some(number => typeof number !== 'string' ||
          number.length === 0 || number !== number.trim())) return null;
    for (const number of row.ticketNumbers as string[]) identifiers.add(number);
  }
  return Array.from(identifiers).sort();
}

/** Both authenticated reads must describe the same saved passenger/flight/ticket snapshot. */
export function matchingShapontravelsSavedTicketSnapshots(bookingBody: unknown, ticketBody: unknown): boolean {
  const booking = normalizeShapontravelsTicketEvidenceEnvelope(bookingBody);
  const ticket = normalizeShapontravelsTicketEvidenceEnvelope(ticketBody);
  if (!booking || !ticket) return false;
  if (!booking.savedBooking && !ticket.savedBooking) return true;
  if (!booking.savedBooking || !ticket.savedBooking) return false;
  return ['bookingId', 'reference', 'passengerInfoes', 'segments', 'ticketInfoes', 'fareBreakdown', 'ticketCodeRef']
    .every(key => sameSavedData(booking.savedBooking![key], ticket.savedBooking![key]));
}

/** Platform references use the canonical passenger associations on saved reads. */
export function normalizeShapontravelsTicketEvidenceEnvelope(body: unknown): ReceiptEnvelope | null {
  const received = normalizeShapontravelsReceiptEnvelope(body);
  const saved = object(received?.envelope.savedBooking);
  if (saved && (hasShapontravelsPlatformTickets(received?.receipt.ticketInfoes) ||
      hasShapontravelsPlatformTickets(saved.ticketInfoes))) {
    return normalizeShapontravelsSavedBookingEnvelope(body);
  }
  return received;
}

/**
 * The saved-v1 endpoint omits the legacy item1/item2 wrapper. Bind its complete
 * schema to both public projections before exposing the saved receipt fields.
 * A partial or failed legacy response must never fall back to saved data.
 */
export function normalizeShapontravelsReceiptEnvelope(body: unknown): ReceiptEnvelope | null {
  const envelope = object(body);
  if (!envelope) return null;
  if (Object.hasOwn(envelope, 'item1') || Object.hasOwn(envelope, 'item2')) {
    const receipt = object(envelope.item1), result = object(envelope.item2);
    return receipt && result?.isSuccess === true
      ? { envelope, receipt, savedBooking: null } : null;
  }
  return normalizeShapontravelsSavedBookingEnvelope(body);
}

/**
 * Read canonical saved-v1 state even when the API also retains a successful
 * legacy receipt. Neither failed wrappers nor contradictory duplicate fields
 * may be used to authorize a saved-status reconciliation.
 */
export function normalizeShapontravelsSavedBookingEnvelope(body: unknown): ReceiptEnvelope | null {
  const envelope = object(body);
  if (!envelope) return null;
  let legacyReceipt: Record<string, unknown> | null = null;
  if (Object.hasOwn(envelope, 'item1') || Object.hasOwn(envelope, 'item2')) {
    legacyReceipt = object(envelope.item1);
    if (!legacyReceipt || object(envelope.item2)?.isSuccess !== true) return null;
  }
  const saved = object(envelope.savedBooking);
  const current = object(envelope.currentStatus);
  const publicReceipt = object(envelope.publicReceipt);
  if (!saved || !current || !publicReceipt || saved.schemaVersion !== 1 ||
      typeof saved.reference !== 'string' || !/^STR[A-Z0-9]{6,32}$/.test(saved.reference) ||
      typeof saved.bookingId !== 'string' || !UUID.test(saved.bookingId) ||
      saved.bookingCodeRef !== saved.bookingId ||
      !['uniqueTransID', 'itemCodeRef', 'priceCodeRef'].every(key =>
        typeof saved[key] === 'string' && UUID.test(saved[key] as string)) ||
      !(saved.pnr === null || typeof saved.pnr === 'string' && /^[A-Z0-9]{3,12}$/.test(saved.pnr)) ||
      !(saved.bookingStatus === null || shortText(saved.bookingStatus)) ||
      !CURRENT_STATUSES.includes(saved.status as ShapontravelsCurrentStatus['status']) ||
      typeof saved.reviewRequired !== 'boolean' || typeof saved.requiresReconciliation !== 'boolean' ||
      saved.status !== current.status || saved.status !== publicReceipt.status ||
      typeof current.reviewRequired !== 'boolean' || saved.reviewRequired !== publicReceipt.pendingReview ||
      saved.paymentState !== publicReceipt.paymentState || saved.pnr !== publicReceipt.pnr ||
      !sameSavedData(saved.currentStatus, current) || !sameSavedData(saved.publicReceipt, publicReceipt) ||
      (Object.hasOwn(envelope, 'requiresReconciliation') &&
        envelope.requiresReconciliation !== saved.requiresReconciliation) ||
      (Object.hasOwn(envelope, 'bookingId') && envelope.bookingId !== saved.bookingId) ||
      (Object.hasOwn(envelope, 'status') && envelope.status !== saved.status) ||
      (Object.hasOwn(envelope, 'paymentState') && envelope.paymentState !== saved.paymentState) ||
      (Object.hasOwn(envelope, 'customerPaymentState') && envelope.customerPaymentState !== saved.paymentState) ||
      !Array.isArray(saved.passengerInfoes) || !Number.isSafeInteger(saved.passengerCount) ||
      Number(saved.passengerCount) <= 0 || saved.passengerCount !== saved.passengerInfoes.length ||
      !saved.passengerInfoes.every(passenger => object(passenger) !== null) ||
      !Array.isArray(saved.segments) || !saved.segments.every(segment => object(segment) !== null) ||
      !Array.isArray(saved.ticketInfoes) || !saved.ticketInfoes.every(ticket => object(ticket) !== null) ||
      !Array.isArray(saved.missingFields) || saved.missingFields.some(field =>
        typeof field !== 'string' || !field.startsWith('/'))) return null;
  const payment = object(saved.payment);
  if (!payment || Object.keys(payment).length !== 3 ||
      !['state', 'required', 'operationId'].every(key => Object.hasOwn(payment, key)) ||
      !(payment.state === null || typeof payment.state === 'string') ||
      !(payment.required === null || typeof payment.required === 'boolean') ||
      !(payment.operationId === null || typeof payment.operationId === 'string')) return null;
  // bookingRefNumber is the documented optional public PNR mirror.
  if (saved.bookingRefNumber != null && saved.bookingRefNumber !== saved.pnr &&
      (typeof saved.bookingRefNumber !== 'string' || !UUID.test(saved.bookingRefNumber))) return null;
  if (legacyReceipt) {
    if (!['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'pnr']
      .every(key => legacyReceipt![key] === saved[key])) return null;
    const legacyReference = legacyReceipt.bookingRefNumber;
    const savedReference = saved.bookingRefNumber ?? saved.pnr;
    if (legacyReference != null && legacyReference !== savedReference &&
        !(typeof legacyReference === 'string' && UUID.test(legacyReference) && savedReference === saved.pnr)) return null;
    if (Object.hasOwn(legacyReceipt, 'ticketInfoes')) {
      const legacyTickets = ticketIdentifierSet(legacyReceipt.ticketInfoes);
      const savedTickets = ticketIdentifierSet(saved.ticketInfoes);
      if (!legacyTickets || !savedTickets || !sameSavedData(legacyTickets, savedTickets)) return null;
    }
    if ((legacyReceipt.bookingStatus != null && saved.bookingStatus != null &&
          legacyReceipt.bookingStatus !== saved.bookingStatus) ||
        (Object.hasOwn(legacyReceipt, 'ticketCodeRef') && legacyReceipt.ticketCodeRef !== saved.ticketCodeRef) ||
        (Object.hasOwn(legacyReceipt, 'isCancel') &&
          (typeof legacyReceipt.isCancel !== 'boolean' || legacyReceipt.isCancel !== (saved.status === 'cancelled'))) ||
        (Object.hasOwn(legacyReceipt, 'issuedAt') && legacyReceipt.issuedAt !== saved.issuedAt) ||
        (Object.hasOwn(legacyReceipt, 'cancelledAt') && legacyReceipt.cancelledAt !== saved.cancelledAt)) return null;
  }
  const deadline = object(saved.ticketingDeadline);
  return {
    envelope,
    savedBooking: saved,
    receipt: { ...saved, bookingRefNumber: saved.bookingRefNumber ?? saved.pnr,
      ticketingTimeLimit: deadline?.raw ?? deadline?.iso ?? null },
  };
}

/** Group canonical segment tickets by their explicitly associated passenger. */
export function normalizeShapontravelsSavedTicketRows(
  saved: Record<string, unknown>
): Record<string, unknown>[] | null {
  if (!Array.isArray(saved.passengerInfoes) || !Array.isArray(saved.segments) ||
      !Array.isArray(saved.ticketInfoes)) return null;
  const passengers = saved.passengerInfoes.map(object);
  const segments = saved.segments.map(object);
  const passengerIds = passengers.map(passenger => shortText(passenger?.passengerId, 200));
  const segmentIds = segments.map(segment => shortText(segment?.segmentId, 200));
  if (!passengers.length || passengerIds.some(id => !id) ||
      new Set(passengerIds).size !== passengerIds.length || !segments.length ||
      segmentIds.some(id => !id) || new Set(segmentIds).size !== segmentIds.length) return null;
  const grouped = passengers.map((passenger, passengerIndex) => ({ passengerIndex,
    passengerInfo: passenger!, ticketNumbers: [] as string[], ticketNumberSource: null as string | null }));
  for (const value of saved.ticketInfoes) {
    const ticket = object(value), index = ticket?.passengerIndex;
    if (!ticket || typeof index !== 'number' || !Number.isSafeInteger(index) ||
        index < 0 || index >= passengers.length || ticket.passengerId !== passengerIds[index] ||
        !Array.isArray(ticket.ticketNumbers) || !ticket.ticketNumbers.length ||
        ticket.ticketNumbers.some(number => typeof number !== 'string' || !number.trim()) ||
        !(ticket.segmentIds === null || Array.isArray(ticket.segmentIds) &&
          ticket.segmentIds.every(id => typeof id === 'string' && segmentIds.includes(id)))) return null;
    const actual = object(ticket.passengerInfo), expected = passengers[index]!;
    const actualName = object(actual?.nameElement), expectedName = object(expected.nameElement);
    const titles = ['mr', 'mrs', 'ms', 'miss', 'mstr', 'master'];
    if (!actual || !actualName || !expectedName ||
        !['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(String(expected.passengerType)) ||
        !['Male', 'Female'].includes(String(expected.gender)) ||
        !titles.includes(String(expectedName.title).replace(/\.$/, '').toLowerCase()) ||
        !titles.includes(String(actualName.title).replace(/\.$/, '').toLowerCase()) ||
        typeof expectedName.firstName !== 'string' || !shortText(expectedName.lastName) ||
        actual.passengerType !== expected.passengerType || actual.gender !== expected.gender ||
        actualName.firstName !== expectedName.firstName || actualName.lastName !== expectedName.lastName ||
        (actualName.middleName && expectedName.middleName && actualName.middleName !== expectedName.middleName) ||
        actual.dateOfBirth !== expected.dateOfBirth) return null;
    const target = grouped[index]!;
    const source = ticket.ticketNumberSource ?? null;
    if (!isShapontravelsTicketNumberSource(source) ||
        (target.ticketNumbers.length > 0 && source !== target.ticketNumberSource)) return null;
    target.ticketNumberSource = source;
    for (const number of ticket.ticketNumbers as string[]) {
      if (!target.ticketNumbers.includes(number)) target.ticketNumbers.push(number);
    }
  }
  return grouped.some(row => row.ticketNumbers.length === 0) ? null : grouped;
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
export function evidenceTime(value: unknown): string | null | undefined {
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

/** Deadline proof is separate from the current-status source's Issue authority. */
export function shapontravelsHoldTicketingDeadline(
  read: ShapontravelsBookingRead,
  status: ShapontravelsBookingStatus,
): string | null {
  const envelope = object(read.body);
  const current = object(envelope?.currentStatus);
  const receipt = object(envelope?.publicReceipt);
  const actions = object(receipt?.actions);
  if (read.httpStatus !== 200 || status.result !== 'verified' || status.ticketedEvidencePresent ||
      envelope?.requiresReconciliation === true || current?.status !== 'on-hold' ||
      current.reviewRequired !== false || receipt?.status !== 'on-hold' ||
      receipt.pendingReview !== false || actions?.canIssue !== true) return null;
  // The receipt carries its own offset; never infer a timezone.
  const timestamp = evidenceTime(status.ticketingTimeLimit);
  return timestamp ? new Date(timestamp).toISOString() : null;
}

type CurrentMetadata = Pick<ShapontravelsBookingStatus, 'currentStatus' | 'currentStatusState'>;

/** The saved-v1 summary omits private state and operation-check timestamps. */
function savedSummaryMetadata(
  envelope: Record<string, unknown>, current: Record<string, unknown>, allowSavedPublic: boolean,
): CurrentMetadata {
  const invalid: CurrentMetadata = { currentStatus: null, currentStatusState: 'invalid' };
  if (typeof current.reviewRequired !== 'boolean' ||
      !(current.verified === null || typeof current.verified === 'boolean') ||
      !(current.source === null || CURRENT_SOURCES.includes(current.source as ShapontravelsCurrentStatus['source']))) {
    return invalid;
  }
  const supplierStatus = nullableText(current.supplierStatus);
  const supplierCheckedAt = evidenceTime(current.supplierCheckedAt);
  const savedSupplierSync = current.source === 'supplier_sync';
  const platformDecisionSummary = current.source === 'admin_decision' && current.verified === false &&
    supplierCheckedAt === null;
  if (supplierStatus === undefined || supplierCheckedAt === undefined ||
      (savedSupplierSync && (typeof current.verified !== 'boolean' ||
        (current.verified === true && supplierCheckedAt === null))) ||
      (supplierStatus !== null && supplierCheckedAt === null && !platformDecisionSummary)) return invalid;
  const observationSource = current.source === 'supplier_pnr' || current.source === 'airline_refresh';
  if ((current.source === null && (supplierStatus !== null || supplierCheckedAt !== null)) ||
      (observationSource && current.verified === true && supplierCheckedAt === null) ||
      (current.source === 'public_receipt' &&
        (current.verified === true || supplierStatus !== null || supplierCheckedAt !== null))) return invalid;

  let reviewRequired = current.reviewRequired;
  const receipt = object(envelope.publicReceipt);
  if (receipt || !allowSavedPublic) {
    const actions = object(receipt?.actions);
    if (!receipt || receipt.status !== current.status ||
        typeof receipt.pendingReview !== 'boolean' || typeof actions?.canIssue !== 'boolean') return invalid;
    reviewRequired = reviewRequired || receipt.pendingReview ||
      (current.status === 'on-hold' && actions.canIssue !== true);
  }
  // Platform ticket/cancellation state is not a saved supplier observation.
  // Use the existing conservative public projection when no such evidence is
  // present or its provenance/verification is unknown. Raw saved-v1 facts stay
  // in the original receipt; a GET timestamp never replaces missing evidence.
  const publicSummary = !savedSupplierSync &&
    (supplierCheckedAt === null || current.source === null || current.verified === null);
  if (!publicSummary && observationSource && current.verified !== true) return invalid;
  return {
    currentStatusState: 'available',
    currentStatus: {
      status: current.status as ShapontravelsCurrentStatus['status'],
      bookingState: null,
      supplierStatus: publicSummary ? null : supplierStatus,
      supplierCheckedAt: publicSummary ? null : supplierCheckedAt,
      verified: publicSummary ? false : current.verified as boolean,
      source: publicSummary ? 'public_receipt' : current.source as ShapontravelsCurrentStatus['source'],
      checkedAt: null, reviewRequired, lastCheck: null,
    },
  };
}

function currentMetadata(envelope: Record<string, unknown>, allowSavedPublic = false): CurrentMetadata {
  if (!Object.hasOwn(envelope, 'currentStatus')) {
    return { currentStatus: null, currentStatusState: 'absent' };
  }
  const invalid: CurrentMetadata = { currentStatus: null, currentStatusState: 'invalid' };
  const current = object(envelope.currentStatus);
  if (!current || !CURRENT_STATUSES.includes(current.status as ShapontravelsCurrentStatus['status'])) return invalid;
  const savedSummary = ['status', 'reviewRequired', 'supplierStatus', 'supplierCheckedAt', 'verified', 'source']
    .every(key => Object.hasOwn(current, key)) &&
    !['bookingState', 'checkedAt', 'lastCheck'].some(key => Object.hasOwn(current, key));
  if (savedSummary) return savedSummaryMetadata(envelope, current, allowSavedPublic);
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
  if (current.source === 'supplier_sync' &&
      (current.bookingState !== null || current.checkedAt !== null || current.lastCheck !== null ||
        typeof current.reviewRequired !== 'boolean' ||
        (current.verified === true && supplierCheckedAt === null))) return invalid;
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

function receiptCurrentMetadata(envelope: Record<string, unknown>): CurrentMetadata {
  const metadata = currentMetadata(envelope);
  const receipt = object(envelope.publicReceipt);
  const actions = object(receipt?.actions);
  if (metadata.currentStatus && receipt?.status === metadata.currentStatus.status) {
    if (typeof actions?.canIssue === 'boolean') metadata.currentStatus.canIssue = actions.canIssue;
    if (typeof actions?.canCancel === 'boolean') metadata.currentStatus.canCancel = actions.canCancel;
  }
  return metadata;
}

/** Used only after the caller has verified the booking or ticket receipt identity. */
export function shapontravelsWriteCurrentStatus(body: unknown, bookingId?: string): ShapontravelsCurrentStatus | undefined {
  const envelope = object(body);
  if (!envelope || (bookingId && Object.hasOwn(envelope, 'bookingId') && envelope.bookingId !== bookingId)) return;
  const { currentStatus } = receiptCurrentMetadata(envelope);
  if (currentStatus && object(envelope.publicReceipt)?.status === currentStatus.status &&
      (!Object.hasOwn(envelope, 'status') || envelope.status === currentStatus.status)) return currentStatus;
}

/** A matching pending Issue is display evidence only. It cannot prove issuance. */
export function shapontravelsPendingIssueStatus(
  body: unknown, bookingId: string,
): ShapontravelsCurrentStatus | undefined {
  const envelope = object(body);
  if (!envelope || !UUID.test(bookingId) || envelope.bookingId !== bookingId ||
      typeof envelope.issueId !== 'string' || !UUID.test(envelope.issueId) ||
      envelope.statusUrl !== `/api/bookings/${bookingId}/ticket` ||
      envelope.requiresReconciliation !== true || envelope.automaticRetryAllowed !== false ||
      (envelope.state !== 'pending' && envelope.state !== 'outcome_unknown')) return;

  if (Object.hasOwn(envelope, 'currentStatus') || Object.hasOwn(envelope, 'publicReceipt') ||
      Object.hasOwn(envelope, 'status')) {
    const current = shapontravelsWriteCurrentStatus(envelope);
    const actions = object(object(envelope.publicReceipt)?.actions);
    if (current?.status !== 'in-progress' || actions?.canIssue !== false || current.canCancel === true) return;
    return { ...current, reviewRequired: true, canCancel: false };
  }
  return {
    status: 'in-progress', reviewRequired: true, canIssue: false, canCancel: false,
    source: 'public_receipt', verified: false, bookingState: null, supplierStatus: null,
    supplierCheckedAt: null, checkedAt: null, lastCheck: null,
  };
}

/** Validate saved current evidence without assigning receipt identity or freshness. */
export function parseShapontravelsCurrentStatus(value: unknown): ShapontravelsCurrentStatus | null {
  const saved = object(value);
  if (!saved) return null;
  const { canCancel, canIssue, ...currentStatus } = saved;
  if ((Object.hasOwn(saved, 'canCancel') && typeof canCancel !== 'boolean') ||
      (Object.hasOwn(saved, 'canIssue') && typeof canIssue !== 'boolean')) return null;
  const status = currentMetadata({ currentStatus }, true).currentStatus;
  return status && {
    ...status,
    ...(typeof canCancel === 'boolean' ? { canCancel } : {}),
    ...(typeof canIssue === 'boolean' ? { canIssue } : {}),
  };
}

/** Verify saved receipt identity before exposing independent current evidence. */
export function verifyShapontravelsBookingStatus(
  read: ShapontravelsBookingRead,
  expected: ShapontravelsExpectedBooking,
  expectedResourceBookingId?: string,
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

  const body = object(read.body);
  const normalized = body && Object.hasOwn(body, 'savedBooking')
    ? normalizeShapontravelsSavedBookingEnvelope(body)
    : normalizeShapontravelsReceiptEnvelope(body);
  const envelope = normalized?.envelope, receipt = normalized?.receipt;
  if (read.httpStatus !== 200 || !envelope || !receipt || !read.supplierPublicRef ||
      !shortText(receipt.bookingCodeRef) || (!normalized?.savedBooking && !shortText(receipt.pnr)) ||
      (!shortText(receipt.bookingStatus) && !normalized?.savedBooking)) {
    return { ...base, result: 'unverified' };
  }
  // Current public receipts publish the PNR in this field; older local rows
  // retain the private UUID. All remaining receipt and PNR pins still match.
  const legacyPublicReference = UUID.test(expected.bookingRefNumber ?? '') &&
    Boolean(expected.pnr) && receipt.bookingRefNumber === expected.pnr;
  // The machine API may omit its optional PNR alias. Only the canonical PNR
  // mirror can be absent; all UUID, public STR and locator pins still match.
  const absentPublicReference = receipt.bookingRefNumber == null &&
    Boolean(expected.pnr) && expected.bookingRefNumber === expected.pnr && receipt.pnr === expected.pnr;
  if (receipt.uniqueTransID !== expected.uniqueTransId ||
      receipt.itemCodeRef !== expected.itemCodeRef ||
      receipt.priceCodeRef !== expected.priceCodeRef ||
      (expected.bookingCodeRef && receipt.bookingCodeRef !== expected.bookingCodeRef) ||
      (expected.bookingRefNumber && receipt.bookingRefNumber !== expected.bookingRefNumber &&
        !legacyPublicReference && !absentPublicReference) ||
      (expected.pnr && receipt.pnr !== expected.pnr) ||
      (expected.supplierPublicRef && read.supplierPublicRef !== expected.supplierPublicRef) ||
      (expectedResourceBookingId && (normalized?.savedBooking
        ? normalized.savedBooking.bookingId !== expectedResourceBookingId
        : Object.hasOwn(envelope, 'bookingId') && envelope.bookingId !== expectedResourceBookingId)) ||
      (normalized?.savedBooking && normalized.savedBooking.reference !== read.supplierPublicRef)) {
    return { ...base, result: 'mismatch' };
  }
  const metadata = receiptCurrentMetadata(envelope);
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
