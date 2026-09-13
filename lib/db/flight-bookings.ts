import 'server-only';
import { SITE_NAME, SITE_PHONE, SITE_EMAIL, SITE_ADDRESS, SITE_LICENSE_NUMBER } from '@/lib/site';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';




import type {
  BookedItinerary,
  BookingDraftPricing,
  BookingPassengerType,
  PrivateBookingRefs,
  PublicBooking,
} from '@/lib/flights/booking';
import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import type { DashboardSession } from '@/lib/dashboard/session';
import {
  isBookingStatus,
  resolvePublicBookingStatus,
  type StoredBookingStatus,
} from '@/lib/flights/booking-status';
import type { FareBreakdown } from '@/lib/flights/types';
import type { AirTicketingDetails } from '@/lib/triplover/air-ticketing-details';
import { mergeSupplierTerminals } from '@/lib/flights/itinerary-terminals';
import type { PnrLookupOutcome } from '@/lib/triplover/pnr';
import { getSiteLogo } from '@/lib/appearance';
import { authenticatedImageUrl } from '@/lib/cloudinary';
import { coerceDocumentMap } from '@/lib/documents';
import { customerStatusMessage } from '@/lib/flights/customer-status';
import { passportRequiredForItinerary } from '@/lib/airports/country';
import { supabaseAdmin } from '@/lib/supabase/server';
import type {
  BookingListQuery,
  BookingListSortKey,
} from '@/lib/dashboard/booking-list-query';
import { bookingUserVisibilitySchemaAvailable } from '@/lib/db/booking-visibility';
import { BookingReadUnavailableError } from '@/lib/db/booking-read-error';

const LIFECYCLE_VIEW = 'booking_lifecycle_v';
const DASHBOARD_LIST_VIEW = 'booking_dashboard_creator_v';

const B2C_HEADER_CONTACT = {
  name: SITE_NAME,
  licenseNo: SITE_LICENSE_NUMBER,
  mobile: SITE_PHONE,
  email: SITE_EMAIL,
  address: SITE_ADDRESS,
  logoUrl: null,
};

export type BookingRow = {
  id: string;
  /** Stable KTT locator-based customer reference; legacy STR references remain supported. */
  public_ref: string;
  /** The operational row this booking came from. */
  attempt_id: string;
  /** Retained pre-attempt rows are returned only by the explicit Super Admin reader. */
  legacy_operational: boolean;
  supplier: string;
  /** Credential account fixed when this booking was first searched. */
  supplier_account: import('@/lib/triplover/config').TriploverSupplier | null;
  user_id: string | null;
  audience: 'b2c' | 'agency' | 'superadmin';
  agency_code: string | null;
  search_id: string;
  itinerary_id: string;
  /** A decided business state. Expired and Unconfirmed are never stored. */
  status: StoredBookingStatus;
  /** Present on authoritative lifecycle-view rows. */
  lifecycle_status?: import('@/lib/flights/booking-status').BookingStatus;
  /** Latest audit event for list display fallbacks; populated by listBookings. */
  last_lifecycle_event_at?: string | null;
  operation_kind: 'ticketing' | 'cancellation' | 'reconciliation' | null;
  operation_reason:
    | 'ticketing'
    | 'supplier_balance_insufficient'
    | 'ticketing_reconciliation'
    | 'cancellation'
    | 'cancellation_reconciliation'
    | 'terminal_state_conflict'
    | 'direct_ticket_payment_reconciliation'
    | 'legacy_reconciliation'
    | 'imported_manual_ticketing'
    | null;
  operation_request_id: string | null;
  operation_actor_user_id: string | null;
  operation_started_at: string | null;
  operation_prior_status: StoredBookingStatus | null;
  currency: string;
  pricing_snapshot: BookingDraftPricing;
  passenger_counts: Partial<Record<BookingPassengerType, number>>;
  travel_date: string;
  direct_ticketing: boolean;
  /** Null on rows written before migration 0015. */
  itinerary: BookedItinerary | null;
  fares: unknown;
  passport_required: boolean | null;
  supplier_refs: PrivateBookingRefs;
  booking_code_ref: string | null;
  ticket_code_ref: string | null;
  repriced_at: string;
  accepted_at: string;
  passengers: unknown;
  pnr: string | null;
  /** The airline's own PNR(s). Empty when the airline never confirmed. */
  airlines_pnr: unknown;
  booking_ref_number: string | null;
  booking_status: string | null;
  /** The supplier's wall-clock string, kept verbatim for display. */
  ticketing_time_limit: string | null;
  /** The same deadline as an instant. What Expired is computed from. */
  ticketing_deadline_at: string | null;
  deadline_source:
    | 'supplier'
    | 'pnr_call'
    | 'assumed'
    | 'local_approved'
    | 'superadmin_override'
    | null;
  /** Current supplier evidence, preserved even while a local deadline is effective. */
  supplier_ticketing_time_limit?: string | null;
  supplier_ticketing_deadline_at?: string | null;
  supplier_deadline_source?: string | null;
  /** Staff-approved local deadline and the request currently authorizing it. */
  local_ticketing_deadline_at?: string | null;
  active_local_time_limit_request_id?: string | null;
  ticket_numbers: unknown;
  warnings: unknown;
  error_code: string | null;
  supplier_message: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  synced_at: string | null;
  submission_started_at: string | null;
  booking_owner_type: 'user' | 'agency' | null;
  booking_owner_key: string | null;
  booked_by_user_id: string | null;
  issued_by_user_id: string | null;
  charged_wallet_account_id: string | null;
  payment_state:
    | 'unpaid'
    | 'held'
    | 'captured'
    | 'released'
    | 'reconciliation'
    | 'partially-refunded'
    | 'refunded';
  payment_amount: number | null;
  captured_amount: number;
  refunded_amount: number;
  supplier_gross_amount: number | null;
  user_payable_amount: number | null;
  import_source: 'IMP_EXP' | 'MANUAL' | null;
  imported_by_user_id: string | null;
  import_metadata: Record<string, unknown> | null;
  /** Audit-only origin; does not change normal Triplover API behavior. */
  booking_origin: 'supplier_reference_import' | null;
  /** Visibility-only state. Internal workers and staff readers do not filter it. */
  hidden_from_user: boolean;
  hidden_by_user_id: string | null;
  hidden_at: string | null;
  hidden_reason: string | null;
  created_at: string;
  updated_at: string;
  on_hold_email_claimed_at: string | null;
  on_hold_email_sent_at: string | null;
  confirmed_email_claimed_at: string | null;
  confirmed_email_sent_at: string | null;
  confirmed_email_attempt_count: number;
  confirmed_email_last_error: string | null;
};

