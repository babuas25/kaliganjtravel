import 'server-only';

import { createHash, randomBytes, randomUUID } from 'crypto';

import type {
  BookedItinerary,
  BookingDraftPricing,
  BookingPassengerType,
  PublicBookingAttempt,
} from '@/lib/flights/booking';
import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import type { FareBreakdown } from '@/lib/flights/types';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * The operational record of a fare selection on its way to a supplier.
 *
 * Separate from `flight_bookings` on purpose: `draft` and `submitting` are
 * processing states, not things a customer holds, and the business table should
 * contain nothing but real bookings. See BOOKING_ARCHITECTURE.md.
 *
 * This is the authoritative operational source. Prepare and claim failures are
 * returned to their callers, and resolution failures throw: once an attempt is
 * sent to the supplier, silently losing its final state would corrupt the
 * recovery trail.
 */

const TABLE = 'booking_attempts';
const RETENTION_INTERVAL_MS = 60 * 60_000;
let lastRetentionAt = 0;

/** Opportunistic hourly enforcement; every active deployment eventually runs it. */
async function enforceRetention(
  supabase: NonNullable<ReturnType<typeof supabaseAdmin>>
): Promise<void> {
  const now = Date.now();
  if (now - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  lastRetentionAt = now;
  const { error } = await supabase.rpc('enforce_security_retention');
  if (error) {
    lastRetentionAt = 0;
    console.error('[security] booking-attempt retention failed:', error.message);
  }
}

/** One supplier today. The column exists so adding a second is not a redesign. */
const SUPPLIER = 'triplover';

export type AttemptState =
  | 'draft'
  | 'submitting'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/** Which write failed, in the language of the booking flow. */
export type AttemptWriteStage = 'prepare' | 'submit' | 'resolve';

const DRAFT_TTL_MS = 15 * 60_000;

/** The row as stored. Never leaves the server. */
export type BookingAttemptRow = {
  id: string;
  access_token_hash: string;
  user_id: string | null;
  created_by_user_id: string | null;
  staff_on_behalf: boolean;
  audience: 'b2c' | 'agency' | 'superadmin';
  agency_code: string | null;
  supplier: string;
  /** Credential account fixed by the source search; null only on old rows. */
  supplier_account: TriploverSupplier | null;
  state: AttemptState;
  search_id: string;
  itinerary_id: string;
  unique_trans_id: string;
  item_code_ref: string;
  price_code_ref: string;
  booking_code_ref: string | null;
  pnr: string | null;
  offer_snapshot: OfferSnapshot;
  passenger_snapshot: unknown;
  error_code: string | null;
  supplier_message: string | null;
  warnings: unknown;
  expires_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
  operation_request_key: string | null;
  operation_request_payload_hash: string | null;
  supplier_operation: string | null;
  supplier_call_started_at: string | null;
  supplier_response_received_at: string | null;
  supplier_response_http_status: number | null;
  created_at: string;
  updated_at: string;
};

/** What the checkout needs to render, frozen at fare selection. */
export type OfferSnapshot = {
  itinerary: BookedItinerary | null;
  fares: FareBreakdown[];
  currency: string;
  pricing: BookingDraftPricing;
  passengerCounts: Partial<Record<BookingPassengerType, number>>;
  travelDate: string;
  directTicketing: boolean;
  passportRequired: boolean;
  repricedAt: string;
};

export type NewBookingAttempt = {
  userId: string | null;
  createdByUserId: string;
  staffOnBehalf: boolean;
  audience: 'b2c' | 'agency' | 'superadmin';
  agencyCode: string | null;
  supplierAccount: TriploverSupplier;
  searchId: string;
  itineraryId: string;
  supplierRefs: {
    uniqueTransId: string;
    itemCodeRef: string;
    priceCodeRef: string;
  };
  /** Everything needed to render or investigate this attempt on its own. */
  offerSnapshot: OfferSnapshot;
  /** The search quote's own expiry; the attempt never outlives it. */
  sourceExpiresAt: number;
};

export type AttemptOutcome = {
  state: 'succeeded' | 'failed' | 'unknown';
  pnr?: string | null;
  bookingCodeRef?: string | null;
  errorCode?: string | null;
  supplierMessage?: string | null;
  warnings?: string[];
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * One line of JSON per failed mirror write.
 *
 * These rows are the recovery trail for an irreversible call, so when one fails
 * to be written the log has to carry enough to find the attempt, the customer
 * and the supplier's own record without opening a database console — an
 * unstructured message would not survive being grepped out of a serverless log
 * an hour later.
 */
function logAttemptWriteFailure(
  stage: AttemptWriteStage,
  context: {
    attemptId: string;
    userId: string | null;
    bookingCodeRef?: string | null;
  },
  error: unknown
): void {
  console.error(
    JSON.stringify({
      event: 'booking_attempt_write_failed',
      stage,
      attempt_id: context.attemptId,
      user_id: context.userId,
      supplier: SUPPLIER,
      booking_code_ref: context.bookingCodeRef ?? null,
      error:
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error),
      timestamp: new Date().toISOString(),
    })
  );
}

/** The attempt as the checkout sees it — no operational state included. */
export async function publicBookingAttempt(
  row: BookingAttemptRow
): Promise<PublicBookingAttempt> {
  const offer = row.offer_snapshot;
  const controls = await getSupplierOperationalControls();
  return {
    attemptId: row.id,
    currency: offer.currency,
    totalPrice: Number(offer.pricing.sellingPrice),
    serviceMargin: Number(offer.pricing.serviceMarginAmount),
    passengerCounts: offer.passengerCounts,
    travelDate: offer.travelDate,
    directTicketing: offer.directTicketing,
    passportRequired: offer.passportRequired !== false,
    itinerary: offer.itinerary ?? null,
    fares: Array.isArray(offer.fares) ? offer.fares : [],
    repricedAt: offer.repricedAt,
    expiresAt: row.expires_at,
    submissionEnabled: controls.bookingEnabled,
    ticketingEnabled: controls.ticketingEnabled,
  };
}

/**
 * Opens an attempt for a selected fare.
 *
 * One insert, so it is atomic without a transaction — which is what the
 * dual-write of step 1 was working around. The access token is minted here and
 * returned once; only its hash is stored.
 */
export async function createBookingAttempt(
  input: NewBookingAttempt
): Promise<{ attempt: PublicBookingAttempt; accessToken: string } | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;

  const id = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  // Never outlives the search quote it was priced from.
  const expiresAt = new Date(
    Math.min(input.sourceExpiresAt, Date.now() + DRAFT_TTL_MS)
  ).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      access_token_hash: tokenHash(accessToken),
      user_id: input.userId,
      created_by_user_id: input.createdByUserId,
      staff_on_behalf: input.staffOnBehalf,
      audience: input.audience,
      agency_code: input.agencyCode,
      supplier: SUPPLIER,
      supplier_account: input.supplierAccount,
      state: 'draft',
      search_id: input.searchId,
      itinerary_id: input.itineraryId,
      unique_trans_id: input.supplierRefs.uniqueTransId,
      item_code_ref: input.supplierRefs.itemCodeRef,
      price_code_ref: input.supplierRefs.priceCodeRef,
      offer_snapshot: input.offerSnapshot,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error) {
    logAttemptWriteFailure(
      'prepare',
      { attemptId: id, userId: input.userId },
      error
    );
    return null;
  }
  await enforceRetention(supabase);
  return {
    attempt: await publicBookingAttempt(data as BookingAttemptRow),
    accessToken,
  };
}

