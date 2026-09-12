import { z } from "zod";

import { bookingLifecycleRolloutEnabled } from "@/lib/booking-lifecycle/rollout";
import { getDashboardSession } from "@/lib/dashboard/session";
import { readBookingByPublicRef } from "@/lib/db/flight-bookings";
import { completeImportedManualTicketing } from "@/lib/db/impexp";
import { recordSecurityAuditEvent } from "@/lib/db/security";
import { dispatchBookingStatusEmails } from "@/lib/email/booking-status-delivery";
import { canAccessImpExp } from "@/lib/impexp/access";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";
import { walletFail, walletOk } from "@/lib/wallet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  caseId: z.string().uuid(),
  evidenceObservationId: z.string().uuid(),
  requestId: z.string().uuid(),
});

const COMPLETION_MESSAGES: Record<string, string> = {
  IMPEXP_COMPLETION_FORBIDDEN:
    "Support or administrator access is required to complete manual ticketing.",
  AUTHORITATIVE_IMPORTED_TICKET_EVIDENCE_REQUIRED:
    "Request fresh, complete, matching ticket evidence before completion.",
  IMPORTED_TICKET_EVIDENCE_STALE:
    "The ticket evidence is older than five minutes. Sync again before completion.",
  IMPORTED_TICKET_EVIDENCE_INCOMPLETE:
    "The supplier response does not contain one complete ticket per passenger.",
  IMPORTED_TICKET_IDENTITY_CONFLICT:
    "The supplier ticket numbers conflict with stored booking evidence.",
  IMPORTED_PNR_IDENTITY_CONFLICT:
    "The supplier airline PNR conflicts with stored booking evidence.",
  CAPTURED_PAYMENT_MISMATCH:
    "The captured payment does not match the protected User Payable amount.",
  CAPTURE_LEDGER_MISMATCH:
    "The original wallet debit could not be proven from the immutable ledger.",
  MANUAL_TICKET_FINANCIAL_REVIEW_REQUIRED:
    "This manual-ticket case requires a financial disposition before completion.",
};

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, "SIGN_IN_REQUIRED", "Please sign in.");
  if (!canAccessImpExp(session.role)) {
    return walletFail(
      403,
      "IMPEXP_COMPLETION_FORBIDDEN",
      "IMP/EXP completion access is forbidden.",
    );
  }
  if (!bookingLifecycleRolloutEnabled("importedActions")) {
    return walletFail(
      503,
      "IMPORTED_MANUAL_ACTIONS_DISABLED",
      "Imported manual completion is not enabled for this rollout stage.",
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      "INVALID_COMPLETION_REQUEST",
      "Check the booking, case, evidence, and request identity.",
    );
  }
  const limit = await checkActionLimit(
    "bookingReconciliationWrite",
    `user:${session.clerkId}`,
  );
  if (!limit.ok) {
    return walletFail(
      429,
      "IMPEXP_COMPLETION_RATE_LIMITED",
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds },
    );
  }
  const booking = await readBookingByPublicRef(parsed.data.bookingReference, {
    kind: "all",
  });
  if (!booking || booking.import_source !== "IMP_EXP") {
    return walletFail(
      404,
      "IMPORTED_BOOKING_NOT_FOUND",
      "Imported booking not found.",
    );
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: "booking.impexp.manual_ticket_completion",
    targetType: "flight_booking",
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      evidenceObservationId: parsed.data.evidenceObservationId,
      requestId: parsed.data.requestId,
      walletMutation: false,
      additionalDebit: 0,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: "attempted" }))) {
    return walletFail(
      503,
      "IMPEXP_COMPLETION_AUDIT_UNAVAILABLE",
      "The completion action could not be audited and was not executed.",
    );
  }

  const result = await completeImportedManualTicketing({
    actorUserId: session.clerkId,
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    evidenceObservationId: parsed.data.evidenceObservationId,
    requestId: parsed.data.requestId,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: "failed",
      metadata: {
        ...audit.metadata,
        failureCode: result.code ?? "IMPEXP_COMPLETION_FAILED",
      },
    });
    const code = result.code ?? "IMPEXP_COMPLETION_FAILED";
    return walletFail(
      code === "IMPEXP_COMPLETION_FORBIDDEN" ? 403 : 409,
      code,
      COMPLETION_MESSAGES[code] ??
        "The imported booking could not be completed safely.",
    );
  }

  await dispatchBookingStatusEmails(booking.id);
  return walletOk({
    ...result,
    walletCharged: false,
    walletMutation: false,
    ledgerMutation: false,
    additionalDebit: 0,
  });
}