/**
 * Narrow database row used only by the paginated dashboard list. It is kept
 * separate from `BookingRow`: the list must never pull full itinerary,
 * traveller, supplier, or email-delivery snapshots just to draw a table row.
 */
export type BookingDashboardListDbRow = {
  id: string;
  public_ref: string;
  user_id: string | null;
  agency_code: string | null;
  status: StoredBookingStatus;
  lifecycle_status: import('@/lib/flights/booking-status').BookingStatus;
  operation_kind: BookingRow['operation_kind'];
  operation_reason: BookingRow['operation_reason'];
  operation_started_at: string | null;
  created_at: string;
  issued_at: string | null;
  cancelled_at: string | null;
  ticketing_deadline_at: string | null;
  last_lifecycle_event_at: string | null;
  supplier_reference: string | null;
  airline_pnr: string;
  pnr: string;
  lead_name: string | null;
  traveller_count: number;
  passenger_counts: Partial<Record<BookingPassengerType, number>>;
  fare: number | string;
  gross: number | string | null;
  route: string;
  airline: string;
  fly_date: string;
  supplier_payable: number | string | null;
  booking_user_email: string;
  creator_name: string;
  creator_role: string;
  creator_email: string;
  creator_agency_code: string | null;
  creator_agency_name: string | null;
  /** Agency that owns the booking, which can differ from its internal creator. */
  booking_agency_code: string | null;
  booking_agency_name: string | null;
  creator_search_text: string;
  import_source: BookingRow['import_source'];
  payment_state: BookingRow['payment_state'];
  hidden_from_user: boolean;
  hidden_at: string | null;
};

export type BookingDashboardListPage = {
  rows: BookingDashboardListDbRow[];
  total: number;
  /** True when the list could not be read; distinct from a valid empty page. */
  loadError: boolean;
};

export async function claimOnHoldBookingEmail(bookingId: string): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('claim_on_hold_booking_email', {
    p_booking_id: bookingId,
  });
  if (error) {
    console.error('[db] claimOnHoldBookingEmail failed:', error.message);
    return false;
  }
  return data === true;
}

export async function markOnHoldBookingEmailSent(bookingId: string): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('mark_on_hold_booking_email_sent', {
    p_booking_id: bookingId,
  });
  if (error) console.error('[db] markOnHoldBookingEmailSent failed:', error.message);
}

export async function releaseOnHoldBookingEmailClaim(bookingId: string): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('release_on_hold_booking_email_claim', {
    p_booking_id: bookingId,
  });
  if (error) console.error('[db] releaseOnHoldBookingEmailClaim failed:', error.message);
}

export async function claimConfirmedBookingEmail(bookingId: string): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('claim_confirmed_booking_email', {
    p_booking_id: bookingId,
  });
  if (error) {
    console.error('[db] claimConfirmedBookingEmail failed:', error.message);
    return false;
  }
  return data === true;
}

export async function markConfirmedBookingEmailSent(bookingId: string): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('mark_confirmed_booking_email_sent', {
    p_booking_id: bookingId,
  });
  if (error) console.error('[db] markConfirmedBookingEmailSent failed:', error.message);
}

export async function failConfirmedBookingEmail(
  bookingId: string,
  errorMessage: string
): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('fail_confirmed_booking_email', {
    p_booking_id: bookingId,
    p_error: errorMessage.slice(0, 500),
  });
  if (error) console.error('[db] failConfirmedBookingEmail failed:', error.message);
}

export async function claimBookingStatusEmail(
  bookingId: string,
  status: import('@/lib/flights/booking-status').BookingStatus
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('claim_booking_status_email', {
    p_booking_id: bookingId,
    p_lifecycle_status: status,
  });
  if (error) {
    console.error('[db] claimBookingStatusEmail failed:', error.message);
    return false;
  }
  return data === true;
}

export async function markBookingStatusEmailSent(
  bookingId: string,
  status: import('@/lib/flights/booking-status').BookingStatus
): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('mark_booking_status_email_sent', {
    p_booking_id: bookingId,
    p_lifecycle_status: status,
  });
  if (error) console.error('[db] markBookingStatusEmailSent failed:', error.message);
}

export async function failBookingStatusEmail(
  bookingId: string,
  status: import('@/lib/flights/booking-status').BookingStatus,
  errorMessage: string
): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('fail_booking_status_email', {
    p_booking_id: bookingId,
    p_lifecycle_status: status,
    p_error: errorMessage.slice(0, 500),
  });
  if (error) console.error('[db] failBookingStatusEmail failed:', error.message);
}

export type BookingStatusEmailJob = {
  booking_id: string;
  lifecycle_status: import('@/lib/flights/booking-status').BookingStatus;
};

export async function pendingBookingStatusEmailJobs(
  limit = 100,
  bookingId?: string
): Promise<BookingStatusEmailJob[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('pending_booking_status_email_jobs', {
    p_limit: limit,
    p_booking_id: bookingId ?? null,
  });
  if (error) {
    console.error('[db] pendingBookingStatusEmailJobs failed:', error.message);
    return [];
  }
  return ((data as BookingStatusEmailJob[] | null) ?? []).filter(
    (job) => isBookingStatus(job.lifecycle_status)
  );
}

