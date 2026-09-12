import { NextRequest } from "next/server";
import { z } from "zod";

import { bookingScopeFor } from "@/lib/dashboard/bookings";
import { getDashboardSession } from "@/lib/dashboard/session";
import { readBookingByPublicRef } from "@/lib/db/flight-bookings";
import { beginImportedBookingIssue, readWalletForOwner } from "@/lib/db/wallet";
import { checkActionLimit } from "@/lib/rate-limit";
import { walletFail, walletOk, walletOperationResponse } from "@/lib/wallet/http";
import {
  canAccessImportedBookingIssue,
  walletOwnerForBooking,
} from "@/lib/wallet/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid(),
});

async function authorizedBooking(reference: string) {
  const session = await getDashboardSession();
  if (!session) return { error: walletFail(401, "SIGN_IN_REQUIRED", "Please sign in.") };
  const booking = await readBookingByPublicRef(reference, bookingScopeFor(session));
  if (!booking) {
    return { error: walletFail(404, "BOOKING_NOT_FOUND", "Booking not found.") };
  }
  if (!canAccessImportedBookingIssue(session, booking)) {
    return {
      error: walletFail(
        403,
        "IMPORTED_ISSUE_FORBIDDEN",
        "You cannot issue this imported booking.",
      ),
    };
  }
  return { session, booking };
}

export async function GET(request: NextRequest) {
  const reference = request.nextUrl.searchParams.get("reference") ?? "";
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(400, "INVALID_BOOKING_REFERENCE", "Check the booking reference.");
  }
  const resolved = await authorizedBooking(reference);
  if (resolved.error) return resolved.error;
  const { session, booking } = resolved;
  if (
    booking.status !== "on-hold" ||
    booking.lifecycle_status !== "on-hold" ||
    booking.payment_state !== "unpaid"
  ) {
    return walletFail(
      409,
      "BOOKING_NOT_ISSUABLE",
      "This imported booking is not awaiting Issue Now.",
    );
  }
  const owner = walletOwnerForBooking(booking);
  if (!owner || !booking.user_payable_amount) {
    return walletFail(
      409,
      "BOOKING_OWNER_REQUIRED",
      "The booking has no chargeable wallet owner or User Payable Amount.",
    );
  }
  try {
    const wallet = await readWalletForOwner(owner, booking.currency);
    if (!wallet) {
      return walletFail(409, "WALLET_NOT_FOUND", "The booking owner does not have a wallet.");
    }
    return walletOk({
      wallet,
      requiredAmount: booking.user_payable_amount,
      paymentState: booking.payment_state,
      action: "imported-issue",
    });
  } catch {
    return walletFail(503, "STORAGE_ERROR", "Wallet storage is unavailable.");
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, "INVALID_IMPORTED_ISSUE_REQUEST", "Check the booking reference.");
  }
  const resolved = await authorizedBooking(parsed.data.bookingReference);
  if (resolved.error) return resolved.error;
  const { session, booking } = resolved;
  const limit = await checkActionLimit("impexpConfirm", `user:${session.clerkId}`);
  if (!limit.ok) {
    return walletFail(429, "RATE_LIMITED", "Too many Issue Now attempts.");
  }
  const result = await beginImportedBookingIssue(
    booking.id,
    session,
    parsed.data.requestId,
  );
  return walletOperationResponse(result);
}
