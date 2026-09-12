export const SUPPLIER_EVIDENCE_NORMALIZER_VERSION = 1 as const;
export const SUPPLIER_EVIDENCE_FRESHNESS_MS = 5 * 60_000;

export type SupplierReadReceipt = {
  requestStartedAt: string;
  responseReceivedAt: string;
  httpStatus: number;
  rawPayloadHash: string;
};

type EvidenceBase<
  TSource extends 'pnr' | 'air-ticketing-details',
  TIdentity,
  TFacts,
> = {
  schemaVersion: 1;
  normalizerVersion: 1;
  supplier: 'triplover';
  source: TSource;
  observedAt: string;
  freshUntil: string;
  receipt: SupplierReadReceipt;
  identity: TIdentity;
  facts: TFacts;
};

export type NormalizedPnrEvidence = EvidenceBase<
  'pnr',
  {
    uniqueTransId: string;
    requestedPnr: string;
    bookingRefNumber: string;
    bookingCodeRef: string;
    itemCodeRef: string;
    priceCodeRef: string;
  },
  {
    responsePnr: string;
    supplierStatus: string | null;
    airlinesPnr: string[];
    /**
     * Exact `uniqueTransID` values the supplier returned from the PNR payload
     * or its response envelope. These are never copied from the PNR request.
     * An empty array means the supplier did not surface an echo on this read.
     */
    supplierEchoedUniqueTransIds: string[];
    rawLastTicketTime: string | null;
    ticketingDeadlineAt: string | null;
  }
>;

export type AirTicketingQueryStatus =
  | 'Confirmed'
  | 'Cancelled'
  | 'Refunded';

export type NormalizedAirTicketingEvidence = EvidenceBase<
  'air-ticketing-details',
  {
    uniqueTransId: string;
    queryStatus: AirTicketingQueryStatus;
  },
  {
    supplierStatus: string | null;
    pnr: string | null;
    airlinesPnr: string[];
    /** Echoed by Triplover's `ticketInfo.uniqueTransID`; never inferred locally. */
    ticketInfoUniqueTransId: string | null;
    /** Triplover's numeric internal `ticketInfo.bookingId`; never inferred locally. */
    supplierBookingId: number | null;
    ticketCodeRef: string | null;
    ticketNumbers: string[];
    passengerCount: number | null;
    passengerIdentityHashes: string[];
    routeSignature: string | null;
    issuedAt: string | null;
    cancelledAt: string | null;
  }
>;

export type NormalizedSupplierEvidence =
  | NormalizedPnrEvidence
  | NormalizedAirTicketingEvidence;

function freshUntil(receipt: SupplierReadReceipt): string {
  return new Date(
    Date.parse(receipt.responseReceivedAt) + SUPPLIER_EVIDENCE_FRESHNESS_MS
  ).toISOString();
}

export function normalizedPnrEvidence(input: {
  receipt: SupplierReadReceipt;
  identity: NormalizedPnrEvidence['identity'];
  facts: NormalizedPnrEvidence['facts'];
}): NormalizedPnrEvidence {
  return {
    schemaVersion: 1,
    normalizerVersion: SUPPLIER_EVIDENCE_NORMALIZER_VERSION,
    supplier: 'triplover',
    source: 'pnr',
    observedAt: input.receipt.responseReceivedAt,
    freshUntil: freshUntil(input.receipt),
    receipt: input.receipt,
    identity: input.identity,
    facts: input.facts,
  };
}

export function normalizedAirTicketingEvidence(input: {
  receipt: SupplierReadReceipt;
  identity: NormalizedAirTicketingEvidence['identity'];
  facts: NormalizedAirTicketingEvidence['facts'];
}): NormalizedAirTicketingEvidence {
  return {
    schemaVersion: 1,
    normalizerVersion: SUPPLIER_EVIDENCE_NORMALIZER_VERSION,
    supplier: 'triplover',
    source: 'air-ticketing-details',
    observedAt: input.receipt.responseReceivedAt,
    freshUntil: freshUntil(input.receipt),
    receipt: input.receipt,
    identity: input.identity,
    facts: input.facts,
  };
}