export async function observeDerivedBookingStatuses(limit = 500): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc('record_booking_lifecycle_observations', {
    p_limit: limit,
  });
  if (error) {
    console.error('[db] observeDerivedBookingStatuses failed:', error.message);
    return 0;
  }
  return Number(data) || 0;
}

export type DerivedBookingStatusObservationCursor = {
  deadline: string;
  bookingId: string;
};

export type DerivedBookingStatusObservationBatch = {
  selectedCount: number;
  insertedCount: number;
  hasMore: boolean;
  observedAt: string;
  nextCursor: DerivedBookingStatusObservationCursor | null;
};

export type DerivedBookingStatusObservationWorkerResult = {
  runId: string | null;
  batches: number;
  selected: number;
  inserted: number;
  durationMs: number;
  stopReason: 'drained' | 'time_budget' | 'batch_cap' | 'rpc_error' | 'invalid_cursor';
  nextCursor: DerivedBookingStatusObservationCursor | null;
  error?: string;
};

function derivedObservationBatch(
  value: unknown
): DerivedBookingStatusObservationBatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const selectedCount = Number(row.selectedCount);
  const insertedCount = Number(row.insertedCount);
  const observedAt = typeof row.observedAt === 'string' ? row.observedAt : '';
  const nextDeadline =
    typeof row.nextDeadline === 'string' ? row.nextDeadline : null;
  const nextId = typeof row.nextId === 'string' ? row.nextId : null;
  if (
    !Number.isSafeInteger(selectedCount) ||
    selectedCount < 0 ||
    !Number.isSafeInteger(insertedCount) ||
    insertedCount < 0 ||
    insertedCount > selectedCount ||
    !observedAt
  ) {
    return null;
  }
  if ((nextDeadline === null) !== (nextId === null)) return null;
  if (selectedCount > 0 && (nextDeadline === null || nextId === null)) return null;
  return {
    selectedCount,
    insertedCount,
    hasMore: row.hasMore === true,
    observedAt,
    nextCursor:
      nextDeadline && nextId
        ? { deadline: nextDeadline, bookingId: nextId }
        : null,
  };
}

export async function observeDerivedBookingStatusBatch(input: {
  runId: string;
  limit: number;
}): Promise<
  | { ok: true; batch: DerivedBookingStatusObservationBatch }
  | { ok: false; error: string }
> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, error: 'Database is not configured.' };
  const { data, error } = await supabase.rpc(
    'record_due_booking_expiry_worker_batch_v2',
    {
      p_run_id: input.runId,
      p_limit: Math.max(1, Math.min(Math.trunc(input.limit), 500)),
    }
  );
  if (error) {
    console.error('[db] observeDerivedBookingStatusBatch failed:', error.message);
    return { ok: false, error: error.message };
  }
  const batch = derivedObservationBatch(data);
  if (!batch) {
    return { ok: false, error: 'Expiry observer returned an invalid batch.' };
  }
  return { ok: true, batch };
}

async function startDerivedBookingStatusObservationRun(): Promise<
  { ok: true; runId: string } | { ok: false; error: string }
> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, error: 'Database is not configured.' };
  const { data, error } = await supabase.rpc(
    'start_due_booking_expiry_worker_run_v1'
  );
  if (error || typeof data !== 'string' || !data) {
    const message = error?.message ?? 'Expiry observer did not create a run.';
    console.error('[db] startDerivedBookingStatusObservationRun failed:', message);
    return { ok: false, error: message };
  }
  return { ok: true, runId: data };
}

async function completeDerivedBookingStatusObservationRun(input: {
  runId: string;
  stopReason: DerivedBookingStatusObservationWorkerResult['stopReason'];
  error?: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc(
    'complete_due_booking_expiry_worker_run_v1',
    {
      p_run_id: input.runId,
      p_stop_reason: input.stopReason,
      p_error: input.error ?? null,
    }
  );
  if (error) {
    console.error(
      '[db] completeDerivedBookingStatusObservationRun failed:',
      error.message
    );
  }
}

export async function processDerivedBookingStatusObservations(options?: {
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  safetyMarginMs?: number;
}): Promise<DerivedBookingStatusObservationWorkerResult> {
  const batchSize = Math.max(1, Math.min(Math.trunc(options?.batchSize ?? 250), 500));
  const maxBatches = Math.max(1, Math.min(Math.trunc(options?.maxBatches ?? 20), 100));
  const timeBudgetMs = Math.max(500, Math.min(options?.timeBudgetMs ?? 10_000, 60_000));
  const safetyMarginMs = Math.max(
    100,
    Math.min(options?.safetyMarginMs ?? 500, Math.floor(timeBudgetMs / 2))
  );
  const startedAt = performance.now();
  const started = await startDerivedBookingStatusObservationRun();
  if (!started.ok) {
    return {
      runId: null,
      batches: 0,
      selected: 0,
      inserted: 0,
      durationMs: Math.round(performance.now() - startedAt),
      stopReason: 'rpc_error',
      nextCursor: null,
      error: started.error,
    };
  }
  let cursor: DerivedBookingStatusObservationCursor | null = null;
  let batches = 0;
  let selected = 0;
  let inserted = 0;
  let stopReason: DerivedBookingStatusObservationWorkerResult['stopReason'] =
    'batch_cap';
  let workerError: string | undefined;

  while (batches < maxBatches) {
    if (performance.now() - startedAt >= timeBudgetMs - safetyMarginMs) {
      stopReason = 'time_budget';
      break;
    }
    const result = await observeDerivedBookingStatusBatch({
      runId: started.runId,
      limit: batchSize,
    });
    if (!result.ok) {
      stopReason = 'rpc_error';
      workerError = result.error;
      break;
    }
    batches += 1;
    selected += result.batch.selectedCount;
    inserted += result.batch.insertedCount;

    if (!result.batch.hasMore || result.batch.selectedCount < batchSize) {
      cursor = result.batch.nextCursor;
      stopReason = 'drained';
      break;
    }
    const nextCursor = result.batch.nextCursor;
    if (
      !nextCursor ||
      (cursor?.deadline === nextCursor.deadline &&
        cursor.bookingId === nextCursor.bookingId)
    ) {
      stopReason = 'invalid_cursor';
      workerError = 'Expiry observer did not advance its cursor.';
      break;
    }
    cursor = nextCursor;
  }

  await completeDerivedBookingStatusObservationRun({
    runId: started.runId,
    stopReason,
    error: workerError,
  });
  return {
    runId: started.runId,
    batches,
    selected,
    inserted,
    durationMs: Math.round(performance.now() - startedAt),
    stopReason,
    nextCursor: cursor,
    ...(workerError ? { error: workerError } : {}),
  };
}

export type UnconfirmedBookingRepairResult = {
  selected: number;
  inserted: number;
  hasMore: boolean;
  nextId: string | null;
  error?: string;
};

export async function repairUnconfirmedBookingObservations(
  limit = 50
): Promise<UnconfirmedBookingRepairResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      selected: 0,
      inserted: 0,
      hasMore: false,
      nextId: null,
      error: 'Database is not configured.',
    };
  }
  const { data, error } = await supabase.rpc(
    'record_unconfirmed_booking_repair_batch_v1',
    { p_after_id: null, p_limit: Math.max(1, Math.min(Math.trunc(limit), 100)) }
  );
  if (error) {
    console.error('[db] repairUnconfirmedBookingObservations failed:', error.message);
    return {
      selected: 0,
      inserted: 0,
      hasMore: false,
      nextId: null,
      error: error.message,
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      selected: 0,
      inserted: 0,
      hasMore: false,
      nextId: null,
      error: 'Unconfirmed repair returned an invalid batch.',
    };
  }
  const row = data as Record<string, unknown>;
  return {
    selected: Math.max(0, Number(row.selectedCount) || 0),
    inserted: Math.max(0, Number(row.insertedCount) || 0),
    hasMore: row.hasMore === true,
    nextId: typeof row.nextId === 'string' ? row.nextId : null,
  };
}

