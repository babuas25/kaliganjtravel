import { AlertTriangle, SearchCheck, ShieldAlert } from 'lucide-react';

import type { StaffAttemptReconciliation } from '@/lib/dashboard/booking-attempt-reconciliation';
import { bookingReviewResponsibility } from '@/lib/dashboard/booking-review-responsibility';

const timestamp = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Dhaka',
});

function stamp(value: string | null): string {
  if (!value) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timestamp.format(parsed);
}

const STRATEGY_LABELS: Record<
  StaffAttemptReconciliation['readPlan']['strategy'],
  string
> = {
  pnr_then_air_ticketing_details: 'PNR, then ticketing report',
  air_ticketing_details_then_manual_portal:
    'Ticketing report, then supplier portal',
  manual_supplier_portal_only: 'Supplier portal only',
};

export default function BookingAttemptReconciliationPanel({
  attempts,
}: {
  attempts: StaffAttemptReconciliation[];
}) {
  if (attempts.length === 0) return null;

  return (
    <section
      aria-label="Booking attempt reconciliation reviews"
      className="mb-4 overflow-hidden rounded-xl border border-amber-300 bg-white shadow-sm"
    >
      <div className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-amber-950">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            Booking attempt reconciliation
          </h2>
          <p className="mt-0.5 text-[11px] text-amber-900">
            {attempts.length} supplier outcome
            {attempts.length === 1 ? '' : 's'} need controlled read-only
            investigation. Never submit Book again.
          </p>
        </div>
        <span className="w-fit rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-800">
          Internal review · no public status
        </span>
      </div>

      <div className="divide-y divide-neutral-200">
        {attempts.map((attempt) => {
          const identity = attempt.readPlan.supplierIdentity;
          return (
            <article
              key={attempt.caseId}
              className="grid gap-3 px-4 py-3 text-xs lg:grid-cols-[1.2fr_1.5fr_1fr_1fr]"
            >
              <div className="min-w-0">
                <p className="font-semibold text-navy-950">
                  {attempt.recoveredBooking?.publicRef ??
                    `Attempt ${attempt.attemptId.slice(0, 8)}`}
                </p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Internal state: {attempt.attemptState}
                  {attempt.directTicketing ? ' · Direct ticket' : ''}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-neutral-500">
                  Case {attempt.caseId}
                </p>
              </div>

              <div className="min-w-0">
                <p className="flex items-center gap-1 font-semibold text-navy-900">
                  <SearchCheck className="h-3.5 w-3.5" aria-hidden />
                  {STRATEGY_LABELS[attempt.readPlan.strategy]}
                </p>
                {identity ? (
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-neutral-600"
                    title={identity.uniqueTransId}
                  >
                    UniqueTransID: {identity.uniqueTransId || 'Missing'}
                  </p>
                ) : (
                  <p className="mt-1 text-[10px] text-neutral-500">
                    Supplier identity is restricted for this role.
                  </p>
                )}
                <p className="mt-1 text-[10px] text-neutral-500">
                  An empty ticketing report is inconclusive; check the supplier
                  portal.
                </p>
              </div>

              <div>
                <p className="font-semibold text-neutral-800">
                  {bookingReviewResponsibility(
                    attempt.reconciliation.assignedTeam
                  )}
                </p>
                <p className="mt-1 text-[10px] text-neutral-500">
                  Due {stamp(attempt.reconciliation.dueAt)}
                </p>
                {attempt.flags.slaBreached && (
                  <p className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-red-700">
                    <AlertTriangle className="h-3 w-3" aria-hidden /> SLA
                    breached
                  </p>
                )}
              </div>

              <div>
                <p className="font-semibold text-neutral-800">
                  Wallet {attempt.wallet?.state ?? 'not reserved'}
                </p>
                <p className="mt-1 text-[10px] text-neutral-500">
                  Supplier call {stamp(attempt.timestamps.supplierCallStartedAt)}
                </p>
                <p className="mt-1 text-[10px] text-neutral-500">
                  Response {stamp(attempt.timestamps.supplierResponseReceivedAt)}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
