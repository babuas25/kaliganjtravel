import { NextRequest, NextResponse } from "next/server";

import { bookingScopeFor } from "@/lib/dashboard/bookings";
import { getDashboardSession } from "@/lib/dashboard/session";
import { readBookingByPublicRef } from "@/lib/db/flight-bookings";
import { updateManualBookingStatus } from "@/lib/db/impexp";
import { dispatchBookingStatusEmails } from "@/lib/email/booking-status-delivery";
import { canAccessImpExp } from "@/lib/impexp/access";
import { manualBookingStatusSchema } from "@/lib/impexp/manual-validation";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_MANUAL_STATUS_REQUEST: { status: 400, message: "Check the status update details." },
  MANUAL_STATUS_FORBIDDEN: { status: 403, message: "Manual status management is forbidden." },
  MANUAL_BOOKING_NOT_FOUND: { status: 404, message: "Manual booking not found." },
  MANUAL_TERMINAL_BOOKING: { status: 409, message: "Confirmed and cancelled manual bookings cannot be changed here." },
  COMPLETE_CONFIRMED_MANUAL_EVIDENCE_REQUIRED: { status: 400, message: "Confirmed requires a ticket number for every passenger and an issued date/time." },
  MANUAL_IN_PROGRESS_REQUIRES_TICKET_DETAILS: { status: 409, message: "In Progress can only move to Confirmed with complete ticket details." },
  MANUAL_CONFIRM_TRANSITION_NOT_ALLOWED: { status: 409, message: "Only On Hold or In Progress manual bookings can be confirmed." },
  MANUAL_TICKETING_RECONCILIATION_REQUIRED: { status: 409, message: "The paid ticketing operation is inconsistent and requires reconciliation." },
  MANUAL_PAYMENT_RECONCILIATION_REQUIRED: { status: 409, message: "This status change would conflict with the booking payment state." },
  MANUAL_CANCELLATION_REASON_REQUIRED: { status: 400, message: "A cancellation reason is required." },
  MANUAL_PNR_REQUIRED: { status: 400, message: "An airline PNR is required for this status." },
  MANUAL_ON_HOLD_DEADLINE_MUST_BE_FUTURE: { status: 400, message: "An On Hold deadline must be in the future." },
  WALLET_NOT_FOUND: { status: 409, message: "The assigned user or agency does not have a wallet." },
  WALLET_ACCOUNT_NOT_FOUND: { status: 409, message: "The assigned wallet has no account for this booking currency." },
  WALLET_FROZEN: { status: 409, message: "The assigned wallet is frozen." },
  INSUFFICIENT_FUNDS: { status: 409, message: "The assigned wallet does not have enough available balance." },
  MANUAL_REQUEST_IDENTITY_MISMATCH: { status: 409, message: "This request ID was already used for different status data." },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const session = await getDashboardSession();
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!canAccessImpExp(session.role)) return NextResponse.json({ error: "Manual status management is forbidden." }, { status: 403 });
  const { reference } = await params;
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) return NextResponse.json({ error: "Check the booking reference." }, { status: 400 });
  const booking = await readBookingByPublicRef(reference, bookingScopeFor(session));
  if (!booking || booking.import_source !== "MANUAL") return NextResponse.json({ error: "Manual booking not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = manualBookingStatusSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the status update details." }, { status: 400 });
  if (parsed.data.targetStatus === "confirmed") {
    return NextResponse.json(
      {
        error: "Use Issue Now, then the Imported Booking Ticketing Resolution panel to confirm this booking.",
        code: "IMPORTED_TICKETING_RESOLUTION_REQUIRED",
      },
      { status: 409 },
    );
  }
  const limit = await checkActionLimit("manualBookingStatus", `user:${session.clerkId}`);
  if (!limit.ok) return NextResponse.json({ error: rateLimitMessage(limit.retryAfterSeconds) }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  try {
    const result = await updateManualBookingStatus({ actorUserId: session.clerkId, bookingId: booking.id, status: parsed.data });
    if (!result.ok || !result.booking) {
      const policy = ERRORS[result.code ?? ""] ?? { status: 409, message: "The manual status update could not be completed safely." };
      return NextResponse.json({ error: policy.message, code: result.code, ...(typeof result.available === "number" ? { available: result.available } : {}), ...(typeof result.required === "number" ? { required: result.required } : {}), ...(result.currency ? { currency: result.currency } : {}) }, { status: policy.status });
    }
    await dispatchBookingStatusEmails(result.booking.id);
    return NextResponse.json({ success: true, status: result.status, paymentState: result.booking.payment_state, walletCharged: result.walletCharged === true, chargedAmount: result.amount ?? 0, replay: result.replay === true });
  } catch (error) {
    console.error("[impexp] manual booking status update failed:", error);
    return NextResponse.json({ error: "Manual booking status storage is unavailable." }, { status: 503 });
  }
}
