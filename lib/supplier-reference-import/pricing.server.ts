import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { DashboardSession } from '@/lib/dashboard/session';
import { activeMarkupRulesFor } from '@/lib/db/markup-rules';
import { pricingAudienceForPrincipal } from '@/lib/flights/pricing-principal';
import { resolveBookingActorContext } from '@/lib/flights/staff-booking.server';
import type { SearchRoute } from '@/lib/flights/types';
import { priceOffer, selectMarkupRules } from '@/lib/markup';
import type {
  SupplierReferenceBooking,
  SupplierReferenceEvidence,
} from '@/lib/supplier-reference-import/types';

const PRICING_MODE = 'import_time_current_markup' as const;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export class SupplierReferencePricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'SupplierReferencePricingError';
  }
}

type ConfirmationPayload = {
  version: 1;
  actorUserId: string;
  assignedUserId: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
};

function confirmationSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new SupplierReferencePricingError(
      'PRICING_CONFIRMATION_UNAVAILABLE',
      'Secure supplier-import pricing confirmation is unavailable.',
      503,
    );
  }
  return secret;
}

function routesOf(evidence: SupplierReferenceEvidence): SearchRoute[] {
  return evidence.itinerary.legs.map((leg) => {
    const departureDate = leg.departure.slice(0, 10);
    if (
      !/^[A-Z]{3}$/.test(leg.from) || !/^[A-Z]{3}$/.test(leg.to) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(departureDate)
    ) {
      throw new SupplierReferencePricingError(
        'UNSUPPORTED_SUPPLIER_PRICING_EVIDENCE',
        'Supplier itinerary cannot be converted to the canonical pricing route contract.',
      );
    }
    return { origin: leg.from, destination: leg.to, departureDate };
  });
}

function fingerprintOf(booking: SupplierReferenceBooking): string {
  const stableEvidence = {
    supplierAccount: booking.supplierAccount,
    supplierReference: booking.supplierReference,
    supplierStatus: booking.supplierStatus,
    lifecycleStatus: booking.lifecycleStatus,
    storedStatus: booking.storedStatus,
    currency: booking.currency,
    supplierPayable: booking.supplierPayable,
    supplierGross: booking.supplierGross,
    supplierDiscount: booking.supplierDiscount,
    passengerCounts: booking.passengerCounts,
    travelDate: booking.travelDate,
    itinerary: booking.itinerary,
    supplierFares: booking.supplierFares,
    supplierRefs: booking.supplierRefs,
    bookingCodeRef: booking.bookingCodeRef,
    ticketCodeRef: booking.ticketCodeRef,
    pnr: booking.pnr,
    bookingRefNumber: booking.bookingRefNumber,
    airlinesPnr: booking.airlinesPnr,
    ticketNumbers: booking.ticketNumbers,
    ticketingTimeLimit: booking.ticketingTimeLimit,
    ticketingDeadlineAt: booking.ticketingDeadlineAt,
    bookedAt: booking.bookedAt,
    issuedAt: booking.issuedAt,
    cancelledAt: booking.cancelledAt,
    pricingMode: booking.pricingMode,
    pricingCarrierCode: booking.pricingCarrierCode,
    pricingRoutes: booking.pricingRoutes,
    fares: booking.fares,
    pricingSnapshot: booking.pricingSnapshot,
  };
  return createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex');
}

