import "server-only";

import type { BookingRow } from "@/lib/db/flight-bookings";
import {
  deriveBookingStatus,
  type StoredBookingStatus,
} from "@/lib/flights/booking-status";
import type {
  ImpExpAssignableUser,
  ImpExpHistoryItem,
  NormalizedBookingImport,
} from "@/lib/impexp/types";
import type {
  ManualBookingImportInput,
  ManualBookingStatusInput,
} from "@/lib/impexp/manual-validation";
import { normalizeManualBooking } from "@/lib/impexp/manual-normalize";
import type {
  ImportedTicketingResolutionAssessment,
  ImportedTicketingResolutionInput,
  ImportedTicketingResolutionResult,
} from "@/lib/impexp/ticketing-resolution";
import type { Role } from "@/lib/roles";
import { supabaseAdmin } from "@/lib/supabase/server";
import { majorToMinor } from "@/lib/wallet/money";

const ASSIGNABLE = new Set<Role>(["b2b", "b2b_sub", "customer"]);

export async function listImpExpAssignableUsers(
  role: Role,
): Promise<ImpExpAssignableUser[]> {
  if (!ASSIGNABLE.has(role)) return [];
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase
    .from("app_users")
    .select("clerk_id, role, email, first_name, last_name, agency_code")
    .eq("role", role)
    .order("first_name", { ascending: true })
    .limit(500);
  if (error)
    throw new Error(`Assignable users could not be loaded: ${error.message}`);

  // Resolve agency metadata in two bulk reads. This keeps the selector useful
  // for both agency owners and sub-users without introducing a per-user query.
  const agencyCodes = Array.from(
    new Set(
      (data ?? []).flatMap((row) =>
        typeof row.agency_code === "string" && row.agency_code.trim()
          ? [row.agency_code.trim()]
          : [],
      ),
    ),
  );
  const agencyOwnerByCode = new Map<string, string>();
  if (agencyCodes.length > 0) {
    const agencies = await supabase
      .from("agencies")
      .select("agency_code, owner_user_id")
      .in("agency_code", agencyCodes);
    if (agencies.error) {
      throw new Error(
        `Assignable user agencies could not be loaded: ${agencies.error.message}`,
      );
    }
    for (const agency of agencies.data ?? []) {
      if (
        typeof agency.agency_code === "string" &&
        typeof agency.owner_user_id === "string"
      ) {
        agencyOwnerByCode.set(agency.agency_code, agency.owner_user_id);
      }
    }
  }

  const profileIds = Array.from(
    new Set([
      ...Array.from(agencyOwnerByCode.values()),
      ...(data ?? []).flatMap((row) =>
        row.role === "b2b" && typeof row.clerk_id === "string"
          ? [row.clerk_id]
          : [],
      ),
    ]),
  );
  const agencyNameByOwner = new Map<string, string>();
  if (profileIds.length > 0) {
    const profiles = await supabase
      .from("user_profiles")
      .select("clerk_id, agency_name")
      .in("clerk_id", profileIds);
    if (profiles.error) {
      throw new Error(
        `Assignable user agency names could not be loaded: ${profiles.error.message}`,
      );
    }
    for (const profile of profiles.data ?? []) {
      if (
        typeof profile.clerk_id === "string" &&
        typeof profile.agency_name === "string" &&
        profile.agency_name.trim()
      ) {
        agencyNameByOwner.set(profile.clerk_id, profile.agency_name.trim());
      }
    }
  }

  return (data ?? []).map((row) => ({
    id: String(row.clerk_id),
    role: row.role as ImpExpAssignableUser["role"],
    email: typeof row.email === "string" ? row.email : "",
    name:
      [row.first_name, row.last_name]
        .filter(
          (value): value is string =>
            typeof value === "string" && !!value.trim(),
        )
        .join(" ") ||
      (typeof row.email === "string" ? row.email : String(row.clerk_id)),
    agencyId:
      typeof row.agency_code === "string" && row.agency_code.trim()
        ? row.agency_code.trim()
        : null,
    agencyName: (() => {
      if (typeof row.agency_code !== "string" || !row.agency_code.trim()) {
        return null;
      }
      const ownerId =
        agencyOwnerByCode.get(row.agency_code.trim()) ??
        (row.role === "b2b" ? String(row.clerk_id) : null);
      return ownerId ? (agencyNameByOwner.get(ownerId) ?? null) : null;
    })(),
  }));
}

