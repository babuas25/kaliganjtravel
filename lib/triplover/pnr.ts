import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import type { CanonicalSupplierEvidenceV2 } from '@/lib/booking-lifecycle/canonical-supplier-evidence-v2';
import {
  normalizedPnrEvidence,
  type NormalizedPnrEvidence,
} from '@/lib/booking-lifecycle/supplier-evidence';
import type { PrivateBookingRefs } from '@/lib/flights/booking';
import { TriploverError, triploverCall } from '@/lib/triplover/client';
import { adaptTriploverPnrEvidenceV2 } from '@/lib/triplover/canonical-evidence-v2';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { supplierLifecycleInstant } from '@/lib/triplover/time';

export type PnrLookupInput = PrivateBookingRefs & {
  /** Persisted credential account for this booking/search workflow. */
  supplier: TriploverSupplier;
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  /** Validating carrier used for supplier-specific slash-date ordering. */
  carrierCode?: string | null;
  /** Booking/submission instant used to reject an impossible pre-booking TTL. */
  deadlineNotBefore?: string | null;
  /** A bounded read budget for background PNR-refresh work. */
  timeoutMs?: number;
};

export type PnrLookupOutcome = {
  pnr: string;
  /** Airline-side locator(s), distinct from Triplover's primary/GDS PNR. */
  airlinesPnr: string[];
  status: string | null;
  /** Supplier value retained for diagnostics; may be ambiguous day/month. */
  rawLastTicketTime: string | null;
  /**
   * Exact supplier-returned transaction echoes from the PNR payload and
   * envelope. These values are never taken from the request reference.
   */
  supplierEchoedUniqueTransIds: string[];
  /** Normalized Bangladesh wall clock retained for staff diagnostics. */
  lastTicketTime: string | null;
  /** Explicit ISO instant used for persistence and lifecycle comparisons. */
  ticketingDeadlineAt: string | null;
  /** V1 remains available to existing non-reconciliation sync observations. */
  evidence: NormalizedPnrEvidence;
  /** New reconciliation reads consume only this separate V2 contract. */
  reconciliationEvidenceV2: CanonicalSupplierEvidenceV2;
};

/**
 * Booking PNR and booking-reference are distinct for some suppliers. Keep the
 * two values separate all the way to `/api/pnr`; collapsing them happens to
 * work for many records but fails for suppliers that issue different locators.
 */
export function pnrLookupLocators(input: {
  pnr?: string | null;
  bookingRefNumber?: string | null;
}): { pnr: string; bookingRefNumber: string } | null {
  const pnr = input.pnr?.trim() || input.bookingRefNumber?.trim() || '';
  if (!pnr) return null;
  return {
    pnr,
    bookingRefNumber: input.bookingRefNumber?.trim() || pnr,
  };
}

/**
 * Retains every non-empty, supplier-returned PNR transaction echo byte for
 * byte. PNR may expose the identifier in its domain payload, its envelope, or
 * both. Keep all values so a contradictory response cannot be silently hidden
 * by choosing one. The request's `UniqueTransID` is deliberately not an input.
 */
function supplierPnrUniqueTransIdEchoes(
  payload: Record<string, unknown>,
  envelopeUniqueTransIds: unknown
): string[] {
  const echoes: string[] = [];
  for (const value of [
    payload.uniqueTransID,
    payload.uniqueTransId,
    payload.UniqueTransID,
    payload.UniqueTransId,
  ]) {
    if (typeof value === 'string' && value.trim().length > 0 && !echoes.includes(value)) {
      echoes.push(value);
    }
  }
  if (Array.isArray(envelopeUniqueTransIds)) {
    for (const value of envelopeUniqueTransIds) {
      if (typeof value === 'string' && value.trim().length > 0 && !echoes.includes(value)) {
        echoes.push(value);
      }
    }
  }
  return echoes;
}

type DeadlineParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function validDeadline(parts: DeadlineParts): boolean {
  const parsed = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return parsed.getUTCFullYear() === parts.year &&
    parsed.getUTCMonth() === parts.month - 1 &&
    parsed.getUTCDate() === parts.day;
}

function deadlineInstant(parts: DeadlineParts): number {
  // Supplier wall-clock dates are Bangladesh time (UTC+6).
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour - 6,
    parts.minute,
    parts.second
  );
}

function normalizedDeadline(parts: DeadlineParts): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/**
 * Triplover PNR slash dates are not consistent across credential accounts and
 * validating carriers. FirstTrip and the direct Triplover account use
 * MM/DD/YYYY for US-Bangla (BS) and DD/MM/YYYY otherwise. TakeOff uses
 * MM/DD/YYYY for all carriers. The booking instant remains a safety check: if
 * the preferred interpretation predates the booking, use the viable alternate.
 */
