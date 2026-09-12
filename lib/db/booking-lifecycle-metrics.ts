import 'server-only';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import type { BookingLifecycleMetrics } from '@/lib/dashboard/booking-lifecycle-metrics';
import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

type MetricsRow = {
  observed_at: string;
  open_case_count: number;
  oldest_open_case_at: string | null;
  aged_operation_count: number;
  oldest_aged_operation_at: string | null;
  aged_attempt_count: number;
  oldest_aged_attempt_at: string | null;
  sla_breach_count: number;
  oldest_sla_breach_at: string | null;
  terminal_conflict_count: number;
  wallet_inconsistency_count: number;
};

type NotificationMetricsRow = {
  pending_outbox_count: number;
  processing_outbox_count: number;
  sent_outbox_count: number;
  suppressed_outbox_count: number;
  superseded_outbox_count: number;
  dead_letter_outbox_count: number;
  un_escalated_dead_letter_count: number;
  oldest_pending_outbox_at: string | null;
  oldest_dead_letter_at: string | null;
  retry_delivery_count: number;
  sent_delivery_count: number;
  dead_letter_delivery_count: number;
};

type DerivedLifecycleMetricsRow = {
  due_expiry_count: number;
  oldest_due_deadline_at: string | null;
  max_expiry_overdue_seconds: number;
  starved_expiry_count: number;
  unconfirmed_repair_count: number;
  expiry_observations_24h: number;
  average_detection_latency_seconds: number;
  p95_detection_latency_seconds: number;
  max_detection_latency_seconds: number;
  failed_runs_24h: number;
  bounded_runs_24h: number;
  stale_running_runs: number;
  last_successful_run_at: string | null;
  last_run_stop_reason: string | null;
};

export async function readBookingLifecycleMetrics(
  role: Role
): Promise<BookingLifecycleMetrics> {
  if (!bookingLifecycleAccessForRole(role)) {
    throw new Error('Booking lifecycle staff access is required.');
  }
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking lifecycle storage is unavailable.');

  const [lifecycleResult, notificationResult, derivedResult] = await Promise.all([
    supabase
      .from('booking_lifecycle_metrics_v')
      .select(
        'observed_at,open_case_count,oldest_open_case_at,aged_operation_count,oldest_aged_operation_at,aged_attempt_count,oldest_aged_attempt_at,sla_breach_count,oldest_sla_breach_at,terminal_conflict_count,wallet_inconsistency_count'
      )
      .single(),
    supabase
      .from('booking_notification_metrics_v')
      .select(
        'pending_outbox_count,processing_outbox_count,sent_outbox_count,suppressed_outbox_count,superseded_outbox_count,dead_letter_outbox_count,un_escalated_dead_letter_count,oldest_pending_outbox_at,oldest_dead_letter_at,retry_delivery_count,sent_delivery_count,dead_letter_delivery_count'
      )
      .single(),
    supabase
      .from('booking_derived_lifecycle_metrics_v')
      .select(
        'due_expiry_count,oldest_due_deadline_at,max_expiry_overdue_seconds,starved_expiry_count,unconfirmed_repair_count,expiry_observations_24h,average_detection_latency_seconds,p95_detection_latency_seconds,max_detection_latency_seconds,failed_runs_24h,bounded_runs_24h,stale_running_runs,last_successful_run_at,last_run_stop_reason'
      )
      .single(),
  ]);
  if (lifecycleResult.error || notificationResult.error || derivedResult.error) {
    console.error(
      '[db] readBookingLifecycleMetrics failed:',
      lifecycleResult.error?.message ??
        notificationResult.error?.message ??
        derivedResult.error?.message
    );
    throw new Error('Booking lifecycle metrics could not be loaded.');
  }

  const row = lifecycleResult.data as unknown as MetricsRow;
  const notification =
    notificationResult.data as unknown as NotificationMetricsRow;
  const derived = derivedResult.data as unknown as DerivedLifecycleMetricsRow;
  return {
    observedAt: row.observed_at,
    openCases: Number(row.open_case_count),
    oldestOpenCaseAt: row.oldest_open_case_at,
    agedOperations: Number(row.aged_operation_count),
    oldestAgedOperationAt: row.oldest_aged_operation_at,
    agedAttempts: Number(row.aged_attempt_count),
    oldestAgedAttemptAt: row.oldest_aged_attempt_at,
    slaBreaches: Number(row.sla_breach_count),
    oldestSlaBreachAt: row.oldest_sla_breach_at,
    terminalConflicts: Number(row.terminal_conflict_count),
    walletInconsistencies: Number(row.wallet_inconsistency_count),
    notifications: {
      pending: Number(notification.pending_outbox_count),
      processing: Number(notification.processing_outbox_count),
      retryingRecipients: Number(notification.retry_delivery_count),
      sent: Number(notification.sent_outbox_count),
      sentRecipients: Number(notification.sent_delivery_count),
      suppressed: Number(notification.suppressed_outbox_count),
      superseded: Number(notification.superseded_outbox_count),
      deadLetters: Number(notification.dead_letter_outbox_count),
      deadLetterRecipients: Number(notification.dead_letter_delivery_count),
      unEscalatedDeadLetters: Number(
        notification.un_escalated_dead_letter_count
      ),
      oldestPendingAt: notification.oldest_pending_outbox_at,
      oldestDeadLetterAt: notification.oldest_dead_letter_at,
    },
    derivedLifecycle: {
      dueExpiry: Number(derived.due_expiry_count),
      oldestDueDeadlineAt: derived.oldest_due_deadline_at,
      maxExpiryOverdueSeconds: Number(derived.max_expiry_overdue_seconds),
      starvedExpiry: Number(derived.starved_expiry_count),
      unconfirmedRepair: Number(derived.unconfirmed_repair_count),
      expiryObservations24h: Number(derived.expiry_observations_24h),
      averageDetectionLatencySeconds: Number(
        derived.average_detection_latency_seconds
      ),
      p95DetectionLatencySeconds: Number(derived.p95_detection_latency_seconds),
      maxDetectionLatencySeconds: Number(derived.max_detection_latency_seconds),
      failedRuns24h: Number(derived.failed_runs_24h),
      boundedRuns24h: Number(derived.bounded_runs_24h),
      staleRunningRuns: Number(derived.stale_running_runs),
      lastSuccessfulRunAt: derived.last_successful_run_at,
      lastRunStopReason: derived.last_run_stop_reason,
    },
  };
}
