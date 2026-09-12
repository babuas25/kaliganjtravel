import { NextRequest, NextResponse } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { canAccessImpExp } from '@/lib/impexp/access';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { retrieveSupplierReferenceBooking } from '@/lib/supplier-reference-import/retrieve.server';
import {
  createSupplierPricingConfirmation,
  priceSupplierReferenceBooking,
  supplierPricingErrorResponse,
} from '@/lib/supplier-reference-import/pricing.server';
import type { SupplierReferenceBookingPreview } from '@/lib/supplier-reference-import/types';
import { supplierReferenceLookupSchema } from '@/lib/supplier-reference-import/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json(
      { error: 'Supplier API Import access is forbidden.' },
      { status: 403 },
    );
  }
  const limit = await checkActionLimit(
    'impexpRetrieve',
    `supplier-reference:user:${session.clerkId}`,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: rateLimitMessage(limit.retryAfterSeconds) },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = supplierReferenceLookupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Check the supplier reference.' },
      { status: 400 },
    );
  }

  try {
    const evidence = await retrieveSupplierReferenceBooking(parsed.data);
    const priced = await priceSupplierReferenceBooking({
      session,
      assignedUserId: parsed.data.assignedToUserId,
      evidence,
    });
    const booking = priced.booking;
    const preview: SupplierReferenceBookingPreview = {
      supplierAccount: booking.supplierAccount,
      supplierReference: booking.supplierReference,
      supplierStatus: booking.supplierStatus,
      status: booking.lifecycleStatus,
      currency: booking.currency,
      supplierPayable: booking.supplierPayable,
      supplierGross: booking.supplierGross,
      userPayable: booking.pricingSnapshot.sellingPrice,
      pricingMode: booking.pricingMode,
      pricingCalculatedAt: booking.pricingCalculatedAt,
      pricingConfirmation: createSupplierPricingConfirmation({
        actorUserId: session.clerkId,
        assignedUserId: parsed.data.assignedToUserId,
        fingerprint: priced.fingerprint,
      }),
      passengerCount: Object.values(booking.passengerCounts).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
      route: booking.itinerary.legs
        .map((leg) => `${leg.from}-${leg.to}`)
        .join(', '),
      airline: booking.itinerary.carrierName,
      pnr: booking.pnr,
      airlinesPnr: booking.airlinesPnr,
      ticketCount: booking.ticketNumbers.length,
      travelDate: booking.travelDate,
      ticketingDeadlineAt: booking.ticketingDeadlineAt,
      walletChargeAllowed: booking.lifecycleStatus === 'confirmed',
    };
    return NextResponse.json(
      { success: true, preview },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[supplier-reference-import] preview failed:', error);
    const pricingError = supplierPricingErrorResponse(error);
    return NextResponse.json(
      {
        ...(pricingError ? { code: pricingError.code } : {}),
        error:
          pricingError?.message ?? (error instanceof Error
            ? error.message
            : 'Supplier booking could not be retrieved.'),
      },
      { status: pricingError?.status ?? 502 },
    );
  }
}
