import { redirect } from 'next/navigation';

import SummaryCard from '@/components/dashboard/SummaryCard';
import WelcomeBanner from '@/components/dashboard/WelcomeBanner';
import { isWelcomeVisible } from '@/lib/dashboard/welcome';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getRecentActivity, getSummary } from '@/lib/dashboard/data';
import { ROLE_LABELS } from '@/lib/roles';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '@/lib/flights/booking-status';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<BookingStatus, string> = {
  'on-hold': 'bg-amber-50 text-amber-700',
  confirmed: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-navy-50 text-navy-700',
  'in-progress': 'bg-blue-50 text-blue-700',
  expired: 'bg-neutral-100 text-neutral-700',
  unconfirmed: 'bg-orange-50 text-orange-700',
  cancelled: 'bg-brand-orange-light text-brand-orange-dark',
};

export default async function DashboardHomePage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');

  const { role, name, signedInAt } = session;
  const [summary, activity] = await Promise.all([
    getSummary(session),
    getRecentActivity(session),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <WelcomeBanner
        name={name}
        roleLabel={ROLE_LABELS[role]}
        signedInAt={signedInAt}
        initialVisible={isWelcomeVisible(signedInAt)}
      />

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-navy-700">
          Summary
        </h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {summary.map(({ key, value }) => (
            <SummaryCard
              key={key}
              tileKey={key}
              value={value}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-navy-700">
          Recent activity
        </h3>
        <div className="mt-4 divide-y divide-navy-100 overflow-hidden rounded-lg border border-navy-100 bg-white">
          {activity.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-navy-700/60">
              No booking activity yet.
            </p>
          ) : activity.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-navy-950">
                  {item.title}
                </p>
                <p className="truncate text-xs text-navy-700/70">{item.meta}</p>
              </div>
              <span className="font-mono text-xs text-navy-700/60">
                {item.id}
              </span>
              <span
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs font-semibold',
                  STATUS_STYLES[item.status]
                )}
              >
                {BOOKING_STATUS_LABELS[item.status]}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