/** Reads an attempt for the checkout. The token is the capability. */
export async function readBookingAttempt(
  attemptId: string,
  accessToken: string
): Promise<BookingAttemptRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', attemptId)
    .eq('access_token_hash', tokenHash(accessToken))
    .maybeSingle();
  if (error) {
    console.error('[db] readBookingAttempt failed:', error.message);
    return null;
  }
  return (data as BookingAttemptRow | null) ?? null;
}

/**
 * `conflict` — already claimed, or expired. `storage` — the database could not
 * be reached. Nothing reached the supplier in either case, but only one of them
 * is worth retrying.
 */
export type ClaimResult =
  | { ok: true; row: BookingAttemptRow }
  | { ok: false; reason: 'conflict' | 'storage' };

/**
 * Takes the lock and records the passengers, in one conditional update.
 *
 * This is the double-submit guard, moved verbatim from the old draft flow: the
 * same `state = 'draft'` and unexpired predicates decide the winner, so two
 * concurrent confirms still produce exactly one supplier call. Nothing about
 * the semantics changed — only which table they run against.
 */
export async function claimBookingAttempt(
  attemptId: string,
  accessToken: string,
  passengers: unknown,
  operationRequest: OperationRequestIdentity
): Promise<ClaimResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, reason: 'storage' };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      state: 'submitting',
      passenger_snapshot: passengers,
      submitted_at: now,
      error_code: null,
      operation_request_key: operationRequest.requestKey,
      operation_request_payload_hash: operationRequest.requestPayloadHash,
      supplier_operation: 'Book',
    })
    .eq('id', attemptId)
    .eq('access_token_hash', tokenHash(accessToken))
    .eq('state', 'draft')
    .gt('expires_at', now)
    .select('*')
    .maybeSingle();
  if (error) {
    logAttemptWriteFailure('submit', { attemptId, userId: null }, error);
    return { ok: false, reason: 'storage' };
  }
  return data
    ? { ok: true, row: data as BookingAttemptRow }
    : { ok: false, reason: 'conflict' };
}

