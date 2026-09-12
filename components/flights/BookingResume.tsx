'use client';

import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatPrice, type FlightRepriceResult } from '@/lib/flights/types';
import {
  clearBookingSnapshot,
  readBookingSnapshot,
} from '@/lib/flights/booking-snapshot.client';

type RepriceEnvelope =
  | { success: true; data: FlightRepriceResult }
  | {
      success: false;
      error: { errorCode: string; errorMessage: string };
    };

type PrepareEnvelope =
  | {
      success: true;
      data: {
        attempt: { attemptId: string };
        accessToken: string;
      };
    }
  | {
      success: false;
      error: { errorCode: string; errorMessage: string };
    };

function safeReturnPath(value: string): string {
  return value.startsWith('/flights?') ? value : '/flights';
}

/** Finishes the exact verified fare selection after Clerk sign-in. */
export default function BookingResume({
  searchId,
  itineraryId,
  returnTo,
}: {
  searchId: string;
  itineraryId: string;
  returnTo: string;
}) {
  const router = useRouter();
  const started = useRef(false);
  const itinerarySnapshot = useRef<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<FlightRepriceResult | null>(null);
  const [phase, setPhase] = useState<'verifying' | 'confirming' | 'preparing'>(
    'verifying'
  );
  const backToSearch = safeReturnPath(returnTo);

  const prepareBooking = useCallback(
    async (result: FlightRepriceResult) => {
      setPhase('preparing');
      setError(null);
      if (!itinerarySnapshot.current) {
        setError('This selected flight is no longer available in this browser. Please choose it again.');
        return;
      }
      try {
        const response = await fetch('/api/flights/booking/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchId,
            itineraryId,
            acceptedRepricedAt: result.requiresConfirmation
              ? result.repricedAt
              : null,
            itinerary: itinerarySnapshot.current,
          }),
        });
        const envelope = (await response.json()) as PrepareEnvelope;
        if (!envelope.success) {
          setError(envelope.error.errorMessage);
          return;
        }

        const bookingId = envelope.data.attempt.attemptId;
        clearBookingSnapshot(searchId, itineraryId);
        sessionStorage.setItem(
          `kaliganj-booking-${bookingId}`,
          envelope.data.accessToken
        );
        router.replace(
          `/flights/checkout?bookingId=${encodeURIComponent(bookingId)}`
        );
      } catch {
        setError('The traveller form could not be prepared. Please try again.');
      }
    },
    [itineraryId, router, searchId]
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!searchId || !itineraryId) {
      setError('This fare selection is incomplete. Please choose the flight again.');
      return;
    }
    itinerarySnapshot.current = readBookingSnapshot(searchId, itineraryId);
    if (!itinerarySnapshot.current) {
      setError('This selected flight is no longer available in this browser. Please choose it again.');
      return;
    }

    void fetch('/api/flights/reprice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchId, itineraryId }),
    })
      .then(async (response) => (await response.json()) as RepriceEnvelope)
      .then((envelope) => {
        if (!envelope.success) {
          setError(envelope.error.errorMessage);
          return;
        }
        if (envelope.data.requiresConfirmation) {
          setVerified(envelope.data);
          setPhase('confirming');
          return;
        }
        void prepareBooking(envelope.data);
      })
      .catch(() => {
        setError('The airline could not verify this fare. Please try again.');
      });
  }, [itineraryId, prepareBooking, searchId]);

  if (error) {
    return (
      <div className="rounded-lg bg-white p-10 text-center ring-1 ring-neutral-200">
        <AlertCircle className="mx-auto h-7 w-7 text-brand-orange" aria-hidden />
        <p className="mt-3 font-semibold text-navy-950">{error}</p>
        <Link
          href={backToSearch}
          className="mt-5 inline-flex rounded-lg bg-brand-orange px-5 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white"
        >
          Return to flight results
        </Link>
      </div>
    );
  }

  if (phase === 'confirming' && verified) {
    return (
      <div className="mx-auto max-w-xl rounded-lg bg-white p-6 ring-1 ring-neutral-200 sm:p-8">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" aria-hidden />
          <div>
            <h2 className="text-lg font-bold text-navy-950">Fare updated</h2>
            <p className="mt-1 text-sm text-neutral-600">
              The airline changed this fare while you were signing in. Review the new total before continuing.
            </p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-neutral-50 p-4 ring-1 ring-neutral-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Previous total</p>
            <p className="mt-1 text-lg font-bold text-neutral-600 line-through">
              {formatPrice(verified.previousTotalPrice, verified.currency)}
            </p>
          </div>
          <div className="rounded-lg bg-brand-orange-light p-4 ring-1 ring-brand-orange/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-orange-dark">Updated total</p>
            <p className="mt-1 text-lg font-bold text-brand-orange-dark">
              {formatPrice(verified.totalPrice, verified.currency)}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Link
            href={backToSearch}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-5 text-sm font-semibold text-navy-950 transition hover:bg-neutral-50"
          >
            Choose another fare
          </Link>
          <button
            type="button"
            onClick={() => void prepareBooking(verified)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-orange px-5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white"
          >
            Accept updated fare
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg bg-white p-10 text-center ring-1 ring-neutral-200"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="mx-auto h-7 w-7 animate-spin text-brand-orange" aria-hidden />
      <p className="mt-3 font-semibold text-navy-950">
        {phase === 'verifying' ? 'Verifying your fare...' : 'Preparing your booking...'}
      </p>
      <p className="mt-1 text-sm text-neutral-500">
        {phase === 'verifying'
          ? 'Checking the latest airline price for your account.'
          : 'Your selected fare is verified. Opening traveller details now.'}
      </p>
    </div>
  );
}
