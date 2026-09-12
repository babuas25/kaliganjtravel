import { NextRequest, NextResponse } from "next/server";

import { getDashboardSession } from "@/lib/dashboard/session";
import { saveManualBooking } from "@/lib/db/impexp";
import { dispatchBookingStatusEmails } from "@/lib/email/booking-status-delivery";
import { canAccessImpExp } from "@/lib/impexp/access";
import { manualBookingImportSchema } from "@/lib/impexp/manual-validation";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_MANUAL_IMPORT_DATA: { status: 400, message: "Check the manual booking details." },
  MANUAL_IMPORT_FORBIDDEN: { status: 403, message: "Manual Import access is forbidden." },
  INVALID_IMPORT_ASSIGNEE: { status: 400, message: "Assign an eligible B2B, Sub User, or Customer." },
  ASSIGNEE_AGENCY_REQUIRED: { status: 409, message: "The assigned B2B user has no agency wallet owner." },
  WALLET_NOT_FOUND: { status: 409, message: "The assigned user or agency does not have a wallet." },
  WALLET_ACCOUNT_NOT_FOUND: { status: 409, message: "The assigned wallet has no account for this booking currency." },
  WALLET_FROZEN: { status: 409, message: "The assigned wallet is frozen." },
  INSUFFICIENT_FUNDS: { status: 409, message: "The assigned wallet does not have enough available balance." },
  COMPLETE_CONFIRMED_MANUAL_EVIDENCE_REQUIRED: { status: 400, message: "Confirmed bookings require a ticket number for every passenger and an issued date/time." },
  ON_HOLD_MANUAL_IMPORT_CANNOT_INCLUDE_TICKETS: { status: 400, message: "On Hold manual imports cannot include ticket details." },
  MANUAL_BOOKING_ALREADY_IMPORTED: { status: 409, message: "A manual booking with this external reference already exists." },
  MANUAL_REQUEST_IDENTITY_MISMATCH: { status: 409, message: "This request ID was already used for different manual booking data." },
};

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!canAccessImpExp(session.role)) return NextResponse.json({ error: "Manual Import access is forbidden." }, { status: 403 });

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = manualBookingImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the manual booking details." }, { status: 400 });
  }
  const limit = await checkActionLimit("manualBookingImport", `user:${session.clerkId}`);
  if (!limit.ok) return NextResponse.json({ error: rateLimitMessage(limit.retryAfterSeconds) }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  try {
    const result = await saveManualBooking({ actorUserId: session.clerkId, booking: parsed.data });
    if (!result.ok || !result.booking) {
      const policy = ERRORS[result.code ?? ""] ?? { status: 409, message: "The manual booking could not be completed safely." };
      return NextResponse.json({ error: policy.message, code: result.code, ...(typeof result.available === "number" ? { available: result.available } : {}), ...(typeof result.required === "number" ? { required: result.required } : {}), ...(result.currency ? { currency: result.currency } : {}) }, { status: policy.status });
    }
    await dispatchBookingStatusEmails(result.booking.id);
    return NextResponse.json({
      success: true,
      referenceNo: result.booking.public_ref,
      bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(result.booking.public_ref)}`,
      status: result.status,
      paymentState: result.booking.payment_state,
      walletCharged: result.walletCharged === true,
      chargedAmount: result.amount ?? 0,
      replay: result.replay === true,
    });
  } catch (error) {
    console.error("[impexp] manual booking import failed:", error);
    return NextResponse.json({ error: "Manual booking storage is unavailable." }, { status: 503 });
  }
}
