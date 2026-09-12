import { NextRequest, NextResponse } from 'next/server';

import {
  processBookingAttemptWatchdog,
  processBookingOperationWatchdog,
} from '@/lib/db/booking-operations';
import { bookingLifecycleRolloutState } from '@/lib/booking-lifecycle/rollout';
import {
  observeDerivedBookingStatuses,
  processDerivedBookingStatusObservations,
  repairUnconfirmedBookingObservations,
} from '@/lib/db/flight-bookings';
import { processBookingPnrRefreshJob } from '@/lib/db/booking-pnr-refresh';
import { processImportedManualTicketEscalations } from '@/lib/db/impexp';
import {
  escalateBookingNotificationDeadLetters,
  recoverStaleBookingNotificationClaims,
} from '@/lib/db/booking-notifications';
import { dispatchPendingBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import {
  dispatchPendingBookingIssuedSms,
} from '@/lib/sms/booking-issued-delivery';
import {
  recoverStaleBookingIssuedSmsClaims,
} from '@/lib/db/booking-issued-sms';
import {
  recoverStaleTicketManagementNotificationClaims,
} from '@/lib/db/ticket-management-notifications';
import { dispatchPendingTicketManagementEmails } from '@/lib/email/ticket-management-delivery';
import { recoverStaleDepositApprovedSmsClaims } from '@/lib/db/deposit-approved-sms';
import { dispatchPendingDepositApprovedSms } from '@/lib/sms/deposit-approved-delivery';
import { recoverStaleDepositRequestAdminSmsClaims } from '@/lib/db/deposit-request-admin-sms';
import { dispatchPendingDepositRequestAdminSms } from '@/lib/sms/deposit-request-admin-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SCHEDULER_WORK_BUDGET_MS = 105_000;

type ScheduledStep<T> =
  | { status: 'completed'; result: T }
  | { status: 'skipped'; reason: 'time_budget' | 'rollout_disabled' }
  | { status: 'failed'; error: string };

function schedulerError(error: unknown): string {
  return error instanceof Error ? error.message : 'Scheduled step failed.';
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: 'Booking status email scheduler is not configured.' },
      { status: 503 }
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const schedulerStartedAt = performance.now();
  const rollout = bookingLifecycleRolloutState();
  const remainingMs = () =>
    Math.max(0, SCHEDULER_WORK_BUDGET_MS - (performance.now() - schedulerStartedAt));
  const runStep = async <T,>(
    minimumRemainingMs: number,
    work: () => Promise<T>
  ): Promise<ScheduledStep<T>> => {
    if (remainingMs() <= minimumRemainingMs) {
      return { status: 'skipped', reason: 'time_budget' };
    }
    try {
      return { status: 'completed', result: await work() };
    } catch (error) {
      return { status: 'failed', error: schedulerError(error) };
    }
  };

  const rolloutDisabled = <T,>(): ScheduledStep<T> => ({
    status: 'skipped',
    reason: 'rollout_disabled',
  });
  const operationWatchdog = rollout.operationWorkers
    ? await runStep(5_000, () => processBookingOperationWatchdog(100))
    : rolloutDisabled();
  const attemptWatchdog = rollout.operationWorkers
    ? await runStep(5_000, () => processBookingAttemptWatchdog(100))
    : rolloutDisabled();
  const importedManualTicketEscalations = rollout.importedWorkers
    ? await runStep(5_000, () => processImportedManualTicketEscalations(100))
    : rolloutDisabled();
  // One bounded, read-only supplier PNR call per scheduler run. New bookings
  // are queued durably by the database trigger; no Book request is retried.
  const pnrDeadlineRefresh = rollout.pnrDeadlineRefresh
    ? await runStep(30_000, () => processBookingPnrRefreshJob())
    : rolloutDisabled();
  // Keep the bounded compatibility RPC until the scalable keyset worker is
  // explicitly enabled. The old production application uses this same path.
  const observed = rollout.scalableSweep
    ? await runStep(12_000, () =>
        processDerivedBookingStatusObservations({
          batchSize: 250,
          maxBatches: 20,
          timeBudgetMs: Math.min(10_000, Math.max(500, remainingMs() - 2_000)),
          safetyMarginMs: 500,
        })
      )
    : await runStep(5_000, () => observeDerivedBookingStatuses(500));
  const unconfirmedRepair = rollout.scalableSweep
    ? await runStep(5_000, () => repairUnconfirmedBookingObservations(50))
    : rolloutDisabled();
  const notificationRecovery = rollout.notificationOutbox
    ? await runStep(5_000, () => recoverStaleBookingNotificationClaims(100))
    : rolloutDisabled();
  const delivery = rollout.notificationOutbox
    ? await runStep(25_000, () => {
        const timeBudgetMs = Math.min(
          30_000,
          Math.max(1_000, remainingMs() - 5_000)
        );
        return dispatchPendingBookingStatusEmails(25, {
          timeBudgetMs,
          safetyMarginMs: Math.min(22_000, timeBudgetMs - 500),
        });
      })
    : rolloutDisabled();
  const issuedSmsRecovery = await runStep(3_000, () =>
    recoverStaleBookingIssuedSmsClaims(100)
  );
  const issuedSmsDelivery = await runStep(12_000, () =>
    dispatchPendingBookingIssuedSms(10)
  );
  const depositApprovedSmsRecovery = await runStep(3_000, () =>
    recoverStaleDepositApprovedSmsClaims(100)
  );
  const depositApprovedSmsDelivery = await runStep(12_000, () =>
    dispatchPendingDepositApprovedSms(10)
  );
  const depositRequestAdminSmsRecovery = await runStep(3_000, () =>
    recoverStaleDepositRequestAdminSmsClaims(100)
  );
  const depositRequestAdminSmsDelivery = await runStep(12_000, () =>
    dispatchPendingDepositRequestAdminSms(10)
  );
  const ticketManagementNotificationRecovery = await runStep(5_000, () =>
    recoverStaleTicketManagementNotificationClaims(100)
  );
  const ticketManagementDelivery = await runStep(12_000, () =>
    dispatchPendingTicketManagementEmails(10)
  );
  const notificationDeadLettersEscalated = rollout.notificationOutbox
    ? await runStep(3_000, () => escalateBookingNotificationDeadLetters(100))
    : rolloutDisabled();
  const schedulerDurationMs = Math.round(performance.now() - schedulerStartedAt);
  return NextResponse.json(
    {
      success: true,
      operationWatchdog,
      attemptWatchdog,
      importedManualTicketEscalations,
      pnrDeadlineRefresh,
      observed,
      unconfirmedRepair,
      notificationRecovery,
      notificationDeadLettersEscalated,
      delivery,
      issuedSmsRecovery,
      issuedSmsDelivery,
      depositApprovedSmsRecovery,
      depositApprovedSmsDelivery,
      depositRequestAdminSmsRecovery,
      depositRequestAdminSmsDelivery,
      ticketManagementNotificationRecovery,
      ticketManagementDelivery,
      rollout,
      scheduler: {
        workBudgetMs: SCHEDULER_WORK_BUDGET_MS,
        platformMaxDurationSeconds: maxDuration,
        durationMs: schedulerDurationMs,
        withinWorkBudget: schedulerDurationMs <= SCHEDULER_WORK_BUDGET_MS,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