/** Customer contact plus the assigned B2B owner, never the staff creator. */
export async function confirmedBookingRecipients(row: BookingRow): Promise<string[]> {
  return (await bookingNotificationRecipients(row)).map(
    (recipient) => recipient.address
  );
}

export type BookingNotificationVisibleRecipient = {
  kind: 'customer_contact' | 'booking_user';
  address: string;
};

/** Freezes the visible envelope recipients when an outbox is first expanded. */
export async function bookingNotificationRecipients(
  row: BookingRow
): Promise<BookingNotificationVisibleRecipient[]> {
  if (row.audience === 'agency' && row.hidden_from_user) return [];
  const recipients = new Map<string, BookingNotificationVisibleRecipient>();
  const snapshot = row.passengers as { contact?: { customerEmail?: unknown } } | null;
  const customerEmail = snapshot?.contact?.customerEmail;
  if (typeof customerEmail === 'string' && customerEmail.trim()) {
    const address = customerEmail.trim().toLowerCase();
    recipients.set(address, { kind: 'customer_contact', address });
  }
  if (row.audience === 'agency' && row.user_id) {
    const supabase = supabaseAdmin();
    const { data, error } = supabase
      ? await supabase.from('app_users').select('email')
          .eq('clerk_id', row.user_id).maybeSingle()
      : { data: null, error: null };
    if (error) console.error('[db] confirmedBookingRecipients failed:', error.message);
    const email = (data as { email?: unknown } | null)?.email;
    if (typeof email === 'string' && email.trim()) {
      const address = email.trim().toLowerCase();
      if (!recipients.has(address)) {
        recipients.set(address, { kind: 'booking_user', address });
      }
    }
  }
  return Array.from(recipients.values());
}

/**
 * Who a bookings list is allowed to see.
 *
 * Built from the session by the caller rather than inferred here, so the one
 * place that decides is the page, and this stays a query.
 */
export type BookingScope =
  | { kind: 'all' }
  | { kind: 'agency'; agencyCode: string }
  | { kind: 'user'; clerkId: string };