/**
 * Returns a claimed attempt to draft only when no supplier call was made.
 * Used when the direct-ticket wallet reservation is refused after the existing
 * optimistic claim has already won. The state predicate prevents a late caller
 * from reopening an attempt that another path resolved.
 */
export async function restoreClaimedBookingAttempt(
  attemptId: string,
  userId: string
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      state: 'draft',
      submitted_at: null,
      passenger_snapshot: null,
      error_code: null,
      operation_request_key: null,
      operation_request_payload_hash: null,
      supplier_operation: null,
      supplier_call_started_at: null,
      supplier_response_received_at: null,
      supplier_response_http_status: null,
    })
    .eq('id', attemptId)
    .eq('user_id', userId)
    .eq('state', 'submitting')
    .select('id')
    .maybeSingle();
  if (error) {
    logAttemptWriteFailure('submit', { attemptId, userId }, error);
    return false;
  }
  return Boolean(data);
}

/**
 * Closes a failed or unknown attempt out.
 *
 * Success is resolved only by `create_booking_from_attempt`, in the same
 * transaction that creates the business record. A storage error here is fatal
 * to the operation and must reach the caller rather than being reduced to a
 * log line.
 */
export async function resolveBookingAttempt(
  attemptId: string,
  userId: string | null,
  outcome: AttemptOutcome
): Promise<void> {
  const context = {
    attemptId,
    userId,
    bookingCodeRef: outcome.bookingCodeRef ?? null,
  };
  const supabase = supabaseAdmin();
  if (!supabase) {
    const error = new Error('Supabase client unavailable');
    logAttemptWriteFailure('resolve', context, error);
    throw error;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      state: outcome.state,
      pnr: outcome.pnr ?? null,
      booking_code_ref: outcome.bookingCodeRef ?? null,
      error_code: outcome.errorCode ?? null,
      supplier_message: outcome.supplierMessage ?? null,
      warnings: outcome.warnings ?? [],
      resolved_at: new Date().toISOString(),
    })
    .eq('id', attemptId)
    .eq('state', 'submitting')
    .select('id')
    .maybeSingle();
  if (error) {
    logAttemptWriteFailure('resolve', context, error);
    throw new Error(`Could not resolve booking attempt: ${error.message}`);
  }
  if (!data) {
    const stateError = new Error(
      'Booking attempt is no longer awaiting an outcome'
    );
    logAttemptWriteFailure('resolve', context, stateError);
    throw stateError;
  }
}
