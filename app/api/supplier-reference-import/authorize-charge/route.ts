import { NextRequest, NextResponse } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { authorizeSupplierReferenceCharge } from '@/lib/db/supplier-reference-import';
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from '@/lib/db/security';
import { canAccessImpExp } from '@/lib/impexp/access';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { retrieveSupplierReferenceBooking } from '@/lib/supplier-reference-import/retrieve.server';
import {
  assertSupplierPricingConfirmation,
  priceSupplierReferenceBooking,
  supplierPricingErrorResponse,
} from '@/lib/supplier-reference-import/pricing.server';
import { supplierReferenceChargeAuthorizationSchema } from '@/lib/supplier-reference-import/validation';
import { majorToMinor } from '@/lib/wallet/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_CHARGE_AUTHORIZATION: {
    status: 400,
    message: 'Check the supplier booking, owner, and User Payable.',
  },
  CHARGE_NOT_APPLICABLE: {
    status: 409,
    message: 'Only an issued or ticketed supplier booking can be imported and charged.',
  },
  COMPLETE_TICKET_EVIDENCE_REQUIRED: {
    status: 409,
    message: 'Import & Charge requires one supplier ticket number per passenger.',
  },
  INVALID_IMPORT_ASSIGNEE: {
    status: 400,
    message: 'Assign an eligible B2B, Sub User, or Customer.',
  },
  ASSIGNEE_AGENCY_REQUIRED: {
    status: 409,
    message: 'The assigned B2B user has no agency wallet owner.',
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
  CHARGE_AUTHORIZATION_IDENTITY_MISMATCH: {
    status: 409,
    message: 'This authorization request was already used for different details.',
  },
  STORAGE_UNAVAILABLE: { status: 503, message: 'Booking storage is unavailable.' },
  STORAGE_ERROR: {
    status: 503,
    message: 'The charge authorization could not be recorded safely.',
  },
};

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json(
      { error: 'Supplier API charge authorization is forbidden.' },
      { status: 403 },
    );
  }
  const limit = await checkActionLimit(
    'impexpImport',
    `supplier-reference-charge:user:${session.clerkId}`,
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
  const parsed = supplierReferenceChargeAuthorizationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Check the authorization details.' },
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
    if (booking.lifecycleStatus !== 'confirmed') {
      return NextResponse.json(
        { error: ERRORS.CHARGE_NOT_APPLICABLE.message, code: 'CHARGE_NOT_APPLICABLE' },
        { status: ERRORS.CHARGE_NOT_APPLICABLE.status },
      );
    }
    const userPayableAmount = majorToMinor(booking.pricingSnapshot.sellingPrice);
    const supplierGrossAmount = majorToMinor(booking.supplierGross);
    const audit = {
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.supplier_reference.charge_authorization',
      targetType: 'supplier_booking',
      targetId: securitySubjectHash(
        `${booking.supplierAccount}:${booking.supplierReference}`,
      ),
      metadata: {
        supplierAccount: booking.supplierAccount,
        assignedUser: securitySubjectHash(parsed.data.assignedToUserId),
        userPayableAmount,
        supplierGrossAmount,
        supplierPayableAmount: majorToMinor(booking.supplierPayable),
        pricingMode: booking.pricingMode,
        pricingCalculatedAt: booking.pricingCalculatedAt,
        currency: booking.currency,
        requestId: parsed.data.requestId,
        walletMutation: false,
      },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return NextResponse.json(
        { error: 'The charge authorization could not be audited and was not recorded.' },
        { status: 503 },
      );
    }
    const result = await authorizeSupplierReferenceCharge({
      actorUserId: session.clerkId,
      assignedUserId: parsed.data.assignedToUserId,
      userPayableAmount,
      supplierGrossAmount,
      booking,
      requestId: parsed.data.requestId,
    });
    if (!result.ok || !result.authorizationId) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: 'failed',
        metadata: { ...audit.metadata, failureCode: result.code ?? 'UNKNOWN' },
      });
      const policy = ERRORS[result.code ?? ''] ?? {
        status: 409,
        message: 'The wallet charge could not be authorized safely.',
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
    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
    return NextResponse.json({
      success: true,
      authorizationId: result.authorizationId,
      expiresAt: result.expiresAt,
      consumed: result.consumed === true,
      replay: result.replay === true,
      amount: result.amount,
      currency: result.currency,
      walletAvailable: result.walletAvailable,
      walletMutation: false,
    });
  } catch (error) {
    console.error('[supplier-reference-import] charge authorization failed:', error);
    const pricingError = supplierPricingErrorResponse(error);
    return NextResponse.json(
      {
        ...(pricingError ? { code: pricingError.code } : {}),
        error: pricingError?.message ??
          (error instanceof Error ? error.message : 'Charge authorization failed.'),
      },
      { status: pricingError?.status ?? 502 },
    );
  }
}
