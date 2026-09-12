import { NextRequest, NextResponse } from "next/server";

import { bookingLifecycleRolloutEnabled } from "@/lib/booking-lifecycle/rollout";
import { getDashboardSession } from "@/lib/dashboard/session";
import { authorizeImportedBookingCharge } from "@/lib/db/impexp";
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from "@/lib/db/security";
import { canAccessImpExp } from "@/lib/impexp/access";
import { normalizeSupplierBooking } from "@/lib/impexp/normalize";
import { retrieveImportBooking } from "@/lib/impexp/providers.server";
import { importChargeAuthorizationSchema } from "@/lib/impexp/validation";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";
import { majorToMinor } from "@/lib/wallet/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  INVALID_CHARGE_AUTHORIZATION: {
    status: 400,
    message: "Check the import, pricing, and authorization request details.",
  },
  IMPEXP_CHARGE_AUTHORIZATION_FORBIDDEN: {
    status: 403,
    message: "Support or administrator access is required to authorize a charge.",
  },
  INVALID_IMPORT_ASSIGNEE: {
    status: 400,
    message: "Assign an eligible B2B, Sub User, or Customer.",
  },
  ASSIGNEE_AGENCY_REQUIRED: {
    status: 409,
    message: "The assigned B2B user has no agency wallet owner.",
  },
  COMPLETE_CONFIRMED_IMPORT_EVIDENCE_REQUIRED: {
    status: 409,
    message:
      "Import & Charge requires a confirmed supplier response with matching PNR and complete ticket evidence for every passenger.",
  },
  WALLET_NOT_FOUND: {
    status: 409,
    message: "The assigned user or agency does not have a wallet.",
  },
  WALLET_ACCOUNT_NOT_FOUND: {
    status: 409,
    message: "The assigned wallet has no account for this booking currency.",
  },
  WALLET_FROZEN: { status: 409, message: "The assigned wallet is frozen." },
  INSUFFICIENT_FUNDS: {
    status: 409,
    message: "The assigned wallet does not have enough available balance.",
  },
  CHARGE_AUTHORIZATION_IDENTITY_MISMATCH: {
    status: 409,
    message:
      "This authorization request was already used for different import details. Review again.",
  },
  STORAGE_UNAVAILABLE: {
    status: 503,
    message: "Charge authorization storage is unavailable.",
  },
  STORAGE_ERROR: {
    status: 503,
    message: "The charge authorization could not be recorded safely.",
  },
};

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json(
      { error: "IMP/EXP charge authorization is forbidden." },
      { status: 403 },
    );
  }
  if (!bookingLifecycleRolloutEnabled("importedActions")) {
    return NextResponse.json(
      {
        error: "Imported charge authorization is not enabled for this rollout stage.",
        code: "IMPORTED_MANUAL_ACTIONS_DISABLED",
      },
      { status: 503 },
    );
  }

  const limit = await checkActionLimit(
    "impexpImport",
    `charge-authorization:user:${session.clerkId}`,
  );
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
  const parsed = importChargeAuthorizationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the import details." },
      { status: 400 },
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
      action: "booking.impexp.direct_import_charge_authorization",
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
        importDecision: "import_and_charge",
        walletMutation: false,
      },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: "attempted" }))) {
      return NextResponse.json(
        {
          error:
            "The charge authorization could not be audited and was not recorded.",
          code: "CHARGE_AUTHORIZATION_AUDIT_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    const result = await authorizeImportedBookingCharge({
      actorUserId: session.clerkId,
      assignedUserId: parsed.data.assignedToUserId,
      userPayableAmount,
      supplierGrossAmount,
      booking: bookingPayload,
      requestId: parsed.data.requestId,
    });
    if (!result.ok || !result.authorizationId) {
      await recordSecurityAuditEvent({
        ...audit,
        outcome: "failed",
        metadata: {
          ...audit.metadata,
          failureCode: result.code ?? "CHARGE_AUTHORIZATION_FAILED",
        },
      });
      const policy = ERROR_MESSAGES[result.code ?? ""] ?? {
        status: 409,
        message: "The wallet charge could not be authorized safely.",
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

    await recordSecurityAuditEvent({ ...audit, outcome: "succeeded" });
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
    console.error("[impexp] charge authorization failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Charge authorization failed.",
      },
      { status: 502 },
    );
  }
}
