import 'server-only';

import type { CanonicalSupplierEvidenceV2 } from '@/lib/booking-lifecycle/canonical-supplier-evidence-v2';
import {
  normalizedAirTicketingEvidence,
  type AirTicketingQueryStatus,
  type NormalizedAirTicketingEvidence,
} from '@/lib/booking-lifecycle/supplier-evidence';
import type { SupplierItineraryTerminalSegment } from '@/lib/flights/itinerary-terminals';
import { TriploverError, triploverCall } from '@/lib/triplover/client';
import { adaptTriploverTicketReportEvidenceV2 } from '@/lib/triplover/canonical-evidence-v2';
import type { TriploverSupplier } from '@/lib/triplover/config';

export type AirTicketingDetails = {
  supplierStatus: string | null;
  pnr: string | null;
  airlinesPnr: string[];
  ticketCodeRef: string | null;
  ticketNumbers: string[];
  passengerCount: number | null;
  passengerIdentityHashes: string[];
  routeSignature: string | null;
  /** Airline-authored endpoint terminals, in travel order. */
  segments: SupplierItineraryTerminalSegment[];
  issuedAt: string | null;
  cancelledAt: string | null;
  /** V1 remains available to existing non-reconciliation sync observations. */
  evidence: NormalizedAirTicketingEvidence;
  /** New reconciliation reads consume only this separate V2 contract. */
  reconciliationEvidenceV2?: CanonicalSupplierEvidenceV2;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(...values: unknown[]): string {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )?.trim() ?? '';
}

/** Accept a numeric terminal too: Triplover can report terminal `0`. */
function terminal(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ticketSegments(value: unknown): SupplierItineraryTerminalSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const segment = record(item);
    const originTerminal = terminal(segment.originTerminal);
    const destinationTerminal = terminal(segment.destinationTerminal);
    if (!originTerminal && !destinationTerminal) return [];

    return [{
      origin: text(segment.origin, segment.from, segment.originCode) || null,
      destination:
        text(segment.destination, segment.to, segment.destinationCode) || null,
      flightNumber: text(segment.flightNumber, segment.flightNo) || null,
      originTerminal,
      destinationTerminal,
    }];
  });
}

/** Reads Triplover's back-office ticket record for manual reconciliation. */
export async function readAirTicketingDetails(
  uniqueTransId: string,
  status: AirTicketingQueryStatus,
  supplier: TriploverSupplier,
  timeoutMs?: number
): Promise<AirTicketingDetails> {
  const call = await triploverCall(
    'AirTicketingDetails',
    `/api/B2BReport/AirTicketingDetails/${encodeURIComponent(uniqueTransId)}/${status}`,
    null,
    { supplier, method: 'GET', topLevelPayload: true, timeoutMs }
  );
  if (!call.data || typeof call.data !== 'object') {
    throw new TriploverError(
      'protocol',
      'Triplover AirTicketingDetails returned no record.'
    );
  }

  const raw = call.data as {
    ticketInfo?: Record<string, unknown>;
    passengerInfo?: Array<Record<string, unknown>>;
    segments?: unknown;
  };
  const ticket = raw.ticketInfo;
  if (!ticket) {
    throw new TriploverError(
      'protocol',
      'Triplover AirTicketingDetails returned no ticket information.'
    );
  }

  const evidence = adaptTriploverTicketReportEvidenceV2({
    supplier,
    receipt: call.receipt,
    requestedUniqueTransId: uniqueTransId,
    requestedStatus: status,
    raw: raw as Record<string, unknown>,
  });
  const facts = {
    supplierStatus: evidence.lifecycle.rawStatus,
    pnr: evidence.bookingIdentity.supplierPnr,
    airlinesPnr: evidence.bookingIdentity.airlinePnrs,
    ticketCodeRef: evidence.supplierWorkflowReference,
    ticketNumbers: evidence.tickets.map((item) => item.fullNumber),
    passengerCount: evidence.passengers.length || null,
    passengerIdentityHashes: evidence.passengers.map((item) => item.identityHash),
    routeSignature: evidence.itinerary.length
      ? evidence.itinerary
          .map((segment) => `${segment.origin}-${segment.destination}`)
          .join('|')
      : null,
    segments: ticketSegments(raw.segments),
    issuedAt: evidence.lifecycle.issuedAt,
    cancelledAt: evidence.lifecycle.cancelledAt,
  };
  return {
    ...facts,
    evidence: normalizedAirTicketingEvidence({
      receipt: call.receipt,
      identity: { uniqueTransId, queryStatus: status },
      facts: {
        supplierStatus: facts.supplierStatus,
        pnr: facts.pnr,
        airlinesPnr: facts.airlinesPnr,
        ticketInfoUniqueTransId: evidence.bookingIdentity.transactionId,
        supplierBookingId:
          evidence.bookingIdentity.supplierBookingId &&
          /^\d+$/.test(evidence.bookingIdentity.supplierBookingId)
            ? Number(evidence.bookingIdentity.supplierBookingId)
            : null,
        ticketCodeRef: facts.ticketCodeRef,
        ticketNumbers: facts.ticketNumbers,
        passengerCount: facts.passengerCount,
        passengerIdentityHashes: facts.passengerIdentityHashes,
        routeSignature: facts.routeSignature,
        issuedAt: facts.issuedAt,
        cancelledAt: facts.cancelledAt,
      },
    }),
    reconciliationEvidenceV2: evidence,
  };
}

/** Finds the supplier's latest decided ticket record across report filters. */
export async function readLatestAirTicketingDetails(
  uniqueTransId: string,
  supplier: TriploverSupplier
): Promise<AirTicketingDetails> {
  let lastError: unknown;
  for (const status of ['Cancelled', 'Confirmed', 'Refunded'] as const) {
    try {
      return await readAirTicketingDetails(uniqueTransId, status, supplier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new TriploverError(
    'supplier',
    'Triplover has no ticketing record for this booking.'
  );
}
