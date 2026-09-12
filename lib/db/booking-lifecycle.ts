import 'server-only';

import {
  bookingLifecycleAccessForRole,
  staffBookingLifecycle,
  type BookingLifecycleStaffViewRow,
  type StaffBookingLifecycle,
} from '@/lib/dashboard/booking-lifecycle';
import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

const STAFF_LIFECYCLE_SELECT = [
  'booking_id',
  'public_ref',
  'supplier',
  'import_source',
  'stored_status',
  'lifecycle_status',
  'booked_at',
  'booking_updated_at',
  'ticketing_deadline_at',
  'issued_at',
  'cancelled_at',
  'payment_state',
  'payment_amount',
  'captured_amount',
  'refunded_amount',
  'currency',
  'operation_id',
  'operation_kind',
  'operation_state',
  'operation_reason_code',
  'operation_reason_detail',
  'operation_source',
  'operation_actor_user_id',
  'operation_actor_role',
  'operation_claimed_at',
  'supplier_call_started_at',
  'supplier_response_received_at',
  'external_action_due_at',
  'reconciliation_required_at',
  'operation_completed_at',
  'operation_elapsed_seconds',
  'operation_pointer_mismatch',
  'reservation_id',
  'reservation_state',
  'reservation_amount',
  'reservation_currency',
  'reservation_supplier_call_started_at',
  'reservation_reconciliation_at',
  'reservation_reconciliation_reason',
  'primary_case_id',
  'primary_case_type',
  'primary_case_state',
  'primary_case_reason_code',
  'primary_case_reason_detail',
  'primary_case_assigned_team',
  'primary_case_assignee_user_id',
  'primary_case_severity',
  'primary_case_priority',
  'primary_case_due_at',
  'primary_case_escalation_level',
  'primary_case_evidence_latest_at',
  'primary_case_evidence_is_fresh',
  'financial_disposition',
  'primary_case_version',
  'open_case_count',
  'case_sla_breached',
  'payment_conflict_code',
  'terminal_conflict_visible',
  'staff_attention_required',
].join(',');

export type StaffLifecycleQuery = {
  publicRefs?: readonly string[];
  attentionOnly?: boolean;
  limit?: number;
};

export async function listStaffBookingLifecycle(
  role: Role,
  options: StaffLifecycleQuery = {}
): Promise<StaffBookingLifecycle[]> {
  const access = bookingLifecycleAccessForRole(role);
  if (!access) throw new Error('Booking lifecycle staff access is required.');

  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking lifecycle storage is unavailable.');

  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  let query = supabase
    .from('booking_lifecycle_staff_v')
    .select(STAFF_LIFECYCLE_SELECT)
    .order('booking_updated_at', { ascending: false })
    .order('booking_id', { ascending: false })
    .limit(limit);

  if (options.publicRefs?.length) {
    query = query.in('public_ref', Array.from(new Set(options.publicRefs)));
  }
  if (options.attentionOnly) {
    query = query.eq('staff_attention_required', true);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[db] listStaffBookingLifecycle failed:', error.message);
    throw new Error('Booking lifecycle records could not be loaded.');
  }

  return ((data ?? []) as unknown as BookingLifecycleStaffViewRow[]).map((row) =>
    staffBookingLifecycle(row, access)
  );
}
