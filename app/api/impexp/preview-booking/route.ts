import { NextRequest, NextResponse } from "next/server";

import { getDashboardSession } from "@/lib/dashboard/session";
import { canAccessImpExp } from "@/lib/impexp/access";
import { normalizeSupplierBooking } from "@/lib/impexp/normalize";
import { retrieveImportBooking } from "@/lib/impexp/providers.server";
import type { ImpExpBookingPreview } from "@/lib/impexp/types";
import { importLookupSchema } from "@/lib/impexp/validation";
import { checkActionLimit, rateLimitMessage } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json({ error: "IMP/EXP access is forbidden." }, { status: 403 });
  }
  const limit = await checkActionLimit(
    "impexpRetrieve",
    `user:${session.clerkId}`,
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
  const parsed = importLookupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the booking details." },
      { status: 400 },
    );
  }

  try {
    const supplierPayload = await retrieveImportBooking(parsed.data);
    const normalized = normalizeSupplierBooking(
      supplierPayload,
      parsed.data.provider,
      parsed.data.orderReference,
      { originalReference: parsed.data.originalReference || null },
    );
    if (!Number.isFinite(normalized.totalPrice) || normalized.totalPrice <= 0) {
      throw new Error(
        "Supplier Gross Amount was not available. Do not import this booking until supplier pricing can be verified.",
      );
    }
    const preview: ImpExpBookingPreview = {
      provider: normalized.provider,
      supplierReference: normalized.supplierReference,
      originalReference: normalized.originalReference,
      status: normalized.lifecycleStatus,
      orderStatus: normalized.orderStatus,
      currency: normalized.currency,
      supplierGross: normalized.totalPrice,
      passengerCount: Object.values(normalized.passengerCounts).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
      route: normalized.itinerary.legs
        .map((leg) => `${leg.from}-${leg.to}`)
        .join(", "),
    };
    return NextResponse.json(
      { success: true, preview },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[impexp] booking preview failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Booking preview could not be retrieved.",
      },
      { status: 502 },
    );
  }
}
