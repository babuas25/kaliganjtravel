import { NextRequest, NextResponse } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { createSupplierReferenceBooking } from '@/lib/db/supplier-reference-import';
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { canAccessImpExp } from '@/lib/impexp/access';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { retrieveSupplierReferenceBooking } from '@/lib/supplier-reference-import/retrieve.server';
import {
  assertSupplierPricingConfirmation,
  priceSupplierReferenceBooking,
  supplierPricingErrorResponse,
} from '@/lib/supplier-reference-import/pricing.server';
import { supplierReferenceImportSchema } from '@/lib/supplier-reference-import/validation';
import { majorToMinor } from '@/lib/wallet/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_IMPORT_DATA: { status: 400, message: 'Check the import details.' },
  INVALID_SUPPLIER_REFERENCE_IDENTITY: {
    status: 400,
    message: 'The supplier account and reference do not match.',
  },
  INVALID_IMPORT_ASSIGNEE: {
    status: 400,
    message: 'Assign an eligible B2B, Sub User, or Customer.',
  },
  ASSIGNEE_AGENCY_REQUIRED: {
    status: 409,
    message: 'The assigned B2B user has no agency wallet owner.',
  },
  CHARGE_DECISION_NOT_APPLICABLE: {
    status: 409,
    message: 'Wallet charge is available only for an issued or ticketed booking.',
  },
  FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED: {
    status: 409,
    message: 'Import & Charge requires a fresh unused authorization for these exact details.',
  },
  SUPPLIER_REFERENCE_ALREADY_EXISTS: {
    status: 409,
    message: 'This supplier reference already belongs to a local API booking.',
  },
  IMPORT_ASSIGNEE_MISMATCH: {
    status: 409,
    message: 'This supplier booking is already assigned to a different owner.',
  },
  IMPORT_PAYABLE_MISMATCH: {
    status: 409,
    message: 'This supplier booking already has a different protected User Payable.',
  },
  OPERATIONAL_REFERENCES_INCOMPLETE: {
    status: 409,
    message: 'The supplier did not return every reference required for normal API operations.',
  },
  COMPLETE_TICKET_EVIDENCE_REQUIRED: {
    status: 409,
    message: 'Confirmed import requires one supplier ticket number per passenger.',
  },
  WALLET_NOT_FOUND: { status: 409, message: 'The booking owner has no wallet.' },
  WALLET_ACCOUNT_NOT_FOUND: {
    status: 409,
    message: 'The booking owner has no wallet account in this currency.',
  },
  WALLET_FROZEN: { status: 409, message: 'The booking owner wallet is frozen.' },
  INSUFFICIENT_FUNDS: {
    status: 409,
    message: 'The booking owner wallet does not have enough available balance.',
  },
  STORAGE_UNAVAILABLE: { status: 503, message: 'Booking storage is unavailable.' },
  STORAGE_ERROR: { status: 503, message: 'The booking could not be stored safely.' },
  IMPORT_REQUEST_IDENTITY_MISMATCH: {
    status: 409,
    message: 'This import request ID was already used for different details.',
  },
};

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
    'impexpImport',
    `supplier-reference-import:user:${session.clerkId}`,
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
  const parsed = supplierReferenceImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Check the import details.' },
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
    assertSupplierPricingConfirmation({
      confirmation: parsed.data.pricingConfirmation,
      actorUserId: session.clerkId,
      assignedUserId: parsed.data.assignedToUserId,
      fingerprint: priced.fingerprint,
    });
    const booking = priced.booking;
    if (
      booking.lifecycleStatus !== 'confirmed' &&
      parsed.data.importDecision === 'import_and_charge'
    ) {
      return NextResponse.json(
        {
          error: ERRORS.CHARGE_DECISION_NOT_APPLICABLE.message,
          code: 'CHARGE_DECISION_NOT_APPLICABLE',
        },
        { status: ERRORS.CHARGE_DECISION_NOT_APPLICABLE.status },
      );
    }
    const userPayableAmount = majorToMinor(booking.pricingSnapshot.sellingPrice);
    const supplierGrossAmount = majorToMinor(booking.supplierGross);
    const audit = {
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.supplier_reference.import_decision',
      targetType: 'supplier_booking',
      targetId: securitySubjectHash(
        `${booking.supplierAccount}:${booking.supplierReference}`,
      ),
      metadata: {
        supplierAccount: booking.supplierAccount,
        assignedUser: securitySubjectHash(parsed.data.assignedToUserId),
        supplierStatus: booking.supplierStatus,
        lifecycleStatus: booking.lifecycleStatus,
        userPayableAmount,
        supplierGrossAmount,
        supplierPayableAmount: majorToMinor(booking.supplierPayable),
        pricingMode: booking.pricingMode,
        pricingCalculatedAt: booking.pricingCalculatedAt,
        currency: booking.currency,
        requestId: parsed.data.requestId,
        importDecision: parsed.data.importDecision,
        hasChargeAuthorization: Boolean(parsed.data.chargeAuthorizationId),
      },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return NextResponse.json(
        { error: 'The import decision could not be audited and was not executed.' },
        { status: 503 },
      );
    }
    const result = await createSupplierReferenceBooking({
      actorUserId: session.clerkId,
      assignedUserId: parsed.data.assignedToUserId,
      userPayableAmount,
      supplierGrossAmount,
      booking,
      importDecision: parsed.data.importDecision,
      chargeAuthorizationId: parsed.data.chargeAuthorizationId,
      requestId: parsed.data.requestId,
    });
    if (!result.ok || !result.booking) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: 'failed',
        metadata: { ...audit.metadata, failureCode: result.code ?? 'UNKNOWN' },
      });
      const policy = ERRORS[result.code ?? ''] ?? {
        status: 409,
        message: 'The supplier booking could not be imported safely.',
      };
      return NextResponse.json(
        {
          error: policy.message,
          code: result.code,
          ...(typeof result.available === 'number' ? { available: result.available } : {}),
          ...(typeof result.required === 'number' ? { required: result.required } : {}),
          ...(result.currency ? { currency: result.currency } : {}),
        },
        { status: policy.status },
      );
    }
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'succeeded',
      metadata: {
        ...audit.metadata,
        bookingId: result.booking.id,
        walletCharged: result.walletCharged === true,
        replay: result.replay === true,
      },
    });
    await dispatchBookingStatusEmails(result.booking.id);
    return NextResponse.json({
      success: true,
      referenceNo: result.booking.public_ref,
      supplierReference: booking.supplierReference,
      supplierAccount: booking.supplierAccount,
      status: booking.lifecycleStatus,
      paymentState: result.booking.payment_state,
      walletCharged: result.walletCharged === true,
      chargedAmount: result.amount ?? 0,
      importDecision: result.importDecision ?? parsed.data.importDecision,
      replay: result.replay === true,
      bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(result.booking.public_ref)}`,
    });
  } catch (error) {
    console.error('[supplier-reference-import] import failed:', error);
    const pricingError = supplierPricingErrorResponse(error);
    return NextResponse.json(
      {
        ...(pricingError ? { code: pricingError.code } : {}),
        error: pricingError?.message ??
          (error instanceof Error ? error.message : 'Supplier API Import failed.'),
      },
      { status: pricingError?.status ?? 502 },
    );
  }
}
