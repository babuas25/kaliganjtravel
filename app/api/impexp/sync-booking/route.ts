import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { bookingLifecycleRolloutEnabled } from "@/lib/booking-lifecycle/rollout";
import {
  importedSupplierEvidenceFacts,
  importedSupplierEvidenceFactsHash,
  importedSupplierEvidenceReadIdentity,
  importedSupplierPayloadHash,
  isImportedSupplierEvidenceFacts,
  staffImportedSupplierEvidenceResult,
  type ImportedSupplierEvidenceFacts,
} from "@/lib/booking-lifecycle/imported-supplier-evidence";
import { bookingScopeFor } from "@/lib/dashboard/bookings";
import { getDashboardSession } from "@/lib/dashboard/session";
import {
  readOpenImportedManualTicketingCase,
  readStoredImportedSupplierEvidenceObservation,
  recordImportedSupplierEvidenceRead,
} from "@/lib/db/booking-reconciliation-evidence";
import { readBookingByPublicRef } from "@/lib/db/flight-bookings";
import {
  classifyImportedManualTicketOutcome,
  syncImportedBooking,
} from "@/lib/db/impexp";
import {
  acquireSecurityLock,
  releaseSecurityLock,
} from "@/lib/db/security";
import { dispatchBookingStatusEmails } from "@/lib/email/booking-status-delivery";
import { canAccessImpExp } from "@/lib/impexp/access";
import { normalizeSupplierBooking } from "@/lib/impexp/normalize";
import { retrieveImportBooking } from "@/lib/impexp/providers.server";
import {
  IMPORT_PROVIDERS,
  type ImportPassengerSupplement,
  type ImportProvider,
} from "@/lib/impexp/types";
import { checkActionLimit } from "@/lib/rate-limit";
import { majorToMinor } from "@/lib/wallet/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid().optional(),
});

async function classifyVerification(input: {
  actorUserId: string;
  bookingId: string;
  caseId: string;
  observationId: string;
  evidenceReplay: boolean;
  evidenceCaseVersion?: number | null;
  facts: ImportedSupplierEvidenceFacts;
}) {
  const classification = await classifyImportedManualTicketOutcome({
    actorUserId: input.actorUserId,
    bookingId: input.bookingId,
    caseId: input.caseId,
    evidenceObservationId: input.observationId,
  });
  if (!classification.ok) {
    return {
      ok: false as const,
      code: classification.code ?? "IMPEXP_OUTCOME_CLASSIFICATION_FAILED",
    };
  }
  const safe = staffImportedSupplierEvidenceResult(input.facts);
  return {
    ok: true as const,
    verification: {
      caseId: input.caseId,
      caseVersion:
        classification.caseVersion ?? input.evidenceCaseVersion ?? null,
      observationId: input.observationId,
      replay: input.evidenceReplay,
      classificationReplay: classification.replay === true,
      ...safe,
      outcome: {
        ...safe.outcome,
        operationState:
          classification.operationState ?? safe.outcome.operationState,
        caseState: classification.caseState ?? safe.outcome.caseState,
        assignedTeam:
          classification.assignedTeam ?? safe.outcome.assignedTeam,
        financialDisposition:
          classification.financialDisposition ?? "none",
        financialDispositionRequired:
          classification.financialDispositionRequired ??
          safe.outcome.financialDispositionRequired,
      },
    },
  };
}

function storedTravellers(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const travellers = (value as { travellers?: unknown }).travellers;
  return Array.isArray(travellers)
    ? travellers.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}
