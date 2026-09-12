import 'server-only';

import type { ImportedSupplierEvidenceFacts } from '@/lib/booking-lifecycle/imported-supplier-evidence';
import type { SupplierEvidenceReadFacts } from '@/lib/booking-lifecycle/supplier-evidence-read';
import { supabaseAdmin } from '@/lib/supabase/server';

const OPEN_CASE_STATES = [
  'open',
  'assigned',
  'awaiting_supplier',
  'awaiting_finance',
  'awaiting_approval',
] as const;

export type OpenBookingReconciliationCase = {
  id: string;
  subject_booking_id: string;
  operation_id: string | null;
  case_type: string;
  state: string;
  version: number;
  reason_code?: string;
  opened_source?: string;
};

export type StoredEvidenceReadObservation = {
  id: string;
  normalizedFacts: SupplierEvidenceReadFacts;
};

export type StoredImportedSupplierEvidenceObservation = {
  id: string;
  normalizedFacts: ImportedSupplierEvidenceFacts;
};

export type EvidenceReadRecordResult = {
  ok: boolean;
  replay?: boolean;
  code?: string;
  caseId?: string;
  caseVersion?: number;
  observationId?: string;
  evidenceLatestAt?: string | null;
  statusMutation?: false;
  walletMutation?: false;
  destructiveSupplierCall?: false;
};

export type NoChangeClosureResult = {
  ok: boolean;
  replay?: boolean;
  code?: string;
  caseId?: string;
  operationId?: string;
  observationId?: string;
  closedNoChange?: boolean;
  statusMutation?: false;
  walletMutation?: false;
};

export function isOpenBookingReconciliationCaseState(state: string): boolean {
  return (OPEN_CASE_STATES as readonly string[]).includes(state);
}

export async function readBookingReconciliationCase(
  bookingId: string,
  caseId: string
): Promise<OpenBookingReconciliationCase | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select('id, subject_booking_id, operation_id, case_type, state, version')
    .eq('id', caseId)
    .eq('subject_booking_id', bookingId)
    .maybeSingle();
  if (error) {
    console.error('[db] reconciliation evidence case lookup failed:', error.message);
    throw new Error('Booking reconciliation case could not be loaded.');
  }
  return (data as OpenBookingReconciliationCase | null) ?? null;
}

export async function readOpenImportedManualTicketingCase(
  bookingId: string
): Promise<OpenBookingReconciliationCase | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select('id, subject_booking_id, operation_id, case_type, state, version')
    .eq('subject_booking_id', bookingId)
    .eq('case_type', 'imported_manual_ticketing')
    .in('state', OPEN_CASE_STATES)
    .order('opened_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] imported manual-ticket case lookup failed:', error.message);
    throw new Error('Imported manual-ticket case could not be loaded.');
  }
  return (data as OpenBookingReconciliationCase | null) ?? null;
}

/**
 * Returns any unresolved booking-backed reconciliation case.  Client action
 * gates use this only as a read-only, fail-closed signal; the write RPCs
 * remain authoritative for concurrency and financial state.
 */
export async function readOpenBookingReconciliationCaseForBooking(
  bookingId: string
): Promise<OpenBookingReconciliationCase | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select('id, subject_booking_id, operation_id, case_type, state, version')
    .eq('subject_booking_id', bookingId)
    .in('state', OPEN_CASE_STATES)
    .order('opened_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] open reconciliation case lookup failed:', error.message);
    throw new Error('Open reconciliation case could not be loaded.');
  }
  return (data as OpenBookingReconciliationCase | null) ?? null;
}

/** Finds only the false-positive case shape bound to one completed ticketing operation. */
export async function readOpenTicketingRaceCase(
  bookingId: string,
  operationId: string
): Promise<OpenBookingReconciliationCase | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select(
      'id, subject_booking_id, operation_id, case_type, state, version, reason_code, opened_source'
    )
    .eq('subject_booking_id', bookingId)
    .eq('operation_id', operationId)
    .eq('case_type', 'ticketing_uncertainty')
    .eq('reason_code', 'pnr_sync_conflicts_with_local_truth')
    .eq('opened_source', 'supplier_sync')
    .in('state', OPEN_CASE_STATES)
    .order('opened_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] ticketing race case lookup failed:', error.message);
    throw new Error('Ticketing race reconciliation case could not be loaded.');
  }
  return (data as OpenBookingReconciliationCase | null) ?? null;
}