export async function saveImportedBooking(input: {
  actorUserId: string;
  assignedUserId: string;
  userPayableAmount: number;
  supplierGrossAmount: number;
  booking: NormalizedBookingImport;
  importDecision: "import_only" | "import_and_charge";
  chargeAuthorizationId?: string | null;
  requestId: string;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase.rpc("create_impexp_booking_v2", {
    p_actor_user_id: input.actorUserId,
    p_assigned_user_id: input.assignedUserId,
    p_user_payable_amount: input.userPayableAmount,
    p_supplier_gross_amount: input.supplierGrossAmount,
    p_data: input.booking,
    p_import_decision: input.importDecision,
    p_charge_authorization_id: input.chargeAuthorizationId ?? null,
    p_request_key: `impexp-import:v2:${input.requestId}`,
  });
  if (error)
    throw new Error(`Imported booking could not be saved: ${error.message}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Imported booking returned an invalid response.");
  }
  return data as ImpExpOperationResult;
}

export type ImpExpChargeAuthorizationResult = {
  ok: boolean;
  code?: string;
  authorizationId?: string;
  expiresAt?: string;
  consumed?: boolean;
  replay?: boolean;
  amount?: number;
  currency?: string;
  walletAvailable?: number;
  walletMutation?: false;
  available?: number;
  required?: number;
};

export async function authorizeImportedBookingCharge(input: {
  actorUserId: string;
  assignedUserId: string;
  userPayableAmount: number;
  supplierGrossAmount: number;
  booking: NormalizedBookingImport;
  requestId: string;
}): Promise<ImpExpChargeAuthorizationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: "STORAGE_UNAVAILABLE" };
  const { data, error } = await supabase.rpc(
    "authorize_impexp_import_charge_v1",
    {
      p_actor_user_id: input.actorUserId,
      p_assigned_user_id: input.assignedUserId,
      p_user_payable_amount: input.userPayableAmount,
      p_supplier_gross_amount: input.supplierGrossAmount,
      p_data: input.booking,
      p_request_key: `impexp-charge-authorization:v1:${input.requestId}`,
    },
  );
  if (error) {
    console.error(
      "[db] imported booking charge authorization failed:",
      error.message,
    );
    return {
      ok: false,
      code:
        error.code === "22023"
          ? "CHARGE_AUTHORIZATION_IDENTITY_MISMATCH"
          : "STORAGE_ERROR",
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "INVALID_DATABASE_RESPONSE" };
  }
  return data as ImpExpChargeAuthorizationResult;
}

export type ImpExpOperationResult = {
  ok: boolean;
  code?: string;
  booking?: BookingRow;
  walletCharged?: boolean;
  chargePreviouslyCaptured?: boolean;
  importDecision?: "import_only" | "import_and_charge";
  priorChargeAuthorizationVerified?: boolean;
  chargeAuthorizationId?: string;
  amount?: number;
  accountId?: string;
  status?: string;
  reimport?: boolean;
  available?: number;
  required?: number;
  currency?: string;
  reconciliationRequired?: boolean;
  reconciliationCaseId?: string;
  replay?: boolean;
  operationId?: string;
  caseId?: string;
  caseVersion?: number;
  evidenceObservationId?: string;
  lifecycleEventId?: number;
  ticketCount?: number;
  additionalDebit?: number;
  classification?:
    | "ticketed"
    | "held"
    | "cancelled"
    | "expired"
    | "unconfirmed"
    | "conflicting";
  requiredAction?:
    | "complete_ticketing"
    | "continue_supplier_follow_up"
    | "financial_disposition_required"
    | "admin_review_required";
  operationState?: "awaiting_external_action" | "needs_reconciliation";
  caseState?: string;
  assignedTeam?: "support" | "accounts" | "admin";
  financialDisposition?: string;
  financialDispositionRequired?: boolean;
  bookingStatusMutation?: boolean;
  walletMutation?: boolean;
  ledgerMutation?: boolean;
};

export async function saveManualBooking(input: {
  actorUserId: string;
  booking: ManualBookingImportInput;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const normalized = normalizeManualBooking(input.booking);
  const { data, error } = await supabase.rpc("create_manual_booking_v2", {
    p_actor_user_id: input.actorUserId,
    p_assigned_user_id: input.booking.assignedToUserId,
    p_user_payable_amount: Math.round(Number(input.booking.userPayableAmount) * 100),
    p_supplier_gross_amount: Math.round(Number(input.booking.supplierGrossAmount) * 100),
    p_supplier_payable_amount: Math.round(Number(input.booking.supplierPayableAmount) * 100),
    p_data: normalized,
    p_request_key: `manual-import:v1:${input.booking.requestId}`,
  });
  if (error) throw new Error(`Manual booking could not be saved: ${error.message}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Manual booking returned an invalid response.");
  }
  return data as ImpExpOperationResult;
}

export async function updateManualBookingStatus(input: {
  actorUserId: string;
  bookingId: string;
  status: ManualBookingStatusInput;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase.rpc("update_manual_booking_status_v1", {
    p_booking_id: input.bookingId,
    p_actor_user_id: input.actorUserId,
    p_target_status: input.status.targetStatus,
    p_data: {
      pnr: input.status.pnr ?? null,
      airlinesPnr: input.status.airlinePnr ? [input.status.airlinePnr] : null,
      ticketingDeadlineAt: input.status.ticketingDeadlineAt ?? null,
      cancellationReason: input.status.cancellationReason ?? null,
      ticketNumbers: input.status.ticketing?.ticketNumbers ?? [],
      issuedAt: input.status.ticketing?.issuedAt ?? null,
    },
    p_request_key: `manual-status:v1:${input.status.requestId}`,
  });
  if (error) throw new Error(`Manual booking status could not be updated: ${error.message}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Manual booking status returned an invalid response.");
  }
  return data as ImpExpOperationResult;
}

export async function readImportedTicketingResolutionContext(input: {
  actorUserId: string;
  bookingId: string;
}): Promise<ImportedTicketingResolutionAssessment> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase.rpc(
    "imported_ticketing_resolution_context_v1",
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
    },
  );
  if (error) {
    throw new Error(`Imported ticketing context could not be loaded: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Imported ticketing context returned an invalid response.");
  }
  const result = data as Record<string, unknown>;
  if (result.ok === true) {
    return result as unknown as ImportedTicketingResolutionAssessment;
  }
  if (result.ok === false && typeof result.code === "string") {
    return { ok: false, code: result.code };
  }
  throw new Error("Imported ticketing context returned an invalid result.");
}

export async function resolveImportedTicketing(input: {
  actorUserId: string;
  bookingId: string;
  resolution: ImportedTicketingResolutionInput;
}): Promise<ImportedTicketingResolutionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const cancellation = input.resolution.cancellation;
  const { data, error } = await supabase.rpc(
    "resolve_imported_booking_ticketing_v1",
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_decision: input.resolution.decision,
      p_data: {
        ticketNumbers: input.resolution.ticketing?.ticketNumbers ?? [],
        issuedAt: input.resolution.ticketing?.issuedAt ?? null,
        cancellationAt: cancellation?.cancellationAt ?? null,
        cancellationReason: cancellation?.reason ?? null,
        refundDisposition: cancellation?.refundDisposition ?? null,
        refundAmount:
          cancellation?.refundAmount === undefined
            ? null
            : majorToMinor(cancellation.refundAmount),
        externalSettlementReference:
          cancellation?.externalSettlementReference ?? null,
      },
      p_request_key: `imported-resolution:v1:${input.resolution.requestId}`,
      p_money_effect_confirmed: input.resolution.moneyEffectConfirmed,
    },
  );
  if (error) {
    throw new Error(`Imported ticketing resolution failed: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Imported ticketing resolution returned an invalid response.");
  }
  return data as ImportedTicketingResolutionResult;
}

export type ImpExpManualTicketEscalationResult = {
  ok: boolean;
  available: boolean;
  processed: number;
  unassignedWarnings: number;
  adminEscalations: number;
  superadminEscalations: number;
  remainingEligible: number;
  limit: number;
  publicStatusMutation: false;
  walletMutation: false;
  supplierTruthInferred: false;
  code?: string;
};

export async function syncImportedBooking(input: {
  actorUserId: string;
  bookingId: string;
  supplierGrossAmount: number;
  booking: NormalizedBookingImport;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase.rpc("sync_impexp_booking_v2", {
    p_actor_user_id: input.actorUserId,
    p_booking_id: input.bookingId,
    p_supplier_gross_amount: input.supplierGrossAmount,
    p_data: input.booking,
  });
  if (error) {
    throw new Error(`Imported booking could not be synced: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Imported booking sync returned an invalid response.");
  }
  return data as ImpExpOperationResult;
}

export async function completeImportedManualTicketing(input: {
  actorUserId: string;
  bookingId: string;
  caseId: string;
  evidenceObservationId: string;
  requestId: string;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: "STORAGE_UNAVAILABLE" };
  const { data, error } = await supabase.rpc(
    "complete_impexp_manual_ticketing_v1",
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_evidence_observation_id: input.evidenceObservationId,
      p_actor_user_id: input.actorUserId,
      p_request_key: `impexp-manual-complete:v1:${input.requestId}`,
    },
  );
  if (error) {
    console.error("[db] imported manual-ticket completion failed:", error.message);
    return {
      ok: false,
      code:
        error.code === "22023"
          ? "IMPEXP_COMPLETION_IDENTITY_MISMATCH"
          : "STORAGE_ERROR",
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "INVALID_DATABASE_RESPONSE" };
  }
  return data as ImpExpOperationResult;
}

