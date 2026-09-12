import 'server-only';

import {
  staffAttemptReconciliation,
  type AttemptReconciliationQueueRow,
  type StaffAttemptReconciliation,
} from '@/lib/dashboard/booking-attempt-reconciliation';
import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

const ATTEMPT_QUEUE_SELECT = [
  'reconciliation_case_id',
  'reconciliation_state',
  'reason_code',
  'reason_detail',
  'assigned_team',
  'assignee_user_id',
  'severity',
  'priority',
  'opened_at',
  'due_at',
  'escalation_level',
  'evidence_latest_at',
  'reconciliation_version',
  'booking_attempt_id',
  'supplier',
  'attempt_state',
  'attempt_created_at',
  'submitted_at',
  'resolved_at',
  'supplier_call_started_at',
  'supplier_response_received_at',
  'supplier_response_http_status',
  'operation_identity_present',
  'unique_trans_id',
  'pnr',
  'booking_code_ref',
  'air_ticketing_details_eligible',
  'pnr_lookup_eligible',
  'supplier_read_strategy',
  'supplier_identity_kind',
  'destructive_replay_allowed',
  'automatic_resolution_allowed',
  'manual_portal_required_if_inconclusive',
  'direct_ticketing',
  'reservation_id',
  'reservation_state',
  'reservation_amount',
  'reservation_currency',
  'recovered_booking_id',
  'recovered_booking_public_ref',
].join(',');

export async function listBookingAttemptReconciliationQueue(
  role: Role,
  options: { limit?: number } = {}
): Promise<StaffAttemptReconciliation[]> {
  const access = bookingLifecycleAccessForRole(role);
  if (!access) {
    throw new Error('Booking lifecycle staff access is required.');
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    throw new Error('Booking attempt reconciliation storage is unavailable.');
  }

  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const { data, error } = await supabase
    .from('booking_attempt_reconciliation_queue_v')
    .select(ATTEMPT_QUEUE_SELECT)
    .order('priority', { ascending: true })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('opened_at', { ascending: true })
    .order('reconciliation_case_id', { ascending: true })
    .limit(limit);

  if (error) {
    console.error(
      '[db] listBookingAttemptReconciliationQueue failed:',
      error.message
    );
    throw new Error('Booking attempt reconciliation queue could not be loaded.');
  }

  return ((data ?? []) as unknown as AttemptReconciliationQueueRow[]).map(
    (row) => staffAttemptReconciliation(row, access)
  );
}