export async function readStoredEvidenceReadObservation(
  caseId: string,
  observationKey: string
): Promise<StoredEvidenceReadObservation | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_observations')
    .select('id, normalized_facts')
    .eq('reconciliation_case_id', caseId)
    .eq('observation_key', observationKey)
    .maybeSingle();
  if (error) {
    console.error('[db] reconciliation evidence replay lookup failed:', error.message);
    throw new Error('Existing supplier evidence could not be loaded.');
  }
  if (!data) return null;
  return {
    id: data.id as string,
    normalizedFacts: data.normalized_facts as SupplierEvidenceReadFacts,
  };
}

export async function readStoredImportedSupplierEvidenceObservation(
  caseId: string,
  observationKey: string
): Promise<StoredImportedSupplierEvidenceObservation | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking reconciliation storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_observations')
    .select('id, normalized_facts')
    .eq('reconciliation_case_id', caseId)
    .eq('observation_key', observationKey)
    .maybeSingle();
  if (error) {
    console.error('[db] imported evidence replay lookup failed:', error.message);
    throw new Error('Existing imported supplier evidence could not be loaded.');
  }
  if (!data) return null;
  return {
    id: data.id as string,
    normalizedFacts: data.normalized_facts as ImportedSupplierEvidenceFacts,
  };
}

export async function recordBookingReconciliationEvidenceRead(input: {
  bookingId: string;
  caseId: string;
  actorUserId: string;
  actorRole: string;
  observationKey: string;
  facts: SupplierEvidenceReadFacts;
  factsHash: string;
}): Promise<EvidenceReadRecordResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'record_booking_reconciliation_evidence_read_v2',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_actor_user_id: input.actorUserId,
      p_actor_role: input.actorRole,
      p_observation_key: input.observationKey,
      p_normalized_facts: input.facts,
      p_normalized_facts_hash: input.factsHash,
      p_observed_at: input.facts.acquiredAt,
      p_evidence_observed_at: input.facts.evidenceObservedAt,
    }
  );
  if (error) {
    console.error('[db] reconciliation evidence record failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
  }
  return data as EvidenceReadRecordResult;
}

export async function recordImportedSupplierEvidenceRead(input: {
  bookingId: string;
  caseId: string;
  actorUserId: string;
  actorRole: string;
  observationKey: string;
  facts: ImportedSupplierEvidenceFacts;
  factsHash: string;
}): Promise<EvidenceReadRecordResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'record_booking_reconciliation_evidence_read_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_actor_user_id: input.actorUserId,
      p_actor_role: input.actorRole,
      p_observation_key: input.observationKey,
      p_normalized_facts: input.facts,
      p_normalized_facts_hash: input.factsHash,
      p_observed_at: input.facts.acquiredAt,
      p_evidence_observed_at: input.facts.evidenceObservedAt,
    }
  );
  if (error) {
    console.error('[db] imported supplier evidence record failed:', error.message);
    return {
      ok: false,
      code:
        error.code === '22023'
          ? 'IMPORTED_EVIDENCE_REQUEST_IDENTITY_MISMATCH'
          : 'STORAGE_ERROR',
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
  }
  return data as EvidenceReadRecordResult;
}

export async function closeBookingReconciliationNoChange(input: {
  bookingId: string;
  caseId: string;
  observationId: string;
}): Promise<NoChangeClosureResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'close_booking_reconciliation_no_change_v2',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_observation_id: input.observationId,
    }
  );
  if (error) {
    // Rolling deployments may expose evidence reads before the optional
    // no-change closer. Evidence remains recorded and owned in that case.
    console.error('[db] reconciliation no-change closure failed:', error.message);
    return { ok: false, code: 'NO_CHANGE_CLOSURE_UNAVAILABLE' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
  }
  return data as NoChangeClosureResult;
}

export async function closeBookingTicketingRaceNoChange(input: {
  bookingId: string;
  caseId: string;
  observationId: string;
}): Promise<NoChangeClosureResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'close_booking_ticketing_race_no_change_v2',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_observation_id: input.observationId,
    }
  );
  if (error) {
    console.error('[db] ticketing race no-change closure failed:', error.message);
    return { ok: false, code: 'TICKETING_RACE_CLOSURE_UNAVAILABLE' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
  }
  return data as NoChangeClosureResult;
}