export async function classifyImportedManualTicketOutcome(input: {
  actorUserId: string;
  bookingId: string;
  caseId: string;
  evidenceObservationId: string;
}): Promise<ImpExpOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: "STORAGE_UNAVAILABLE" };
  const { data, error } = await supabase.rpc(
    "classify_impexp_manual_ticket_outcome_v1",
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_evidence_observation_id: input.evidenceObservationId,
      p_actor_user_id: input.actorUserId,
    },
  );
  if (error) {
    console.error("[db] imported supplier outcome classification failed:", error.message);
    return {
      ok: false,
      code:
        error.code === "22023"
          ? "IMPEXP_OUTCOME_IDENTITY_MISMATCH"
          : "STORAGE_ERROR",
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "INVALID_DATABASE_RESPONSE" };
  }
  return data as ImpExpOperationResult;
}

export async function processImportedManualTicketEscalations(
  limit = 100,
): Promise<ImpExpManualTicketEscalationResult> {
  const unavailable = (
    code: string,
    available: boolean,
  ): ImpExpManualTicketEscalationResult => ({
    ok: false,
    available,
    processed: 0,
    unassignedWarnings: 0,
    adminEscalations: 0,
    superadminEscalations: 0,
    remainingEligible: 0,
    limit,
    publicStatusMutation: false,
    walletMutation: false,
    supplierTruthInferred: false,
    code,
  });
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable("STORAGE_UNAVAILABLE", false);
  const { data, error } = await supabase.rpc(
    "process_impexp_manual_ticket_escalations_v1",
    { p_limit: limit },
  );
  if (error) {
    console.error("[db] imported manual-ticket escalation failed:", error.message);
    return unavailable("ESCALATION_UNAVAILABLE", false);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return unavailable("INVALID_DATABASE_RESPONSE", true);
  }
  const result = data as Partial<ImpExpManualTicketEscalationResult>;
  return {
    ok: result.ok === true,
    available: true,
    processed: Number(result.processed) || 0,
    unassignedWarnings: Number(result.unassignedWarnings) || 0,
    adminEscalations: Number(result.adminEscalations) || 0,
    superadminEscalations: Number(result.superadminEscalations) || 0,
    remainingEligible: Number(result.remainingEligible) || 0,
    limit: Number(result.limit) || limit,
    publicStatusMutation: false,
    walletMutation: false,
    supplierTruthInferred: false,
    ...(typeof result.code === "string" ? { code: result.code } : {}),
  };
}

