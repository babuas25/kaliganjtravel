'use client';

import {
  AlertCircle,
  BriefcaseBusiness,
  Clock,
  Luggage,
  ReceiptText,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import type { PublicBookingAttempt } from '@/lib/flights/booking';
import { formatPrice, type FareBreakdown } from '@/lib/flights/types';

const PASSENGER_LABELS: Record<FareBreakdown['passengerType'], string> = {
  ADT: 'Adult',
  CHD: 'Child (5–11)',
  CNN: 'Child (2–4)',
  INF: 'Infant',
  INS: 'Infant with seat',
};

function SectionHeading({
  title,
  icon: Icon,
}: {
  title: string;
  icon: typeof ReceiptText;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <h2 className="text-sm font-bold text-navy-950">{title}</h2>
    </div>
  );
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * How long the held quote stays valid.
 *
 * Counts against the draft's own `expiresAt` rather than a duration, so a
 * reload or a slow form does not hand the customer more time than the fare has.
 * The booking route rejects a draft past this moment, so the form uses the same
 * value to stop offering a booking that would only fail.
 */
export function useOfferExpiry(expiresAt: string): {
  remainingMs: number;
  expired: boolean;
  known: boolean;
} {
  const deadline = Date.parse(expiresAt);
  const known = Number.isFinite(deadline);
  const [remainingMs, setRemainingMs] = useState(() =>
    known ? Math.max(0, deadline - Date.now()) : 0
  );

  useEffect(() => {
    if (!known) return;
    setRemainingMs(Math.max(0, deadline - Date.now()));
    const tick = window.setInterval(() => {
      setRemainingMs(Math.max(0, deadline - Date.now()));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [deadline, known]);

  return { remainingMs, expired: known && remainingMs <= 0, known };
}

function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const { remainingMs, expired, known } = useOfferExpiry(expiresAt);

  if (!known) return null;

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  // The bar is drawn against the draft's own 15-minute lifetime.
  const fraction = Math.max(0, Math.min(1, remainingMs / (15 * 60_000)));

  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-neutral-200">
      <div className="flex items-center gap-2 text-navy-950">
        <Clock className="h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
        <span className="text-xs font-semibold">
          {expired ? 'This offer has expired' : 'This offer expires in'}
        </span>
      </div>
      <p
        className={`mt-2 text-center text-3xl font-bold tabular-nums ${
          expired ? 'text-neutral-400' : 'text-navy-950'
        }`}
        role="timer"
        aria-live="off"
      >
        {twoDigits(minutes)}:{twoDigits(seconds)}
      </p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-200">
        <div
          className="h-full bg-brand-orange transition-all duration-1000"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {expired && (
        <p className="mt-2 text-xs text-neutral-600">
          Search again to price this trip.
        </p>
      )}
    </section>
  );
}

function FareRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
      <span className="font-medium text-neutral-500">{label}</span>
      <span className="font-medium tabular-nums text-neutral-700">{value}</span>
    </div>
  );
}

/**
 * The right rail: how long the price lives, what it is made of, and what a
 * change to it would cost later.
 *
 * This is the first screen that shows AIT/VAT. The search results deliberately
 * quote the Gross Amount without it — see MARKUP.md — so the itemised rows and
 * the Grand Total Payable below only ever appear from checkout onwards.
 */
export default function CheckoutSummary({
  attempt,
  errors,
  actions,
}: {
  attempt: PublicBookingAttempt;
  errors: string[];
  /** Confirm/back controls, which the review step puts beside the total. */
  actions?: ReactNode;
}) {
  const fares = attempt.fares;
  const totalAit = fares.reduce((sum, fare) => sum + fare.ait, 0);
  const legs = attempt.itinerary?.legs ?? [];

  return (
    <aside className="w-full shrink-0 space-y-3 lg:sticky lg:top-4 lg:w-[320px]">
      <OfferCountdown expiresAt={attempt.expiresAt} />

      <section className="rounded-lg bg-white p-4 ring-1 ring-neutral-200">
        <SectionHeading title="Fare Summary" icon={ReceiptText} />
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          {attempt.currency}
        </p>

        <div className="mt-3 space-y-3">
          {fares.length > 0 ? (
            <div className="space-y-2">
              {fares.map((fare) => (
                <div
                  key={fare.passengerType}
                  className="rounded-lg bg-navy-50/70 px-3 py-2.5 ring-1 ring-neutral-200"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-neutral-200 pb-1.5">
                    <span className="text-[11px] font-medium text-neutral-500">
                      Passenger Type
                    </span>
                    <span className="text-[13px] font-semibold text-navy-950">
                      {PASSENGER_LABELS[fare.passengerType]}
                    </span>
                  </div>
                  <FareRow
                    label="Base Fare"
                    value={fare.basePrice.toLocaleString('en-US')}
                  />
                  <FareRow
                    label="Tax"
                    value={fare.taxes.toLocaleString('en-US')}
                  />
                  {fare.serviceMargin > 0 && (
                    <FareRow
                      label="Service margin"
                      value={fare.serviceMargin.toLocaleString('en-US')}
                    />
                  )}
                  <FareRow
                    label="AIT / VAT"
                    value={fare.ait.toLocaleString('en-US')}
                  />
                  <FareRow
                    label="Pax Count"
                    value={fare.count.toLocaleString('en-US')}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 border-t border-neutral-200 pt-1.5">
                    <span className="text-[11px] font-semibold text-neutral-500">
                      Amount
                    </span>
                    <span className="text-sm font-bold tabular-nums text-navy-950">
                      {formatPrice(fare.totalPrice, attempt.currency)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-neutral-500">
              A per-passenger breakdown is not available for this fare.
            </p>
          )}

          {totalAit > 0 && (
            <div className="flex justify-between text-xs text-neutral-600">
              <span>Includes AIT / VAT</span>
              <span className="font-semibold tabular-nums">
                {formatPrice(totalAit, attempt.currency)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between border-t-2 border-brand-orange/30 pt-2">
            <span className="text-sm font-semibold text-navy-950">
              Grand Total Payable
            </span>
            <span className="text-lg font-bold text-brand-orange-dark">
              {formatPrice(attempt.totalPrice, attempt.currency)}
            </span>
          </div>

          {actions}
        </div>
      </section>

      {legs.length > 0 && (
        <section className="rounded-lg bg-white p-4 ring-1 ring-neutral-200">
          <SectionHeading title="Baggage" icon={Luggage} />
          <div className="mt-3 space-y-2">
            {legs.map((leg, index) => {
              // The supplier quotes an allowance per segment; the first one
              // covers the sector, which is the granularity a customer reads.
              const segment = leg.segments[0];
              return (
                <div
                  key={`${leg.from}-${leg.to}-${index}`}
                  className="rounded-lg bg-navy-50/70 p-3 ring-1 ring-neutral-200"
                >
                  <p className="text-xs font-semibold text-navy-950">
                    {leg.from} → {leg.to}
                  </p>
                  <div className="mt-1.5 flex justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-neutral-500">
                      <Luggage className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      Check-in
                    </span>
                    <span className="font-medium text-neutral-700">
                      {segment?.baggage || '--'}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-neutral-500">
                      <BriefcaseBusiness
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      />
                      Cabin
                    </span>
                    <span className="font-medium text-neutral-700">
                      {segment?.handBaggage || '--'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            Allowance per passenger, as published by the airline.
          </p>
        </section>
      )}

      {errors.length > 0 && (
        <section
          className="rounded-lg bg-red-50 p-4 ring-1 ring-red-200"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
              aria-hidden
            />
            <div className="min-w-0">
              <h2 className="mb-2 text-sm font-semibold text-red-800">
                Please complete the following:
              </h2>
              <ul className="list-inside list-disc space-y-1 text-xs text-red-700">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </aside>
  );
}
