import 'server-only';

import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import type { DashboardSession } from '@/lib/dashboard/session';
import type { ShaponSavedCancellation, ShapontravelsCancellationInput } from '@/lib/shapontravels/cancel';
import { supabaseAdmin } from '@/lib/supabase/server';

/** A saved result is read-only; current status cannot authorize a second write. */
export async function readBookingCancellationReplay(
  bookingId: string,
  session: DashboardSession,
  request: OperationRequestIdentity
): Promise<{ operationId: string; state: string; result: unknown; errorCode: string | null; callStarted: boolean; retryAvailable: boolean } | null> {
  const db = supabaseAdmin();
  if (!db) throw new Error('Booking operation storage is unavailable.');
  const { data, error } = await db.from('booking_operations')
    .select('id,booking_id,kind,actor_user_id,actor_role,request_payload_hash,state,supplier_evidence,error_code,supplier_call_started_at')
    .eq('request_key', request.requestKey)
    .maybeSingle();
  if (error) throw new Error('Booking operation storage is unavailable.');
  if (!data) return null;
  if (data.booking_id !== bookingId || data.kind !== 'cancellation' ||
      data.actor_user_id !== session.clerkId || data.actor_role !== session.role ||
      data.request_payload_hash !== request.requestPayloadHash) {
    throw new Error('Cancellation request identity does not match its saved operation.');
  }
  return {
    operationId: data.id, state: data.state, result: data.supplier_evidence,
    errorCode: data.error_code, callStarted: data.supplier_call_started_at !== null,
    retryAvailable: !data.supplier_evidence?.shaponCancelRetry?.leaseUntil ||
      Date.parse(data.supplier_evidence.shaponCancelRetry.leaseUntil) <= Date.now(),
  };
}

/** Restore a matching cancellation that was never sent or was definitively refused before closure. */
export async function restoreShapontravelsCancellationNotSent(
  bookingId: string,
  session: DashboardSession,
  request: OperationRequestIdentity,
  operationId: string,
  code: string,
  refused = false
): Promise<{ ok: boolean; code?: string; replay?: boolean }> {
  const db = supabaseAdmin();
  if (!db) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await db.rpc('resolve_shapon_cancellation_not_sent_v1', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
    p_operation_id: operationId,
    p_evidence: refused
      ? { supplierCallStarted: true, phase: 'pre-closure-refusal', code }
      : { supplierCallStarted: false, phase: 'before-request', code },
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('[booking-cancel] not-sent restoration failed:', error?.message ?? 'Invalid database response');
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data as { ok: boolean; code?: string; replay?: boolean };
}

/** Persist an identity-bound Shapon platform closure without invoking wallet RPCs. */
export async function finalizeShaponPlatformCancellation(
  bookingId: string,
  session: DashboardSession,
  request: OperationRequestIdentity,
  operationId: string,
  outcome: ShaponSavedCancellation
): Promise<{ ok: boolean; code?: string; replay?: boolean }> {
  const db = supabaseAdmin();
  if (!db) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await db.rpc('finalize_shapon_platform_cancel_v1', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
    p_operation_id: operationId,
    p_outcome: outcome,
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('[booking-cancel] Shapon platform closure storage failed:', error?.message ?? 'Invalid database response');
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data as { ok: boolean; code?: string; replay?: boolean };
}

/** Read the STR identity from the already scope-authorized local booking. */
export async function readShaponCancellationPublicRef(bookingId: string): Promise<string | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db.from('flight_bookings').select('supplier_public_ref')
    .eq('id', bookingId).maybeSingle();
  if (error) throw new Error('Shapon booking identity storage is unavailable.');
  return data?.supplier_public_ref ?? null;
}

/** Claim one retry lease or durably record the response for that same lease. */
export async function advanceShaponCancellationRetry(
  bookingId: string, session: DashboardSession, request: OperationRequestIdentity,
  operationId: string, retryId: string, httpStatus: number | null,
  input: ShapontravelsCancellationInput, saved: { supplierPublicRef: string; requestStartedAt: string }
): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return false;
  const { data, error } = await db.rpc('advance_shapon_platform_cancel_retry_v1', {
    p_booking_id: bookingId, p_actor_user_id: session.clerkId, p_actor_role: session.role,
    p_request_key: request.requestKey, p_request_payload_hash: request.requestPayloadHash,
    p_operation_id: operationId, p_retry_id: retryId, p_http_status: httpStatus,
    p_booking_identity: { ...input, supplierPublicRef: saved.supplierPublicRef },
    p_saved_started_at: saved.requestStartedAt,
  });
  return !error && data?.ok === true;
}