function agencyGrossFares(
  fares: FareBreakdown[],
  sellingPrice: number,
  grossPrice: number
): FareBreakdown[] {
  const deltaMinor = Math.round((grossPrice - sellingPrice) * 100);
  if (deltaMinor === 0 || fares.length === 0) return fares;
  const weights = fares.map((fare) => Math.max(0, Math.round(fare.basePrice * 100)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let allocated = 0;
  return fares.map((fare, index) => {
    const share = index === fares.length - 1
      ? deltaMinor - allocated
      : weightTotal > 0
        ? Math.round((deltaMinor * weights[index]) / weightTotal)
        : Math.round(deltaMinor / fares.length);
    allocated += share;
    return {
      ...fare,
      basePrice: Math.round(fare.basePrice * 100 + share) / 100,
      totalPrice: Math.round(fare.totalPrice * 100 + share) / 100,
    };
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * A booking as a client may see it — the seven business statuses only.
 *
 * Nothing on this object names an operational state, and the internal UUID is
 * carried only so the application can address the row; `publicRef` is what a
 * customer and an agent both quote.
 */
export function publicBooking(row: BookingRow): PublicBooking {
  const airlinesPnr = validAirlinePnrs(row.airlines_pnr);
  const status = resolvePublicBookingStatus({
    lifecycleStatus: row.lifecycle_status,
    status: row.status,
    airlinesPnr,
    ticketingDeadlineAt: row.ticketing_deadline_at,
  });
  const sellingPrice = Number(row.pricing_snapshot.sellingPrice);
  const storedGross = Number(row.pricing_snapshot.grossPrice);
  const importedGrossMinor = Number(row.supplier_gross_amount);
  const importedGross =
    row.supplier_gross_amount !== null &&
    Number.isFinite(importedGrossMinor) &&
    importedGrossMinor >= 0
      ? importedGrossMinor / 100
      : storedGross;
  const showsImportedSupplierGross =
    (row.import_source === 'IMP_EXP' || row.import_source === 'MANUAL') &&
    Number.isFinite(importedGross) &&
    importedGross >= 0;
  const showsAgencyGross =
    row.import_source !== 'IMP_EXP' && row.import_source !== 'MANUAL' &&
    row.audience === 'agency' && Number.isFinite(storedGross) && storedGross > 0;
  const itinerary = row.itinerary;
  const passportRequired = itinerary && itinerary.legs.length > 0
    ? passportRequiredForItinerary(itinerary)
    : row.passport_required !== false;
  const storedFares = Array.isArray(row.fares)
    ? (row.fares as FareBreakdown[])
    : [];
  return {
    bookingId: row.id,
    publicRef: row.public_ref,
    status,
    statusMessage: customerStatusMessage({
      status,
      importSource: row.import_source,
      paymentState: row.payment_state,
      operationKind: row.operation_kind,
      operationReason: row.operation_reason,
    }),
    paymentState: row.payment_state,
    headerContact: B2C_HEADER_CONTACT,
    currency: row.currency,
    totalPrice: showsImportedSupplierGross
      ? importedGross
      : showsAgencyGross
        ? storedGross
        : sellingPrice,
    serviceMargin: Number(row.pricing_snapshot.serviceMarginAmount),
    passengerCounts: row.passenger_counts,
    travelDate: row.travel_date,
    directTicketing: row.direct_ticketing,
    // Route data repairs older imported/manual rows with a stale document flag.
    // Rows with no usable route retain the stored fail-closed value.
    passportRequired,
    itinerary: row.itinerary ?? null,
    // Imported supplier fares are the airline-authored e-ticket face values.
    // User Payable remains the wallet/payment amount and must not replace them.
    fares: showsAgencyGross
      ? agencyGrossFares(storedFares, sellingPrice, storedGross)
      : storedFares,
    repricedAt: row.repriced_at,
    pnr: row.pnr,
    // Safe to publish, unlike `supplier_refs`: a record locator is what the
    // traveller is meant to quote to the airline, not a capability over the
    // booking. The opaque transaction tokens stay in `supplier_refs`.
    airlinesPnr,
    bookingRefNumber: row.booking_ref_number,
    bookingStatus: row.booking_status,
    ticketingTimeLimit: row.ticketing_time_limit,
    ticketingDeadlineAt: row.ticketing_deadline_at,
    ticketNumbers: stringArray(row.ticket_numbers),
    warnings: stringArray(row.warnings),
    // The customer booked when the irreversible supplier call began, not when
    // our business row was inserted after the supplier eventually answered.
    bookedAt: row.submission_started_at ?? row.created_at,
    processingSince:
      status === 'in-progress' ? row.operation_started_at : null,
    issuedAt: row.issued_at,
    cancelledAt: row.cancelled_at,
  };
}

/** Adds the owning B2B partner's saved business identity to a ticket. */
export async function publicBookingWithHeaderContact(
  row: BookingRow
): Promise<PublicBooking> {
  const booking = publicBooking(row);
  if (row.audience !== 'agency' || !row.agency_code) {
    const logo = await getSiteLogo();
    return {
      ...booking,
      headerContact: { ...booking.headerContact, logoUrl: logo?.url ?? null },
    };
  }

  const supabase = supabaseAdmin();
  if (!supabase) return booking;
  const { data: agency, error: agencyError } = await supabase
    .from('agencies')
    .select('owner_user_id')
    .eq('agency_code', row.agency_code)
    .maybeSingle();
  if (agencyError || !agency?.owner_user_id) return booking;

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('agency_name, agency_license_no, agency_mobile, agency_email, agency_address, documents')
    .eq('clerk_id', agency.owner_user_id)
    .maybeSingle();
  if (profileError || !profile) return booking;

  const logo = coerceDocumentMap(profile.documents, ['logo']).logo;
  const logoUrl = logo ? authenticatedImageUrl(logo.publicId, logo.format) : null;

  return {
    ...booking,
    headerContact: {
      name: profile.agency_name?.trim() || row.agency_code,
      licenseNo: profile.agency_license_no?.trim() || B2C_HEADER_CONTACT.licenseNo,
      mobile: profile.agency_mobile?.trim() || '--',
      email: profile.agency_email?.trim() || '--',
      address: profile.agency_address?.trim() || '--',
      logoUrl: logoUrl ?? null,
    },
  };
}

/** The supplier's answer, as the transaction expects it. */
export type SupplierBookingResult = {
  status: 'held' | 'ticketed';
  pnr: string;
  airlinesPnr: string[];
  bookingRefNumber: string | null;
  bookingStatus: string | null;
  ticketingTimeLimit: string | null;
  bookingCodeRef: string;
  ticketCodeRef: string | null;
  ticketNumbers: string[];
  warnings: string[];
  message: string | null;
};

/**
 * Turns a confirmed supplier booking into a business record, atomically.
 *
 * One call, one transaction: the reference is allocated, the booking inserted
 * and the attempt resolved together, so there is no window in which a booking
 * exists while its attempt still reads `submitting`. The attempt is locked and
 * required to be in flight, which is also the replay guard — a second call for
 * the same attempt raises rather than creating a duplicate booking.
 */
export async function createBookingFromAttempt(
  attemptId: string,
  outcome: SupplierBookingResult,
  operationRequest: OperationRequestIdentity
): Promise<BookingRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc('create_booking_from_attempt_v2', {
    p_attempt_id: attemptId,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_outcome: outcome,
  });
  if (error) {
    console.error('[db] create_booking_from_attempt_v2 failed:', error.message);
    // The transaction may have committed even when its HTTP response was
    // lost. Recover the idempotent result by the attempt's unique booking.
    const { data: recovered, error: recoveryError } = await supabase
      .from(LIFECYCLE_VIEW)
      .select('*')
      .eq('attempt_id', attemptId)
      .maybeSingle();
    if (recoveryError) {
      console.error(
        '[db] create_booking_from_attempt_v2 recovery failed:',
        recoveryError.message
      );
    }
    return (recovered as BookingRow | null) ?? null;
  }
  // A set-returning signature hands back either the row or a one-row array
  // depending on how PostgREST resolved it.
  const row = Array.isArray(data) ? data[0] : data;
  return (row as BookingRow | undefined) ?? null;
}

/** Finds the business booking produced by an operational attempt. */
export async function readBookingByAttemptId(
  attemptId: string,
  scope?: BookingScope,
  throwOnReadError = false
): Promise<BookingRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }
  const visibilityAvailable = scope?.kind !== 'all'
    ? await bookingUserVisibilitySchemaAvailable()
    : false;

  let query = supabase
    .from(LIFECYCLE_VIEW)
    .select('*')
    .eq('attempt_id', attemptId);

  if (scope?.kind === 'agency') query = query.eq('agency_code', scope.agencyCode);
  if (scope?.kind === 'user') query = query.eq('user_id', scope.clerkId);
  if (scope && scope.kind !== 'all' && visibilityAvailable) {
    query = query.eq('hidden_from_user', false);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('[db] readBookingByAttemptId failed:', error.message);
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }
  return (data as BookingRow | null) ?? null;
}

/** Service-side lookup used by the lifecycle email dispatcher. */
export async function readBookingById(bookingId: string): Promise<BookingRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(LIFECYCLE_VIEW)
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) {
    console.error('[db] readBookingById failed:', error.message);
    return null;
  }
  return (data as BookingRow | null) ?? null;
}


