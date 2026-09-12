'use client';

import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { BookingUserVisibilityContext } from '@/lib/booking-visibility';
import { BOOKING_STATUS_LABELS } from '@/lib/flights/booking-status';

type ApiBody = {
  success?: boolean;
  error?: { errorMessage?: string };
};

const INELIGIBLE_MESSAGES: Record<string, string> = {
  NOT_B2B_BOOKING: 'This is not a B2B agency booking.',
  STATUS_NOT_ELIGIBLE:
    'Only On Hold, Cancelled, or Expired bookings may be hidden.',
  WALLET_FOOTPRINT_FOUND:
    'Wallet reservation or ledger history exists for this booking or its attempt.',
  FINANCIAL_SUMMARY_NOT_CLEAN:
    'The booking financial summary is not clean, so eligibility fails closed.',
};

function dateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function BookingUserVisibilityPanel({
  bookingReference,
  context,
}: {
  bookingReference: string;
  context: BookingUserVisibilityContext;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hidden = context.hiddenFromUser;
  const canSubmit = reason.trim().length >= 3 && (hidden || context.eligibleToHide);

  async function changeVisibility() {
    if (!canSubmit || busy) return;
    const action = hidden ? 'unhide' : 'hide';
    const confirmed = window.confirm(
      hidden
        ? 'Restore this booking to the B2B user?'
        : 'Hide this booking from all users in its B2B agency? The booking and all internal processing will remain intact.'
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/bookings/${encodeURIComponent(bookingReference)}/visibility`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            requestId: crypto.randomUUID(),
            reason: reason.trim(),
          }),
        }
      );
      const body = (await response.json()) as ApiBody;
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.errorMessage ?? 'The visibility change was not accepted.'
        );
      }
      setMessage(
        hidden
          ? 'Booking restored to the B2B user.'
          : 'Booking hidden from the B2B user.'
      );
      setReason('');
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The visibility change failed.'
      );
    } finally {
      setBusy(false);
    }
  }

  const statusLabel =
    BOOKING_STATUS_LABELS[
      context.effectiveStatus as keyof typeof BOOKING_STATUS_LABELS
    ] ?? context.effectiveStatus;

  return (
    <section className="overflow-hidden rounded-xl border border-sky-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-sky-200 bg-sky-50 px-5 py-4">
        <span className="rounded-full bg-white p-2 text-sky-700 ring-1 ring-sky-200">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">B2B user visibility</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Visibility only. This action does not change booking status, wallet,
            supplier data, or background processing.
          </p>
        </div>
      </header>

      <div className="space-y-4 p-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">
              Current visibility
            </dt>
            <dd className="mt-1 flex items-center gap-2 font-semibold text-navy-950">
              {hidden ? (
                <EyeOff className="h-4 w-4 text-amber-700" aria-hidden />
              ) : (
                <Eye className="h-4 w-4 text-emerald-700" aria-hidden />
              )}
              {hidden ? 'Hidden from B2B user' : 'Visible to B2B user'}
            </dd>
          </div>
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">
              Effective status
            </dt>
            <dd className="mt-1 font-semibold text-navy-950">{statusLabel}</dd>
          </div>
          <div className="rounded-lg bg-neutral-50 p-3">
            <dt className="text-xs font-semibold uppercase text-neutral-500">
              Wallet footprint
            </dt>
            <dd className="mt-1 font-semibold text-navy-950">
              {context.reservationCount === 0 && context.ledgerCount === 0
                ? 'None found'
                : 'Financial history found'}
            </dd>
          </div>
        </dl>

        {hidden && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            <p>
              Hidden {dateTime(context.hiddenAt)} by{' '}
              <span className="font-semibold">{context.hiddenByUserId ?? 'staff'}</span>.
            </p>
            {context.hiddenReason && <p className="mt-1">Reason: {context.hiddenReason}</p>}
          </div>
        )}

        {!hidden && !context.eligibleToHide && (
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
            {INELIGIBLE_MESSAGES[context.code] ??
              'This booking is not currently eligible to be hidden.'}
          </p>
        )}

        <label className="block text-sm font-medium text-neutral-700">
          {hidden ? 'Restore reason' : 'Hide reason'}
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            placeholder={
              hidden
                ? 'Explain why access should be restored.'
                : 'Explain why this booking should be hidden from the B2B user.'
            }
            className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 px-3 py-2"
          />
        </label>

        {message && (
          <p
            role="status"
            className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
          >
            {message}
          </p>
        )}

        <Button
          type="button"
          variant={hidden ? 'default' : 'destructive'}
          disabled={!canSubmit || busy}
          onClick={() => void changeVisibility()}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {hidden ? 'Restore to User' : 'Hide from User'}
        </Button>
      </div>
    </section>
  );
}
