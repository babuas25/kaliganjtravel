import {
  AlertTriangle,
  CircleDollarSign,
  Clock3,
  FileWarning,
  ShieldAlert,
  TimerReset,
} from 'lucide-react';

import type { BookingLifecycleMetrics } from '@/lib/dashboard/booking-lifecycle-metrics';

const metricStamp = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Dhaka',
});

function oldest(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : metricStamp.format(parsed);
}

export default function BookingLifecycleMetricsPanel({
  metrics,
}: {
  metrics: BookingLifecycleMetrics;
}) {
  const cards = [
    {
      label: 'Open cases',
      value: metrics.openCases,
      oldest: oldest(metrics.oldestOpenCaseAt),
      icon: FileWarning,
    },
    {
      label: 'Aged operations',
      value: metrics.agedOperations,
      oldest: oldest(metrics.oldestAgedOperationAt),
      icon: TimerReset,
    },
    {
      label: 'Aged attempts',
      value: metrics.agedAttempts,
      oldest: oldest(metrics.oldestAgedAttemptAt),
      icon: Clock3,
    },
    {
      label: 'SLA breaches',
      value: metrics.slaBreaches,
      oldest: oldest(metrics.oldestSlaBreachAt),
      icon: AlertTriangle,
    },
    {
      label: 'Terminal conflicts',
      value: metrics.terminalConflicts,
      icon: ShieldAlert,
    },
    {
      label: 'Wallet inconsistencies',
      value: metrics.walletInconsistencies,
      icon: CircleDollarSign,
    },
    {
      label: 'Notify pending',
      value: metrics.notifications.pending + metrics.notifications.processing,
      oldest: oldest(metrics.notifications.oldestPendingAt),
      icon: Clock3,
    },
    {
      label: 'Notify retries',
      value: metrics.notifications.retryingRecipients,
      icon: TimerReset,
    },
    {
      label: 'Notify dead letters',
      value: metrics.notifications.deadLetters,
      oldest: oldest(metrics.notifications.oldestDeadLetterAt),
      icon: AlertTriangle,
    },
    {
      label: 'Notify suppressed',
      value:
        metrics.notifications.suppressed + metrics.notifications.superseded,
      icon: ShieldAlert,
    },
    {
      label: 'Expiry backlog',
      value: metrics.derivedLifecycle.dueExpiry,
      oldest: oldest(metrics.derivedLifecycle.oldestDueDeadlineAt),
      icon: Clock3,
    },
    {
      label: 'Expiry starved',
      value: metrics.derivedLifecycle.starvedExpiry,
      icon: AlertTriangle,
    },
    {
      label: 'Sweep failures',
      value:
        metrics.derivedLifecycle.failedRuns24h +
        metrics.derivedLifecycle.staleRunningRuns,
      icon: TimerReset,
    },
    {
      label: 'Unconfirmed repair',
      value: metrics.derivedLifecycle.unconfirmedRepair,
      icon: FileWarning,
    },
  ];

  return (
    <section aria-label="Lifecycle health" className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wide text-navy-800">
          Lifecycle health
        </h2>
        <span className="text-[10px] text-neutral-500">
          Read only · {metricStamp.format(new Date(metrics.observedAt))}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-7">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              title={card.oldest ? `Oldest: ${card.oldest}` : undefined}
              className={`rounded-lg border bg-white p-3 shadow-sm ${
                card.value > 0
                  ? 'border-amber-300'
                  : 'border-neutral-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  {card.label}
                </span>
                <Icon
                  className={`h-3.5 w-3.5 ${
                    card.value > 0 ? 'text-amber-700' : 'text-neutral-400'
                  }`}
                  aria-hidden
                />
              </div>
              <p
                className={`mt-1 text-xl font-bold tabular-nums ${
                  card.value > 0 ? 'text-amber-800' : 'text-navy-950'
                }`}
              >
                {card.value.toLocaleString('en-US')}
              </p>
              {card.oldest && (
                <p className="mt-0.5 truncate text-[9px] text-neutral-500">
                  Oldest {card.oldest}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
