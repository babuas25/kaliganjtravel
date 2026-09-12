'use client';

import { useState } from 'react';
import { Clock3, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';

import {
  isLocalTimeLimitGrantMinutes,
  LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES,
  LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES,
  type LocalTimeLimitContext,
} from '@/lib/booking-lifecycle/local-time-limit';

type ApiBody = {
  success?: boolean;
  error?: { errorMessage?: string };
};

function dateTime(value: string | null): string {
  if (!value) return 'Missing';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function LocalTimeLimitDecisionPanel({
  bookingReference,
  context,
}: {
  bookingReference: string;
  context: LocalTimeLimitContext;
}) {
  const router = useRouter();
  const request = context.request?.state === 'pending' ? context.request : null;
  const [minutesInput, setMinutesInput] = useState('15');
  const [verificationConfirmed, setVerificationConfirmed] = useState(false);
  const [verificationNote, setVerificationNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!request) return null;
  const requestId = request.id;
  const requestVersion = request.version;
  const minutes = Number(minutesInput);
  const validMinutes = isLocalTimeLimitGrantMinutes(minutes);

  async function decide(action: 'approve' | 'reject') {
    if (busy) return;
    if (action === 'approve' && !validMinutes) {
      setMessage('Enter a whole number of minutes from 1 through 30.');
      return;
    }
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/booking-lifecycle/${encodeURIComponent(bookingReference)}/local-time-limit`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action === 'approve'
              ? {
                  action,
                  requestId,
                  expectedVersion: requestVersion,
                  grantedMinutes: minutes,
                  verificationConfirmed,
                  verificationNote: verificationNote.trim(),
                }
              : {
                  action,
                  requestId,
                  expectedVersion: requestVersion,
                  rejectionReason: rejectionReason.trim(),
                }
          ),
        }
      );
      const body = (await response.json()) as ApiBody;
      if (!response.ok || !body.success) {
        throw new Error(body.error?.errorMessage ?? 'The decision was not accepted.');
      }
      setMessage(
        action === 'approve'
          ? `Approved ${minutes} minutes from the decision time.`
          : 'The request was rejected.'
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The decision failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-5 py-4">
        <span className="rounded-full bg-white p-2 text-amber-700 ring-1 ring-amber-200">
          <Clock3 className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">Local Time Limit Request</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Verify that the airline PNR is still live and unticketed before granting time.
          </p>
        </div>
      </header>

      <div className="space-y-5 p-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">Reason</dt>
            <dd className="mt-1 font-semibold text-navy-950">
              {request.eligibilityReason === 'supplier_deadline_missing'
                ? 'Supplier deadline missing'
                : request.eligibilityReason ===
                    'supplier_deadline_expired_under_3_hours'
                  ? 'Supplier deadline expired less than 3 hours ago'
                  : 'Supplier deadline under 15 minutes'}
            </dd>
          </div>
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">Supplier deadline</dt>
            <dd className="mt-1 font-semibold text-navy-950">
              {dateTime(context.supplierDeadlineAt)}
            </dd>
          </div>
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">Requested</dt>
            <dd className="mt-1 font-semibold text-navy-950">
              {dateTime(request.requestedAt)}
            </dd>
          </div>
        </dl>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-emerald-200 p-4">
            <div className="flex items-center gap-2 font-semibold text-emerald-800">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Approve after portal verification
            </div>
            <label className="block text-sm font-medium text-neutral-700">
              Minutes to grant
              <input
                type="number"
                inputMode="numeric"
                min={LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES}
                max={LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES}
                step={1}
                value={minutesInput}
                onChange={(event) => setMinutesInput(event.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2"
              />
              <span className="mt-1 block text-xs font-normal text-neutral-500">
                Enter any whole number from 1 to 30.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={verificationConfirmed}
                onChange={(event) => setVerificationConfirmed(event.target.checked)}
                className="mt-1"
              />
              I verified in the supplier portal that this PNR is live and unticketed.
            </label>
            <label className="block text-sm font-medium text-neutral-700">
              Verification note
              <textarea
                value={verificationNote}
                onChange={(event) => setVerificationNote(event.target.value)}
                maxLength={1000}
                placeholder="Record the portal status and verification basis."
                className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={
                Boolean(busy) ||
                !validMinutes ||
                !verificationConfirmed ||
                verificationNote.trim().length < 3
              }
              onClick={() => void decide('approve')}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Approve Local Time
            </button>
          </div>

          <div className="space-y-3 rounded-lg border border-red-200 p-4">
            <p className="font-semibold text-red-800">Reject request</p>
            <label className="block text-sm font-medium text-neutral-700">
              Rejection reason
              <textarea
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                maxLength={1000}
                placeholder="Explain why local time cannot be granted."
                className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={Boolean(busy) || rejectionReason.trim().length < 3}
              onClick={() => void decide('reject')}
              className="inline-flex items-center gap-2 rounded-md border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"
            >
              {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Reject Request
            </button>
          </div>
        </div>
        {message && <p className="text-sm font-medium text-neutral-700">{message}</p>}
      </div>
    </section>
  );
}
