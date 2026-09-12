import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Route,
  ShieldCheck,
  TicketCheck,
} from 'lucide-react';

import type { BookingLifecycleTimelineItem } from '@/lib/dashboard/booking-lifecycle-timeline';

const stamp = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Dhaka',
});

function formatted(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : stamp.format(date);
}

const STATE_LABELS: Record<string, string> = {
  claimed: 'Requested',
  supplier_call_started: 'In progress',
  awaiting_external_action: 'Action required',
  needs_reconciliation: 'Needs review',
  succeeded: 'Complete',
  failed: 'Unsuccessful',
  open: 'Open',
  assigned: 'Routed for review',
  awaiting_supplier: 'Waiting for supplier',
  awaiting_finance: 'Waiting for finance',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Resolved',
  closed_no_change: 'Closed',
  superseded: 'Superseded',
  'on-hold': 'On hold',
  pending: 'Pending',
  'in-progress': 'In progress',
  confirmed: 'Confirmed',
  expired: 'Expired',
  unconfirmed: 'Unconfirmed',
  cancelled: 'Cancelled',
};

const TONE_STYLES: Record<
  BookingLifecycleTimelineItem['tone'],
  { marker: string; badge: string }
> = {
  neutral: {
    marker: 'border-navy-200 bg-navy-50 text-navy-700',
    badge: 'bg-neutral-100 text-neutral-700',
  },
  progress: {
    marker: 'border-blue-200 bg-blue-50 text-blue-700',
    badge: 'bg-blue-50 text-blue-700',
  },
  success: {
    marker: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    badge: 'bg-emerald-50 text-emerald-700',
  },
  attention: {
    marker: 'border-amber-200 bg-amber-50 text-amber-800',
    badge: 'bg-amber-50 text-amber-800',
  },
};

function stateLabel(value: string): string {
  return STATE_LABELS[value] ?? value.replace(/[_-]/g, ' ');
}

function TimelineIcon({ item }: { item: BookingLifecycleTimelineItem }) {
  if (item.tone === 'attention') {
    return <CircleAlert className="h-4 w-4" aria-hidden />;
  }
  if (item.tone === 'success') {
    return <CheckCircle2 className="h-4 w-4" aria-hidden />;
  }
  return item.kind === 'operation' ? (
    <TicketCheck className="h-4 w-4" aria-hidden />
  ) : (
    <Clock3 className="h-4 w-4" aria-hidden />
  );
}

export default function BookingLifecycleTimeline({
  items,
  compact = false,
}: {
  items: BookingLifecycleTimelineItem[];
  /** Keeps the activity feed readable when it sits in the booking sidebar. */
  compact?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-navy-950">
            <Route className="h-4 w-4 text-brand-orange" aria-hidden />
            Booking activity
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {compact
              ? 'Recent updates and any next steps.'
              : 'A clear record of what happened to this booking and what needs attention.'}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded bg-navy-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-navy-700">
          <ShieldCheck className="h-3 w-3" aria-hidden /> Read only
        </span>
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-neutral-500">
          No booking activity is available yet.
        </p>
      ) : (
        <ol className="relative space-y-0 px-4 py-1 sm:px-5">
          {items.map((item, index) => {
            const tone = TONE_STYLES[item.tone];
            const effectiveTime = item.occurredAt;
            const observedTime = item.observedAt;
            return (
              <li
                key={item.id}
                className={`relative grid gap-2 py-4 pl-9 ${
                  compact ? '' : 'sm:grid-cols-[10rem_1fr] sm:gap-4'
                }`}
              >
                {index < items.length - 1 && (
                  <span
                    className="absolute bottom-0 left-[15px] top-8 w-px bg-neutral-200"
                    aria-hidden
                  />
                )}
                <span
                  className={`absolute left-0 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full border ${tone.marker}`}
                  aria-hidden
                >
                  <TimelineIcon item={item} />
                </span>
                <div className="text-xs text-neutral-500">
                  <span className="font-medium text-navy-800">
                    {effectiveTime
                      ? formatted(effectiveTime)
                      : 'Effective time unavailable'}
                  </span>
                  {!effectiveTime && observedTime && (
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wide">
                      Observed {formatted(observedTime)}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="text-sm font-semibold text-navy-950">
                      {item.title}
                    </h3>
                    {item.state && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.badge}`}>
                        {stateLabel(item.state)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-neutral-600">
                    {item.description}
                  </p>
                  {item.facts.length > 0 && (
                    <dl
                      className={`mt-2 grid gap-x-4 gap-y-1.5 text-xs ${
                        compact ? '' : 'sm:grid-cols-2 xl:grid-cols-3'
                      }`}
                    >
                      {item.facts.map((itemFact, factIndex) => (
                        <div key={`${itemFact.label}:${factIndex}`} className="min-w-0">
                          <dt className="text-neutral-500">{itemFact.label}</dt>
                          <dd className="break-words font-medium text-navy-900">
                            {itemFact.value.includes('T')
                              ? formatted(itemFact.value)
                              : itemFact.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