export async function priceSupplierReferenceBooking(input: {
  session: DashboardSession;
  assignedUserId: string;
  evidence: SupplierReferenceEvidence;
}): Promise<{ booking: SupplierReferenceBooking; fingerprint: string }> {
  if (input.evidence.currency !== 'BDT') {
    throw new SupplierReferencePricingError(
      'UNSUPPORTED_SUPPLIER_CURRENCY',
      'Supplier API Import pricing currently supports BDT only.',
    );
  }
  const actorContext = await resolveBookingActorContext(
    input.session,
    input.assignedUserId,
  );
  if (!actorContext || actorContext.ownerUserId !== input.assignedUserId) {
    throw new SupplierReferencePricingError(
      'INVALID_IMPORT_ASSIGNEE',
      'Assign an eligible B2B, Sub User, or Customer before pricing.',
      400,
    );
  }
  const audience = pricingAudienceForPrincipal(actorContext.principal);
  const rulesResult = await activeMarkupRulesFor(audience);
  if (!rulesResult.ok) {
    throw new SupplierReferencePricingError(
      'PRICING_RULES_UNAVAILABLE',
      'Current markup rules could not be loaded; supplier import pricing was not estimated.',
      503,
    );
  }
  const pricingRoutes = routesOf(input.evidence);
  const carrierCode = input.evidence.itinerary.carrierCode.toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(carrierCode)) {
    throw new SupplierReferencePricingError(
      'AMBIGUOUS_PRICING_CARRIER',
      'Supplier booking has no unambiguous two-character carrier for markup selection.',
    );
  }
  const selectedRules = selectMarkupRules(
    rulesResult.rules,
    audience,
    carrierCode,
    pricingRoutes,
  );
  const supplierFares = input.evidence.supplierFares;
  const priced = priceOffer({
    audience,
    rulesAvailable: rulesResult.ok,
    rules: selectedRules,
    supplierTotalPrice: input.evidence.supplierPayable,
    basePrice: supplierFares.reduce((sum, fare) => sum + fare.basePrice, 0),
    taxes: supplierFares.reduce((sum, fare) => sum + fare.taxes, 0),
    ait: supplierFares.reduce((sum, fare) => sum + fare.ait, 0),
    fares: supplierFares,
    passengerCount: supplierFares.reduce((sum, fare) => sum + fare.count, 0),
  });
  if (!Number.isFinite(priced.totalPrice) || priced.totalPrice <= 0) {
    throw new SupplierReferencePricingError(
      'INVALID_CANONICAL_PRICE',
      'Canonical pricing did not produce a positive User Payable.',
    );
  }
  const pricingCalculatedAt = new Date().toISOString();
  const booking: SupplierReferenceBooking = {
    ...input.evidence,
    fares: priced.fares,
    pricingSnapshot: priced.snapshot,
    pricingMode: PRICING_MODE,
    pricingCalculatedAt,
    supplierEvidenceTimestamp: input.evidence.retrievedAt,
    pricingCarrierCode: carrierCode,
    pricingRoutes,
  };
  return { booking, fingerprint: fingerprintOf(booking) };
}

export function createSupplierPricingConfirmation(input: {
  actorUserId: string;
  assignedUserId: string;
  fingerprint: string;
}): string {
  const issuedAt = new Date();
  const payload: ConfirmationPayload = {
    version: 1,
    actorUserId: input.actorUserId,
    assignedUserId: input.assignedUserId,
    fingerprint: input.fingerprint,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + CONFIRMATION_TTL_MS).toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', confirmationSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

export function assertSupplierPricingConfirmation(input: {
  confirmation: string;
  actorUserId: string;
  assignedUserId: string;
  fingerprint: string;
}): void {
  const [encoded, signature, extra] = input.confirmation.split('.');
  if (!encoded || !signature || extra) {
    throw new SupplierReferencePricingError(
      'SUPPLIER_REFERENCE_PRICING_CHANGED',
      'Retrieve the booking again to confirm the current supplier evidence and User Payable.',
    );
  }
  const expected = createHmac('sha256', confirmationSecret())
    .update(encoded)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  let payload: ConfirmationPayload | null = null;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConfirmationPayload;
  } catch {
    payload = null;
  }
  if (
    actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
    !payload || payload.version !== 1 ||
    payload.actorUserId !== input.actorUserId ||
    payload.assignedUserId !== input.assignedUserId ||
    payload.fingerprint !== input.fingerprint ||
    !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()
  ) {
    throw new SupplierReferencePricingError(
      'SUPPLIER_REFERENCE_PRICING_CHANGED',
      'Supplier evidence or applicable pricing changed. Retrieve and confirm the booking again.',
    );
  }
}

export function supplierPricingErrorResponse(error: unknown) {
  return error instanceof SupplierReferencePricingError
    ? { code: error.code, message: error.message, status: error.status }
    : null;
}
