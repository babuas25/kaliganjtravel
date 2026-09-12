import { NextRequest, NextResponse } from "next/server";

import { bookingLifecycleRolloutEnabled } from "@/lib/booking-lifecycle/rollout";
import { getDashboardSession } from "@/lib/dashboard/session";
import { saveImportedBooking } from "@/lib/db/impexp";
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from "@/lib/db/security";
import { dispatchBookingStatusEmails } from "@/lib/email/booking-status-delivery";
import { canAccessImpExp } from "@/lib/impexp/access";
import { normalizeSupplierBooking } from "@/lib/impexp/normalize";
import { retrieveImportBooking } from "@/lib/impexp/providers.server";
import { importBookingDecisionSchema } from "@/lib/impexp/validation";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";
import { majorToMinor } from "@/lib/wallet/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  INVALID_IMPORT_DATA: { status: 400, message: "Check the import and pricing details." },
  INVALID_IMPORT_IDENTITY: { status: 400, message: "The supplier booking identity is invalid." },
  INVALID_IMPORT_ASSIGNEE: { status: 400, message: "Assign an eligible B2B, Sub User, or Customer." },
  ASSIGNEE_AGENCY_REQUIRED: { status: 409, message: "The assigned B2B user has no agency wallet owner." },
  WALLET_NOT_FOUND: { status: 409, message: "The assigned user or agency does not have a wallet." },
  WALLET_ACCOUNT_NOT_FOUND: { status: 409, message: "The assigned wallet has no account for this booking currency." },
  WALLET_FROZEN: { status: 409, message: "The assigned wallet is frozen." },
  INSUFFICIENT_FUNDS: { status: 409, message: "The assigned wallet does not have enough available balance." },
  IMPORT_ASSIGNEE_MISMATCH: { status: 409, message: "This supplier booking is already assigned to a different user." },
  IMPORT_PAYABLE_MISMATCH: { status: 409, message: "User Payable is already fixed for this imported booking and cannot be changed by re-import." },
  REIMPORT_CONFIRMATION_REQUIRES_RECONCILIATION: {
    status: 409,
    message: "This existing unpaid import now appears confirmed at the supplier. It was not charged; Accounts reconciliation is required.",
  },
  HISTORICAL_IMPORT_RECONCILIATION_REQUIRED: {
    status: 409,
    message: "This historical import has no protected User Payable record and requires reconciliation before it can be updated.",
  },
  CHARGE_DECISION_NOT_APPLICABLE: {
    status: 409,
    message: "Only a confirmed supplier booking can use Import & Charge.",
  },
  CHARGE_AUTHORIZATION_MISMATCH: {
    status: 409,
    message: "The selected import decision does not match its charge authorization.",
  },
  FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED: {
    status: 409,
    message:
      "Import & Charge requires a fresh, unused authorization for these exact supplier, owner, and pricing details.",
  },
  COMPLETE_CONFIRMED_IMPORT_EVIDENCE_REQUIRED: {
    status: 409,
    message:
      "A direct confirmed import requires matching PNR and complete ticket evidence for every passenger.",
  },
};

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json({ error: "IMP/EXP access is forbidden." }, { status: 403 });
  }

  const limit = await checkActionLimit("impexpImport", `user:${session.clerkId}`);
  if (!limit.ok) {
    return NextResponse.json(
      { error: rateLimitMessage(limit.retryAfterSeconds) },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = importBookingDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the import details." },
      { status: 400 },
    );
  }
  if (
    parsed.data.importDecision === "import_and_charge" &&
    !bookingLifecycleRolloutEnabled("importedActions")
  ) {
    return NextResponse.json(
      {
        error: "Import & Charge is not enabled for this rollout stage.",
        code: "IMPORTED_MANUAL_ACTIONS_DISABLED",
      },
      { status: 503 },
    );
  }

  try {
    const supplierPayload = await retrieveImportBooking(parsed.data);
    const normalized = normalizeSupplierBooking(
      supplierPayload,
      parsed.data.provider,
      parsed.data.orderReference,
      {
        originalReference: parsed.data.originalReference || null,
        passengerInfo: parsed.data.passengerInfo ?? [],
      },
    );
    const bookingPayload = {
      ...normalized,
      lookupLastName: parsed.data.lastName.trim().toUpperCase(),
    };
    const userPayableAmount = majorToMinor(parsed.data.userPayableAmount);
    const supplierGrossAmount = majorToMinor(normalized.totalPrice);
    const audit = {
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: "booking.impexp.explicit_import_decision",
      targetType: "supplier_booking",
      targetId: securitySubjectHash(
        `${normalized.provider}:${normalized.supplierReference}`,
      ),
      metadata: {
        provider: normalized.provider,
        assignedUser: securitySubjectHash(parsed.data.assignedToUserId),
        userPayableAmount,
        supplierGrossAmount,
        currency: normalized.currency,
        requestId: parsed.data.requestId,
        importDecision: parsed.data.importDecision,
        hasChargeAuthorization: Boolean(parsed.data.chargeAuthorizationId),
      },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: "attempted" }))) {
      return NextResponse.json(
        {
          error: "The import decision could not be audited and was not executed.",
          code: "IMPORT_DECISION_AUDIT_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
    if (
      normalized.lifecycleStatus === "confirmed" &&
      parsed.data.importDecision !== "import_and_charge"
    ) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: "failed",
        metadata: {
          ...audit.metadata,
          failureCode: "CONFIRMED_IMPORT_REQUIRES_CHARGE",
        },
      });
      return NextResponse.json(
        {
          error:
            "An already confirmed supplier ticket must use Import & Charge with complete ticket evidence.",
          code: "CONFIRMED_IMPORT_REQUIRES_CHARGE",
        },
        { status: 409 },
      );
    }
    let result;
    try {
      result = await saveImportedBooking({
        actorUserId: session.clerkId,
        assignedUserId: parsed.data.assignedToUserId,
        userPayableAmount,
        supplierGrossAmount,
        booking: bookingPayload,
        importDecision: parsed.data.importDecision,
        chargeAuthorizationId: parsed.data.chargeAuthorizationId,
        requestId: parsed.data.requestId,
      });
    } catch (error) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: "failed",
        metadata: { ...audit.metadata, failureCode: "IMPORT_STORAGE_ERROR" },
      });
      throw error;
    }
    if (!result.ok || !result.booking) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: "failed",
        metadata: {
          ...audit.metadata,
          failureCode: result.code ?? "IMPEXP_IMPORT_FAILED",
        },
      });
      const policy = ERROR_MESSAGES[result.code ?? ""] ?? {
        status: 409,
        message: "The imported booking could not be completed safely.",
      };
      return NextResponse.json(
        {
          error: policy.message,
          code: result.code,
          ...(typeof result.available === "number"
            ? { available: result.available }
            : {}),
          ...(typeof result.required === "number"
            ? { required: result.required }
            : {}),
          ...(result.currency ? { currency: result.currency } : {}),
        },
        { status: policy.status },
      );
    }

    await recordSecurityAuditEvent({
      ...audit,
      outcome: "succeeded",
      metadata: {
        ...audit.metadata,
        bookingId: result.booking.id,
        walletCharged: result.walletCharged === true,
        chargePreviouslyCaptured: result.chargePreviouslyCaptured === true,
        reconciliationCaseId: result.reconciliationCaseId ?? null,
      },
    });
    await dispatchBookingStatusEmails(result.booking.id);
    return NextResponse.json({
      success: true,
      referenceNo: result.booking.public_ref,
      supplierReference:
        normalized.originalReference || normalized.supplierReference,
      provider: normalized.provider,
      status: result.status || normalized.lifecycleStatus,
      paymentState: result.booking.payment_state,
      walletCharged: result.walletCharged === true,
      chargePreviouslyCaptured: result.chargePreviouslyCaptured === true,
      importDecision: result.importDecision ?? parsed.data.importDecision,
      priorChargeAuthorizationVerified:
        result.priorChargeAuthorizationVerified === true,
      chargedAmount: result.amount ?? 0,
      reimport: result.reimport === true,
      reconciliationRequired: Boolean(result.reconciliationCaseId),
      reconciliationCaseId: result.reconciliationCaseId,
      bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(result.booking.public_ref)}`,
    });
  } catch (error) {
    console.error("[impexp] booking import failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Booking import failed.",
      },
      { status: 502 },
    );
  }
}
