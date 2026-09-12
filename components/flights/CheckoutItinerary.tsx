'use client';

import {
  CalendarDays,
  ChevronDown,
  Plane,
  Route,
  Users,
} from 'lucide-react';

import AirlineLogo from '@/components/flights/AirlineLogo';
import type { BookingOffer } from '@/lib/flights/booking';
import {
  dateOf,
  formatDuration,
  formatPrice,
  legDurationMinutes,
  timeOf,
  type ItineraryLeg,
} from '@/lib/flights/types';

const longDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatStamp(stamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOf(stamp));
  if (!match) return dateOf(stamp);
  return longDateFormatter.format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  );
}

function travellerLabel(
  counts: BookingOffer['passengerCounts']
): string {
  const total = Object.values(counts).reduce(
    (sum, count) => sum + (count ?? 0),
    0
  );
  return `${total} ${total === 1 ? 'Passenger' : 'Passengers'}`;
}

function routeLabel(legs: ItineraryLeg[]): string {
  if (legs.length === 0) return '';
  const stops = [legs[0].from, ...legs.map((leg) => leg.to)];
  return stops.join(' → ');
}

/** The green banner's counterpart: route, total and trip facts in Kaliganj navy. */
export function TripSummaryHeader({
  offer,
  onToggleDetails,
  detailsOpen,
  eyebrow = 'Trip Summary',
  subtitle,
}: {
  offer: BookingOffer;
  onToggleDetails: () => void;
  detailsOpen: boolean;
  /** Small label above the route — the step's name. */
  eyebrow?: string;
  /** Replaces the carrier line, for a step that needs to say where it is. */
  subtitle?: string;
}) {
  const legs = offer.itinerary?.legs ?? [];
  const route = routeLabel(legs);

  return (
    <section className="overflow-hidden rounded-lg bg-brand-orange text-black">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/15">
            {offer.itinerary ? (
              <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-white">
                <AirlineLogo
                  airlineCode={offer.itinerary.carrierCode}
                  size={32}
                />
              </span>
            ) : (
              <Plane className="h-7 w-7" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-black">{eyebrow}</p>
            <p className="truncate text-2xl font-bold leading-tight sm:text-3xl">
              {route || 'Your trip'}
            </p>
            {(subtitle || offer.itinerary) && (
              <p className="mt-0.5 text-sm font-semibold text-black">
                {subtitle ?? offer.itinerary?.carrierName}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <div className="text-left sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-wide text-black">
              Grand Total Payable
            </p>
            <p className="text-2xl font-bold leading-tight">
              {formatPrice(offer.totalPrice, offer.currency)}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white/15 px-4 text-sm font-semibold text-black transition hover:bg-white/25"
          >
            <Route className="h-4 w-4" aria-hidden />
            Flight Details
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                detailsOpen ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>
        </div>
      </div>

      <div className="grid border-t border-black/10 sm:grid-cols-3">
        {(
          [
            [Plane, 'Route', route || '--'],
            [CalendarDays, 'Travel date', formatStamp(offer.travelDate)],
            [Users, 'Travellers', travellerLabel(offer.passengerCounts)],
          ] as const
        ).map(([Icon, label, value], index) => (
          <div
            key={label}
            className={`flex items-center gap-3 px-5 py-4 sm:px-6 ${
              index > 0 ? 'border-t border-black/10 sm:border-l sm:border-t-0' : ''
            }`}
          >
            <Icon className="h-4 w-4 shrink-0 text-black" aria-hidden />
            <div className="min-w-0">
              <p className="text-xs text-black">{label}</p>
              <p className="truncate text-sm font-bold">{value}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LegDetail({ leg }: { leg: ItineraryLeg }) {
  const first = leg.segments[0];
  const last = leg.segments[leg.segments.length - 1];
  const minutes = legDurationMinutes(leg);
  const stops = Math.max(leg.stops, leg.segments.length - 1);

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-neutral-500">{leg.from}</p>
          <p className="mt-0.5 truncate text-[11px] text-neutral-500">
            {first.fromAirport}
          </p>
          <p className="mt-1 text-2xl font-bold text-navy-950">
            {timeOf(first.departure)}
          </p>
          <p className="text-[11px] font-medium text-neutral-500">
            {formatStamp(first.departure)}
          </p>
        </div>

        <div className="shrink-0 text-center">
          <p className="text-xs font-semibold text-neutral-700">
            {minutes !== null ? formatDuration(minutes) : leg.duration}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-neutral-400">
            Duration
          </p>
          <Plane
            className="mx-auto my-1 h-4 w-4 rotate-90 text-brand-orange"
            aria-hidden
          />
          <p className="text-xs font-semibold text-brand-orange-dark">
            {stops <= 0 ? 'Direct' : stops === 1 ? '1 stop' : `${stops} stops`}
          </p>
        </div>

        <div className="min-w-0 text-right">
          <p className="text-xs font-semibold text-neutral-500">{leg.to}</p>
          <p className="mt-0.5 truncate text-[11px] text-neutral-500">
            {last.toAirport}
          </p>
          <p className="mt-1 text-2xl font-bold text-navy-950">
            {timeOf(last.arrival)}
          </p>
          <p className="text-[11px] font-medium text-neutral-500">
            {formatStamp(last.arrival)}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Flight numbers, times and airports, straight from the stored offer. */
export function ItineraryPanel({
  offer,
  open,
  onToggle,
  title = 'Itinerary',
}: {
  offer: BookingOffer;
  open: boolean;
  onToggle: () => void;
  title?: string;
}) {
  const legs = offer.itinerary?.legs ?? [];
  const flightNumbers = Array.from(
    new Set(
      legs.flatMap((leg) =>
        leg.segments.map((segment) =>
          `${segment.airlineCode}${segment.flightNumber}`.replace(
            /^([A-Z0-9]{2})\1/,
            '$1'
          )
        )
      )
    )
  ).join(', ');

  if (legs.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4 text-left transition hover:bg-navy-50/60 sm:p-5"
      >
        <span className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
            <Plane className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-bold text-navy-950">{title}</span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-brand-orange transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="border-t border-neutral-200">
          {flightNumbers && (
            <div className="mx-4 border-b border-dashed border-neutral-200 py-3 sm:mx-5">
              <p className="text-sm font-bold text-navy-950">{flightNumbers}</p>
            </div>
          )}
          <div className="divide-y divide-neutral-200">
            {legs.map((leg, index) => (
              <LegDetail key={`${leg.from}-${leg.to}-${index}`} leg={leg} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