function passengerSupplements(value: unknown): ImportPassengerSupplement[] {
  return storedTravellers(value).map((traveller) => {
    const rawType = String(traveller.passengerType ?? "ADT").toUpperCase();
    const paxType = rawType === "INF" || rawType === "INS"
      ? "INF"
      : rawType === "CHD" || rawType === "CNN"
        ? "CHD"
        : "ADT";
    const rawGender = String(traveller.gender ?? "");
    const gender = rawGender === "Male" || rawGender === "Female"
      ? rawGender
      : "";
    return {
      paxType,
      gender,
      birthdate: String(traveller.dateOfBirth ?? "").slice(0, 10),
      nationality: String(traveller.nationality ?? "").slice(0, 3),
      identityDocID: String(traveller.passportNumber ?? ""),
      identityDocExpiry: String(traveller.passportExpiry ?? "").slice(0, 10),
    };
  });
}

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json({ error: "IMP/EXP access is forbidden." }, { status: 403 });
  }
  if (!bookingLifecycleRolloutEnabled("importedActions")) {
    return NextResponse.json(
      {
        error: "Imported supplier Sync is not enabled for this rollout stage.",
        code: "IMPORTED_MANUAL_ACTIONS_DISABLED",
      },
      { status: 503 },
    );
  }
  const limit = await checkActionLimit("impexpSync", `user:${session.clerkId}`);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many Sync attempts." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the booking reference." }, { status: 400 });
  }
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session),
  );
  if (!booking || booking.import_source !== "IMP_EXP") {
    return NextResponse.json({ error: "Imported booking not found." }, { status: 404 });
  }
  if (!IMPORT_PROVIDERS.includes(booking.supplier as ImportProvider)) {
    return NextResponse.json({ error: "Unsupported imported supplier." }, { status: 409 });
  }

  const metadata = booking.import_metadata ?? {};
  const lead = storedTravellers(booking.passengers)[0];
  const lastName = String(metadata.lookupLastName ?? lead?.lastName ?? "")
    .trim()
    .toUpperCase();
  if (!lastName) {
    return NextResponse.json(
      { error: "Passenger last name is unavailable for supplier Sync." },
      { status: 409 },
    );
  }

  const manualCase = await readOpenImportedManualTicketingCase(booking.id);
  const evidenceIdentity = manualCase
    ? importedSupplierEvidenceReadIdentity({
        requestId: parsed.data.requestId ?? crypto.randomUUID(),
        bookingId: booking.id,
        caseId: manualCase.id,
      })
    : null;
  if (manualCase && evidenceIdentity) {
    const replay = await readStoredImportedSupplierEvidenceObservation(
      manualCase.id,
      evidenceIdentity.observationKey,
    );
    if (
      replay &&
      isImportedSupplierEvidenceFacts(replay.normalizedFacts) &&
      replay.normalizedFacts.bookingId === booking.id &&
      replay.normalizedFacts.caseId === manualCase.id
    ) {
      const classified = await classifyVerification({
        actorUserId: session.clerkId,
        bookingId: booking.id,
        caseId: manualCase.id,
        observationId: replay.id,
        evidenceReplay: true,
        facts: replay.normalizedFacts,
      });
      if (!classified.ok) {
        return NextResponse.json(
          {
            error:
              "Supplier evidence was recovered, but its operation/case outcome could not be classified safely.",
            code: classified.code,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({
        success: true,
        status: booking.lifecycle_status,
        paymentState: booking.payment_state,
        walletCharged: false,
        reconciliationRequired: true,
        reconciliationCaseId: manualCase.id,
        verification: classified.verification,
        bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(booking.public_ref)}`,
      });
    }
  }

  const lock = evidenceIdentity
    ? await acquireSecurityLock(evidenceIdentity.lockName, 180)
    : null;
  if (evidenceIdentity && !lock) {
    return NextResponse.json(
      {
        error: "This imported supplier verification is already in progress.",
        code: "IMPEXP_VERIFICATION_IN_PROGRESS",
      },
      { status: 409 },
    );
  }

  try {
    if (manualCase && evidenceIdentity) {
      const replay = await readStoredImportedSupplierEvidenceObservation(
        manualCase.id,
        evidenceIdentity.observationKey,
      );
      if (
        replay &&
        isImportedSupplierEvidenceFacts(replay.normalizedFacts) &&
        replay.normalizedFacts.bookingId === booking.id &&
        replay.normalizedFacts.caseId === manualCase.id
      ) {
        const classified = await classifyVerification({
          actorUserId: session.clerkId,
          bookingId: booking.id,
          caseId: manualCase.id,
          observationId: replay.id,
          evidenceReplay: true,
          facts: replay.normalizedFacts,
        });
        if (!classified.ok) {
          return NextResponse.json(
            {
              error:
                "Supplier evidence was recovered, but its operation/case outcome could not be classified safely.",
              code: classified.code,
            },
            { status: 503 },
          );
        }
        return NextResponse.json({
          success: true,
          status: booking.lifecycle_status,
          paymentState: booking.payment_state,
          walletCharged: false,
          reconciliationRequired: true,
          reconciliationCaseId: manualCase.id,
          verification: classified.verification,
          bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(booking.public_ref)}`,
        });
      }
    }

    const requestStartedAt = new Date().toISOString();
    const supplierPayload = await retrieveImportBooking({
      provider: booking.supplier as ImportProvider,
      orderReference: booking.booking_ref_number || booking.pnr || "",
      lastName,
    });
    const responseReceivedAt = new Date().toISOString();
    const normalized = normalizeSupplierBooking(
      supplierPayload,
      booking.supplier as ImportProvider,
      booking.booking_ref_number || booking.pnr || "",
      {
        originalReference:
          typeof metadata.originalReference === "string"
            ? metadata.originalReference
            : null,
        passengerInfo: passengerSupplements(booking.passengers),
      },
    );
    const result = await syncImportedBooking({
      actorUserId: session.clerkId,
      bookingId: booking.id,
      supplierGrossAmount: majorToMinor(normalized.totalPrice),
      booking: { ...normalized, lookupLastName: lastName },
    });
    if (!result.ok || !result.booking) {
      return NextResponse.json(
        {
          error:
            result.code === "HISTORICAL_IMPORT_RECONCILIATION_REQUIRED"
              ? "This historical import has no protected User Payable record and requires reconciliation."
              : "The imported booking could not be synced safely.",
          code: result.code,
        },
        { status: 409 },
      );
    }
    let verification = null;
    if (manualCase && evidenceIdentity) {
      const facts = importedSupplierEvidenceFacts({
        booking,
        caseId: manualCase.id,
        caseType: manualCase.case_type,
        normalized,
        requestStartedAt,
        responseReceivedAt,
        supplierPayloadHash: importedSupplierPayloadHash(supplierPayload),
      });
      const stored = await recordImportedSupplierEvidenceRead({
        bookingId: booking.id,
        caseId: manualCase.id,
        actorUserId: session.clerkId,
        actorRole: session.role,
        observationKey: evidenceIdentity.observationKey,
        facts,
        factsHash: importedSupplierEvidenceFactsHash(facts),
      });
      if (!stored.ok || !stored.observationId) {
        return NextResponse.json(
          {
            error:
              "Supplier data was synced without a wallet charge, but its verification evidence could not be recorded. Retry the same Sync request.",
            code: stored.code ?? "IMPEXP_EVIDENCE_STORAGE_FAILED",
          },
          { status: 503 },
        );
      }
      const classified = await classifyVerification({
        actorUserId: session.clerkId,
        bookingId: booking.id,
        caseId: manualCase.id,
        observationId: stored.observationId,
        evidenceReplay: stored.replay === true,
        evidenceCaseVersion: stored.caseVersion,
        facts,
      });
      if (!classified.ok) {
        return NextResponse.json(
          {
            error:
              "Supplier evidence was recorded, but its operation/case outcome could not be classified safely. Retry the same Sync request.",
            code: classified.code,
          },
          { status: 503 },
        );
      }
      verification = classified.verification;
    }
    await dispatchBookingStatusEmails(result.booking.id);
    return NextResponse.json({
      success: true,
      status: result.status,
      paymentState: result.booking.payment_state,
      walletCharged: false,
      reconciliationRequired: result.reconciliationRequired ?? false,
      reconciliationCaseId: result.reconciliationCaseId ?? null,
      verification,
      bookingOrderUrl: `/dashboard/bookings/${encodeURIComponent(result.booking.public_ref)}`,
    });
  } catch (error) {
    console.error("[impexp] booking sync failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Imported booking Sync failed.",
      },
      { status: 502 },
    );
  } finally {
    if (lock) await releaseSecurityLock(lock);
  }
}
