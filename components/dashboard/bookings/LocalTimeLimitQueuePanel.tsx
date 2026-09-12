import { Clock3 } from 'lucide-react';
import Link from 'next/link';

import type { PendingLocalTimeLimitQueueItem } from '@/lib/booking-lifecycle/local-time-limit';

function dateTime(value: string | null): string {
  if (!value) return 'Missing';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function LocalTimeLimitQueuePanel({
  requests,
}: {
  requests: PendingLocalTimeLimitQueueItem[];
}) {
  if (requests.length === 0) return null;
  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
      <header className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3">
        <Clock3 className="h-4 w-4 text-amber-700" aria-hidden />
        <h2 className="text-sm font-bold text-navy-950">
          Local Time Limit Requests ({requests.length})
        </h2>
      </header>
      <div className="divide-y divide-neutral-100">
        {requests.map((request) => (
          <Link
            key={request.requestId}
            href={`/dashboard/bookings/${request.bookingReference}`}
            className="grid gap-1 px-4 py-3 text-sm transition hover:bg-navy-50 sm:grid-cols-3"
          >
            <span className="font-bold text-brand-orange">{request.bookingReference}</span>
            <span className="text-neutral-600">
              {request.eligibilityReason === 'supplier_deadline_missing'
                ? 'Supplier TTL missing'
                : `Supplier TTL: ${dateTime(request.supplierDeadlineAt)}`}
            </span>
            <span className="text-neutral-500 sm:text-right">
              Requested {dateTime(request.requestedAt)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