function leadName(passengers: unknown): string {
  if (!passengers || typeof passengers !== "object") return "—";
  const travellers = (passengers as { travellers?: unknown }).travellers;
  if (!Array.isArray(travellers) || travellers.length === 0) return "—";
  const lead = travellers[0] as Record<string, unknown>;
  const name = [lead.firstName, lead.lastName]
    .filter(
      (value): value is string => typeof value === "string" && !!value.trim(),
    )
    .join(" ");
  return travellers.length > 1
    ? `${name || "Passenger"} (+${travellers.length - 1})`
    : name || "—";
}

export async function listImpExpHistory(
  limit = 300,
): Promise<ImpExpHistoryItem[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error("Booking storage is unavailable.");
  const { data, error } = await supabase
    .from("flight_bookings")
    .select(
      "id, public_ref, supplier, supplier_account, supplier_refs, user_id, booking_ref_number, passengers, pricing_snapshot, supplier_gross_amount, user_payable_amount, payment_state, currency, status, airlines_pnr, ticketing_deadline_at, import_metadata, import_source, booking_origin, created_at",
    )
    .or(
      "import_source.in.(IMP_EXP,MANUAL),booking_origin.eq.supplier_reference_import",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error)
    throw new Error(`Import history could not be loaded: ${error.message}`);

  const rows = data ?? [];
  const userIds = Array.from(
    new Set(
      rows
        .map((row) => (typeof row.user_id === "string" ? row.user_id : ""))
        .filter(Boolean),
    ),
  );
  const usersById: Record<string, { email: string; role: string }> = {};
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from("app_users")
      .select("clerk_id, email, role")
      .in("clerk_id", userIds);
    if (usersError)
      throw new Error(
        `Import assignments could not be loaded: ${usersError.message}`,
      );
    (users ?? []).forEach((user) => {
      usersById[String(user.clerk_id)] = {
        email: typeof user.email === "string" ? user.email : "",
        role: typeof user.role === "string" ? user.role : "",
      };
    });
  }

  return rows.map((row) => {
    const pricing =
      row.pricing_snapshot && typeof row.pricing_snapshot === "object"
        ? (row.pricing_snapshot as Record<string, unknown>)
        : {};
    const importMetadata =
      row.import_metadata && typeof row.import_metadata === "object"
        ? (row.import_metadata as Record<string, unknown>)
        : {};
    const originalReference =
      typeof importMetadata.originalReference === "string"
        ? importMetadata.originalReference.trim()
        : "";
    const supplierRefs =
      row.supplier_refs && typeof row.supplier_refs === "object"
        ? (row.supplier_refs as Record<string, unknown>)
        : {};
    const supplierApiImport =
      row.booking_origin === "supplier_reference_import";
    const assignee = usersById[String(row.user_id ?? "")];
    return {
      id: String(row.id),
      importedOn: String(row.created_at ?? ""),
      referenceNo: String(row.public_ref ?? ""),
      supplierReference:
        supplierApiImport && typeof supplierRefs.uniqueTransId === "string"
          ? supplierRefs.uniqueTransId
          : originalReference || String(row.booking_ref_number ?? ""),
      provider: supplierApiImport
        ? String(row.supplier_account ?? "")
        : String(row.supplier ?? ""),
      source: supplierApiImport
        ? "SUPPLIER_API"
        : row.import_source === "MANUAL"
          ? "MANUAL"
          : "IMP_EXP",
      status: deriveBookingStatus({
        status: row.status as StoredBookingStatus,
        airlinesPnr: Array.isArray(row.airlines_pnr)
          ? row.airlines_pnr.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        ticketingDeadlineAt:
          typeof row.ticketing_deadline_at === "string"
            ? row.ticketing_deadline_at
            : null,
      }),
      paxName: leadName(row.passengers),
      assigned: assignee
        ? `${assignee.email || row.user_id} (${assignee.role})`
        : String(row.user_id ?? "—"),
      supplierGross:
        row.supplier_gross_amount === null
          ? Number(pricing.supplierTotalPrice) || 0
          : Number(row.supplier_gross_amount) / 100,
      userPayable:
        row.user_payable_amount === null
          ? Number(pricing.sellingPrice) || 0
          : Number(row.user_payable_amount) / 100,
      paymentState: String(row.payment_state ?? "unpaid"),
      currency: String(row.currency ?? "BDT"),
    };
  });
}