const DASHBOARD_LIST_BASE_COLUMNS = [
  'id',
  'public_ref',
  'user_id',
  'agency_code',
  'status',
  'lifecycle_status',
  'operation_kind',
  'operation_reason',
  'operation_started_at',
  'created_at',
  'issued_at',
  'cancelled_at',
  'ticketing_deadline_at',
  'last_lifecycle_event_at',
  'supplier_reference',
  'airline_pnr',
  'pnr',
  'lead_name',
  'traveller_count',
  'passenger_counts',
  'fare',
  'gross',
  'route',
  'airline',
  'fly_date',
  'supplier_payable',
  'booking_user_email',
  'creator_name',
  'creator_role',
  'creator_email',
  'creator_agency_code',
  'creator_agency_name',
  'booking_agency_code',
  'booking_agency_name',
  'import_source',
  'payment_state',
];

const DASHBOARD_LIST_SELECT_LEGACY = DASHBOARD_LIST_BASE_COLUMNS.join(',');
const DASHBOARD_LIST_SELECT = [
  ...DASHBOARD_LIST_BASE_COLUMNS,
  'hidden_from_user',
  'hidden_at',
].join(',');

const DASHBOARD_LIST_SORT_COLUMNS: Record<BookingListSortKey, string> = {
  createDate: 'created_at',
  status: 'status_order',
  name: 'sort_name',
  flyDate: 'fly_date',
  airline: 'airline',
  fare: 'fare',
  gross: 'gross',
  lifecycleAt: 'lifecycle_at',
  passengerType: 'passenger_type',
  supplierPayable: 'supplier_payable',
  profit: 'profit',
  route: 'route',
  createdBy: 'creator_name',
  referenceNo: 'public_ref',
};

function escapedLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function reportDashboardListTiming(input: {
  durationMs: number;
  pageSize: number;
  returned: number;
  total: number;
}): void {
  if (process.env.BOOKING_TIMING !== '1') return;
  console.info('[timing] booking-dashboard-query', input);
}

/**
 * One page of the dashboard list, including an exact total. The underlying
 * view folds creator email and the latest lifecycle event into this one read.
 */
export async function listBookingDashboardPage(
  scope: BookingScope,
  filters: BookingListQuery
): Promise<BookingDashboardListPage> {
  const unavailable = { rows: [], total: 0, loadError: true };
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable;
  const startedAt = performance.now();
  const visibilityAvailable = await bookingUserVisibilitySchemaAvailable();

  const sortColumn = filters.sortKey
    ? DASHBOARD_LIST_SORT_COLUMNS[filters.sortKey]
    : 'created_at';
  const pageStart = (filters.page - 1) * filters.pageSize;
  let query = supabase
    .from(DASHBOARD_LIST_VIEW)
    .select(
      visibilityAvailable ? DASHBOARD_LIST_SELECT : DASHBOARD_LIST_SELECT_LEGACY,
      { count: 'exact' }
    )
    .order(sortColumn, {
      ascending: filters.sortKey ? filters.sortDirection === 'asc' : false,
      nullsFirst: false,
    });

  if (scope.kind === 'agency') query = query.eq('agency_code', scope.agencyCode);
  if (scope.kind === 'user') query = query.eq('user_id', scope.clerkId);
  if (scope.kind !== 'all' && visibilityAvailable) {
    query = query.eq('hidden_from_user', false);
  }
  if (filters.status !== 'all') {
    query = query.eq('lifecycle_status', filters.status);
  }
  if (filters.search) {
    const pattern = escapedLike(filters.search);
    query = query.or(`search_text.ilike.${pattern},creator_search_text.ilike.${pattern}`);
  }
  if (filters.createdBy) {
    query = query.ilike('creator_search_text', escapedLike(filters.createdBy));
  }
  if (filters.createdFrom) {
    query = query.gte('created_at', `${filters.createdFrom}T00:00:00+06:00`);
  }
  if (filters.createdTo) {
    query = query.lte('created_at', `${filters.createdTo}T23:59:59.999+06:00`);
  }
  if (filters.flyFrom) query = query.gte('fly_date', filters.flyFrom);
  if (filters.flyTo) query = query.lte('fly_date', `${filters.flyTo}T23:59:59.999`);
  if (filters.amountMin) query = query.gte('fare', Number(filters.amountMin));
  if (filters.amountMax) query = query.lte('fare', Number(filters.amountMax));
  query = query.range(pageStart, pageStart + filters.pageSize - 1);

  const { data, error, count } = await query;
  if (error) {
    console.error('[db] listBookingDashboardPage failed:', error.message);
    reportDashboardListTiming({
      durationMs: Math.round(performance.now() - startedAt),
      pageSize: filters.pageSize,
      returned: 0,
      total: 0,
    });
    return unavailable;
  }
  const rawRows = (data ?? []) as unknown as Record<string, unknown>[];
  const rows = rawRows.map((row) => ({
    ...row,
    hidden_from_user:
      visibilityAvailable && row.hidden_from_user === true,
    hidden_at:
      visibilityAvailable && typeof row.hidden_at === 'string'
        ? row.hidden_at
        : null,
  })) as unknown as BookingDashboardListDbRow[];
  const page = {
    rows,
    total: count ?? 0,
    loadError: false,
  };
  reportDashboardListTiming({
    durationMs: Math.round(performance.now() - startedAt),
    pageSize: filters.pageSize,
    returned: page.rows.length,
    total: page.total,
  });
  return page;
}

