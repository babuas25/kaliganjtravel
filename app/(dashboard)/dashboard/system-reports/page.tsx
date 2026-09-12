import { BarChart3, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import BookingAttemptReconciliationPanel from '@/components/dashboard/bookings/BookingAttemptReconciliationPanel';
import BookingLifecycleMetricsPanel from '@/components/dashboard/bookings/BookingLifecycleMetricsPanel';
import type { StaffAttemptReconciliation } from '@/lib/dashboard/booking-attempt-reconciliation';
import type { BookingLifecycleMetrics } from '@/lib/dashboard/booking-lifecycle-metrics';
import { getDashboardSession } from '@/lib/dashboard/session';
import { dashboardFeatureEnabled } from '@/lib/dashboard/features';
import { listBookingAttemptReconciliationQueue } from '@/lib/db/booking-attempt-reconciliation';
import { readBookingLifecycleMetrics } from '@/lib/db/booking-lifecycle-metrics';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'System Reports — Kaliganj Travels',
};

/** Super Admin-only operational reporting, kept separate from daily bookings. */
export default async function SystemReportsPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin' || !dashboardFeatureEnabled('system-reports')) notFound();

  const [metricsResult, attemptsResult] = await Promise.allSettled([
    readBookingLifecycleMetrics(session.role),
    listBookingAttemptReconciliationQueue(session.role),
  ]);
  const metrics: BookingLifecycleMetrics | null =
    metricsResult.status === 'fulfilled' ? metricsResult.value : null;
  const attempts: StaffAttemptReconciliation[] =
    attemptsResult.status === 'fulfilled' ? attemptsResult.value : [];

  if (metricsResult.status === 'rejected') {
    console.error('[system-reports] lifecycle metrics unavailable:', metricsResult.reason);
  }
  if (attemptsResult.status === 'rejected') {
    console.error(
      '[system-reports] attempt reconciliation queue unavailable:',
      attemptsResult.reason
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <header className="rounded-xl border border-navy-100 bg-white px-5 py-4 shadow-sm sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-orange">
              <BarChart3 className="h-4 w-4" aria-hidden /> System Reports
            </p>
            <h1 className="mt-1 text-xl font-bold text-navy-950">
              Booking operations overview
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-neutral-600">
              Monitor supplier follow-ups, ticketing delays, payment checks, and
              notifications that need Super Admin attention.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-navy-50 px-3 py-1.5 text-[11px] font-semibold text-navy-700">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Super Admin only
          </span>
        </div>
      </header>

      {metrics ? (
        <BookingLifecycleMetricsPanel metrics={metrics} />
      ) : (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950">
          Booking health data is temporarily unavailable. Please refresh the
          page or try again shortly.
        </section>
      )}

      {attemptsResult.status === 'fulfilled' && attempts.length === 0 ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-950">
          No supplier booking follow-ups need attention right now.
        </section>
      ) : attemptsResult.status === 'fulfilled' ? (
        <BookingAttemptReconciliationPanel attempts={attempts} />
      ) : (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950">
          Supplier booking follow-ups are temporarily unavailable. Please try
          again shortly.
        </section>
      )}
    </div>
  );
}
