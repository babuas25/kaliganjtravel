import 'server-only';

export const BOOKING_LIFECYCLE_ROLLOUT_ENV = {
  operationWorkers: 'BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED',
  importedWorkers: 'BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED',
  reconciliationActions: 'BOOKING_RECONCILIATION_ACTIONS_ENABLED',
  importedActions: 'BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED',
  notificationOutbox: 'BOOKING_NOTIFICATION_OUTBOX_ENABLED',
  scalableSweep: 'BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED',
  pnrDeadlineRefresh: 'BOOKING_PNR_DEADLINE_REFRESH_ENABLED',
} as const;

export type BookingLifecycleRolloutFeature =
  keyof typeof BOOKING_LIFECYCLE_ROLLOUT_ENV;

/**
 * Production behavior is fail-closed. A feature is active only when its exact
 * server-side environment switch is `true`; missing, malformed, and public
 * variables never enable a write, supplier read, email, or new worker.
 */
export function bookingLifecycleRolloutEnabled(
  feature: BookingLifecycleRolloutFeature
): boolean {
  return process.env[BOOKING_LIFECYCLE_ROLLOUT_ENV[feature]]?.trim() === 'true';
}

export function bookingLifecycleRolloutState(): Record<
  BookingLifecycleRolloutFeature,
  boolean
> {
  return {
    operationWorkers: bookingLifecycleRolloutEnabled('operationWorkers'),
    importedWorkers: bookingLifecycleRolloutEnabled('importedWorkers'),
    reconciliationActions: bookingLifecycleRolloutEnabled(
      'reconciliationActions'
    ),
    importedActions: bookingLifecycleRolloutEnabled('importedActions'),
    notificationOutbox: bookingLifecycleRolloutEnabled('notificationOutbox'),
    scalableSweep: bookingLifecycleRolloutEnabled('scalableSweep'),
    pnrDeadlineRefresh: bookingLifecycleRolloutEnabled('pnrDeadlineRefresh'),
  };
}