/**
 * Every booking the given scope may see, newest first, with the email of
 * whoever made each one.
 *
 * This legacy full-row helper remains for compact dashboard widgets and
 * server-only workflows. The bookings page itself uses
 * `listBookingDashboardPage()` above.
 */
export async function listBookings(
  scope: BookingScope,
  limit = 500
): Promise<{ rows: BookingRow[]; emails: Record<string, string> }> {
  const empty = { rows: [], emails: {} };
  const supabase = supabaseAdmin();
  if (!supabase) return empty;
  const visibilityAvailable = scope.kind !== 'all'
    ? await bookingUserVisibilitySchemaAvailable()
    : false;

  let query = supabase
    .from(LIFECYCLE_VIEW)
    .select('*')
    // The lifecycle view excludes retained operational history.
    .order('created_at', { ascending: false })
    .limit(limit);

  if (scope.kind === 'agency') query = query.eq('agency_code', scope.agencyCode);
  if (scope.kind === 'user') query = query.eq('user_id', scope.clerkId);
  if (scope.kind !== 'all' && visibilityAvailable) {
    query = query.eq('hidden_from_user', false);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[db] listBookings failed:', error.message);
    return empty;
  }

  const rows = (data ?? []) as BookingRow[];
  const bookingIds = rows.map((row) => row.id);
  if (bookingIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from('booking_status_events')
      .select('booking_id, created_at')
      .in('booking_id', bookingIds)
      .order('created_at', { ascending: false });
    if (eventsError) {
      console.error('[db] listBookings status event lookup failed:', eventsError.message);
    } else {
      const latestEventAt: Record<string, string> = {};
      for (const event of (events ?? []) as {
        booking_id: string;
        created_at: string;
      }[]) {
        latestEventAt[event.booking_id] ??= event.created_at;
      }
      for (const row of rows) {
        row.last_lifecycle_event_at = latestEventAt[row.id] ?? null;
      }
    }
  }

  const userIds = Array.from(
    new Set(rows.map((row) => row.user_id).filter((id): id is string => !!id))
  );
  if (userIds.length === 0) return { rows, emails: {} };

  const { data: users, error: usersError } = await supabase
    .from('app_users')
    .select('clerk_id, email')
    .in('clerk_id', userIds);
  if (usersError) {
    // A missing email costs a dash in one column; it is not worth failing the
    // whole list over.
    console.error('[db] listBookings email lookup failed:', usersError.message);
    return { rows, emails: {} };
  }

  const emails: Record<string, string> = {};
  for (const user of (users ?? []) as { clerk_id: string; email: string }[]) {
    emails[user.clerk_id] = user.email;
  }
  return { rows, emails };
}

/** Resolve historical links without bypassing the caller's booking scope. */
async function canonicalBookingReference(publicRef: string, throwOnReadError = false): Promise<string> {
  if (!publicRef.startsWith('STR')) return publicRef;
  const supabase = supabaseAdmin();
  if (!supabase) return publicRef;
  const { data, error } = await supabase.from('booking_reference_aliases')
    .select('booking_id').eq('alias', publicRef).maybeSingle();
  if (error && throwOnReadError) throw new BookingReadUnavailableError();
  if (!data) return publicRef;
  const { data: booking, error: bookingError } = await supabase.from('flight_bookings')
    .select('public_ref').eq('id', data.booking_id).maybeSingle();
  if (bookingError && throwOnReadError) throw new BookingReadUnavailableError();
  return booking?.public_ref || publicRef;
}

/** One business booking, constrained by the same scope as the dashboard list. */
export async function readBookingByPublicRef(
  publicRef: string,
  scope: BookingScope,
  throwOnReadError = false
): Promise<BookingRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }
  const visibilityAvailable = scope.kind !== 'all'
    ? await bookingUserVisibilitySchemaAvailable()
    : false;

  let query = supabase
    .from(LIFECYCLE_VIEW)
    .select('*')
    .eq('public_ref', await canonicalBookingReference(publicRef, throwOnReadError))
    .limit(1);

  if (scope.kind === 'agency') query = query.eq('agency_code', scope.agencyCode);
  if (scope.kind === 'user') query = query.eq('user_id', scope.clerkId);
  if (scope.kind !== 'all' && visibilityAvailable) {
    query = query.eq('hidden_from_user', false);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('[db] readBookingByPublicRef failed:', error.message);
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }
  return (data as BookingRow | null) ?? null;
}

/**
 * Super Admin-only call site helper for retained pre-lifecycle history.
 *
 * It intentionally does not change `legacy_operational`: normal lifecycle
 * lists, schedulers, and supplier workers continue excluding these rows. The
 * caller must enforce the Super Admin role before using this raw-table read.
 */