export function normalizePnrLastTicketTime(
  value: unknown,
  deadlineNotBefore?: string | number | Date | null,
  carrierCode?: string | null,
  supplier: TriploverSupplier = 'firsttrip'
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim()
  );
  if (!match) {
    throw new TriploverError(
      'protocol',
      'Triplover PNR returned an unrecognised lastTicketTime.'
    );
  }
  const [, first, second, year, hour, minute, secondOfMinute] = match;
  const common = {
    year: Number(year),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(secondOfMinute),
  };
  const dayFirst = { ...common, day: Number(first), month: Number(second) };
  const monthFirst = { ...common, day: Number(second), month: Number(first) };
  const dayFirstValid = validDeadline(dayFirst);
  const monthFirstValid = validDeadline(monthFirst);
  if (!dayFirstValid && !monthFirstValid) {
    throw new TriploverError(
      'protocol',
      'Triplover PNR returned an invalid lastTicketTime date.'
    );
  }

  const preferMonthFirst =
    carrierCode?.trim().toUpperCase() === 'BS' ||
    supplier === 'takeoff';
  let selected = preferMonthFirst
    ? monthFirstValid
      ? monthFirst
      : dayFirst
    : dayFirstValid
      ? dayFirst
      : monthFirst;
  const notBefore = deadlineNotBefore instanceof Date
    ? deadlineNotBefore.getTime()
    : typeof deadlineNotBefore === 'number'
      ? deadlineNotBefore
      : deadlineNotBefore
        ? Date.parse(deadlineNotBefore)
        : Number.NaN;
  if (dayFirstValid && monthFirstValid && Number.isFinite(notBefore)) {
    // Allow minor clock skew, but never accept a date weeks before creation
    // when the alternate interpretation is on/after the booking.
    const threshold = notBefore - 5 * 60 * 1000;
    const preferred = preferMonthFirst ? monthFirst : dayFirst;
    const alternate = preferMonthFirst ? dayFirst : monthFirst;
    const preferredPlausible = deadlineInstant(preferred) >= threshold;
    const alternatePlausible = deadlineInstant(alternate) >= threshold;
    if (!preferredPlausible && alternatePlausible) selected = alternate;
  }
  return normalizedDeadline(selected);
}

/** Safe read used to replace Book's provisional deadline with the live PNR TTL. */
export async function readPnr(input: PnrLookupInput): Promise<PnrLookupOutcome> {
  const call = await triploverCall('Pnr', '/api/pnr', {
    PNR: input.pnr,
    BookingRefNumber: input.bookingRefNumber,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, { supplier: input.supplier, timeoutMs: input.timeoutMs });
  if (!call.data || typeof call.data !== 'object') {
    throw new TriploverError('protocol', 'Triplover PNR returned no record.');
  }
  const raw = call.data as {
    pnr?: string;
    airlinePNRs?: unknown;
    status?: string;
    lastTicketTime?: unknown;
    uniqueTransID?: unknown;
    uniqueTransId?: unknown;
    UniqueTransID?: unknown;
    UniqueTransId?: unknown;
  };
  const rawLastTicketTime =
    typeof raw.lastTicketTime === 'string' && raw.lastTicketTime.trim()
      ? raw.lastTicketTime.trim()
      : null;
  const normalizedLastTicketTime = normalizePnrLastTicketTime(
    rawLastTicketTime,
    input.deadlineNotBefore,
    input.carrierCode,
    input.supplier
  );
  const ticketingDeadlineAt = supplierLifecycleInstant(
    input.supplier,
    normalizedLastTicketTime
  );
  const facts = {
    pnr: raw.pnr?.trim() || input.pnr,
    airlinesPnr: validAirlinePnrs(raw.airlinePNRs),
    status: raw.status?.trim() || null,
    supplierEchoedUniqueTransIds: supplierPnrUniqueTransIdEchoes(
      raw,
      call.uniqueTransIds
    ),
    rawLastTicketTime,
    lastTicketTime: normalizedLastTicketTime,
    ticketingDeadlineAt,
  };
  const reconciliationEvidenceV2 = adaptTriploverPnrEvidenceV2({
      supplier: input.supplier,
      receipt: call.receipt,
      request: {
        uniqueTransId: input.uniqueTransId,
        pnr: input.pnr,
        bookingRefNumber: input.bookingRefNumber,
        bookingCodeRef: input.bookingCodeRef,
        itemCodeRef: input.itemCodeRef,
        priceCodeRef: input.priceCodeRef,
      },
      raw: raw as Record<string, unknown>,
      envelopeUniqueTransIds: call.uniqueTransIds,
      ticketingDeadlineAt: facts.ticketingDeadlineAt,
    });
  return {
    ...facts,
    evidence: normalizedPnrEvidence({
      receipt: call.receipt,
      identity: {
        uniqueTransId: input.uniqueTransId,
        requestedPnr: input.pnr,
        bookingRefNumber: input.bookingRefNumber,
        bookingCodeRef: input.bookingCodeRef,
        itemCodeRef: input.itemCodeRef,
        priceCodeRef: input.priceCodeRef,
      },
      facts: {
        responsePnr: facts.pnr,
        supplierStatus: facts.status,
        airlinesPnr: facts.airlinesPnr,
        supplierEchoedUniqueTransIds: facts.supplierEchoedUniqueTransIds,
        rawLastTicketTime: facts.rawLastTicketTime,
        ticketingDeadlineAt: facts.ticketingDeadlineAt,
      },
    }),
    reconciliationEvidenceV2,
  };
}