export async function readBookingByPublicRefForSuperAdmin(
  publicRef: string,
  throwOnReadError = false
): Promise<BookingRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }

  const { data, error } = await supabase
    .from('flight_bookings')
    .select('*')
    .eq('public_ref', await canonicalBookingReference(publicRef, throwOnReadError))
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] Super Admin booking read failed:', error.message);
    if (throwOnReadError) throw new BookingReadUnavailableError();
    return null;
  }
  if (!data) return null;
  const rawRow = data as unknown as BookingRow & {
    status: string;
    operation_prior_status: string | null;
  };
  const normalizeRetainedStatus = (status: string): StoredBookingStatus => {
    switch (status) {
      case 'ticketed':
      case 'confirmed':
        return 'confirmed';
      case 'failed':
      case 'cancelled':
        return 'cancelled';
      case 'draft':
      case 'pending':
        return 'pending';
      case 'submitting':
      case 'unknown':
      case 'in-progress':
        return 'in-progress';
      case 'held':
      case 'on-hold':
      default:
        return 'on-hold';
    }
  };
  const row: BookingRow = {
    ...rawRow,
    status: normalizeRetainedStatus(rawRow.status),
    operation_prior_status: rawRow.operation_prior_status
      ? normalizeRetainedStatus(rawRow.operation_prior_status)
      : null,
  };
  row.lifecycle_status = row.operation_kind
    ? 'in-progress'
    : resolvePublicBookingStatus({
        status: row.status,
        airlinesPnr: stringArray(row.airlines_pnr),
        ticketingDeadlineAt: row.ticketing_deadline_at,
      });
  return row;
}

/** Persists a super-admin reconciliation read without changing wallet money. */
export async function syncAirTicketingDetails(
  bookingId: string,
  details: AirTicketingDetails,
  session: Pick<DashboardSession, 'clerkId' | 'role'>,
  syncSource: 'ordinary_sync' | 'cancellation_verification'
): Promise<BookingRow> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking storage is unavailable.');

  // The database enriches matching terminal records but opens reconciliation
  // instead of letting refresh silently cross a protected state boundary.
  const { data, error } = await supabase.rpc('record_booking_supplier_refresh_v3', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_sync_source: syncSource,
    p_supplier_status: details.supplierStatus,
    p_airlines_pnr: details.airlinesPnr,
    p_ticket_numbers: details.ticketNumbers,
    p_issued_at: details.issuedAt,
    p_cancelled_at: details.cancelledAt,
    p_normalized_evidence: details.evidence,
  });
  if (error) {
    console.error('[db] syncAirTicketingDetails failed:', error.message);
    throw new Error('The refreshed ticket details could not be saved.');
  }
  const refreshed = data as BookingRow;
  const itinerary = mergeSupplierTerminals(refreshed.itinerary, details.segments);
  if (itinerary === refreshed.itinerary) return refreshed;

  // Terminal data is a display-only enrichment from the supplier's ticket
  // report. Keep it with the booked itinerary so ticket pages and printouts do
  // not need an additional supplier request on every view.
  const { error: itineraryError } = await supabase
    .from('flight_bookings')
    .update({ itinerary })
    .eq('id', bookingId);
  if (itineraryError) {
    // The authoritative status/ticket sync already succeeded. Do not turn a
    // non-financial display enrichment into a failed booking refresh.
    console.error('[db] terminal itinerary enrichment failed:', itineraryError.message);
    return refreshed;
  }

  return { ...refreshed, itinerary };
}

/** Persists a live PNR read while preserving internal wallet workflow states. */
export async function syncPnrDetails(
  bookingId: string,
  details: PnrLookupOutcome,
  session: Pick<DashboardSession, 'clerkId'> & {
    role: DashboardSession['role'] | 'system';
  },
  syncSource: 'ordinary_sync' | 'cancellation_verification'
): Promise<BookingRow> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking storage is unavailable.');

  // Production PNR reads return airline locators separately; the Book/primary
  // PNR remains untouched because supplier write calls still require it.
  const { data, error } = await supabase.rpc('record_booking_pnr_refresh_v3', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_sync_source: syncSource,
    p_supplier_status: details.status,
    p_airlines_pnr: details.airlinesPnr,
    p_ticketing_time_limit: details.rawLastTicketTime ?? details.lastTicketTime,
    p_ticketing_deadline_at: details.ticketingDeadlineAt,
    p_normalized_evidence: details.evidence,
  });
  if (error) {
    console.error('[db] syncPnrDetails failed:', error.message);
    throw new Error('The refreshed PNR details could not be saved.');
  }
  return data as BookingRow;
}

/** Atomically claims a held booking before the non-retryable supplier cancel. */
export async function beginBookingCancellation(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity
): Promise<{
  ok: boolean;
  code?: string;
  replay?: boolean;
  operationId?: string;
  operationState?: string;
  operationResult?: Record<string, unknown>;
}> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_ERROR' };
  const { data, error } = await supabase.rpc('begin_booking_cancellation_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
  });
  if (error) console.error('[db] beginBookingCancellation failed:', error.message);
  return error
    ? { ok: false, code: 'STORAGE_ERROR' }
    : (data as {
        ok: boolean;
        code?: string;
        replay?: boolean;
        operationId?: string;
        operationState?: string;
        operationResult?: Record<string, unknown>;
      });
}

/** Restores a cancellation claim only after a fresh PNR read proved a live hold. */
export async function restoreBookingCancellation(
  bookingId: string,
  actorUserId: string,
  operationRequest: OperationRequestIdentity,
  operationId: string,
  evidence: Record<string, unknown>
): Promise<{ ok: boolean; code?: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_ERROR' };
  const args = {
    p_booking_id: bookingId,
    p_actor_user_id: actorUserId,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_operation_id: operationId,
    p_evidence: evidence,
  };
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase.rpc(
      'resolve_booking_cancellation_refusal_v2',
      args
    );
    if (!error) return data as { ok: boolean; code?: string };
    lastError = error.message;
  }
  console.error('[db] restoreBookingCancellation failed:', lastError);
  return { ok: false, code: 'STORAGE_ERROR' };
}
