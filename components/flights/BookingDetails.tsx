'use client';

import styles from './BookingDetails.module.css';

import { BookingDeadlineNotice } from '@/components/flights/BookingDeadlineNotice';
import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import {
  BadgeCheck,
  Check,
  Copy,
  Mail,
  MapPin,
  Plane,
  PlaneTakeoff,
  Phone,
  ReceiptText,
  Ticket,
  Users,
} from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import AirlineLogo from '@/components/flights/AirlineLogo';
import BookingActions from '@/components/flights/BookingActions';
import type { LocalTimeLimitContext } from '@/lib/booking-lifecycle/local-time-limit';
import CheckoutStepper from '@/components/flights/CheckoutStepper';
import {
  BOOKING_CONTACT_DEFAULTS,
  type BookingPassengerType,
  type BookingTraveller,
  type PublicBooking,
} from '@/lib/flights/booking';
import { BOOKING_STATUS_LABELS } from '@/lib/flights/booking-status';
import { countryName } from '@/lib/flights/countries';
import {
  ticketManagementRequestHref,
  ticketManagementRequestLabel,
} from '@/lib/ticket-management/request-link';
import type {
  TicketManagementAction,
  TicketManagementRequestReference,
} from '@/lib/ticket-management/types';
import {
  dateOf,
  fareClassLabel,
  formatDuration,
  formatPrice,
  legDurationMinutes,
  minutesBetween,
  operatingCarrierLabel,
  timeOf,
  type FareBreakdown,
  type ItineraryLeg,
  type ItinerarySegment,
} from '@/lib/flights/types';

const LABELS: Record<BookingPassengerType, string> = {
  ADT: 'Adult',
  CHD: 'Child',
  CNN: 'Child',
  INF: 'Infant',
  INS: 'Infant with seat',
};

/**
 * Two shared surfaces, so every framed thing on the page agrees.
 *
 * `navy-950/10` rather than a neutral grey: this document is navy and red
 * throughout, and a grey hairline against a navy tint reads as a different
 * material.
 */
const HAIRLINE = 'border-navy-950/10';
const FRAME = 'overflow-hidden rounded-md ring-1 ring-navy-950/10';

/**
 * Resolves the fare that belongs to one named passenger.
 *
 * Stored supplier snapshots can contain either one fare row per passenger or
 * one row whose `count` covers every passenger of that type. Expanding each
 * row into per-passenger slots makes the individual print copy correct for
 * both shapes without changing the all-passenger fare table.
 */
function individualPassengerFare(
  fares: readonly FareBreakdown[],
  travellers: readonly BookingTraveller[],
  passengerIndex: number
): FareBreakdown | null {
  const traveller = travellers[passengerIndex];
  if (!traveller) return null;

  const typeOccurrence = travellers
    .slice(0, passengerIndex)
    .filter((candidate) => candidate.passengerType === traveller.passengerType)
    .length;
  let fareSlot = 0;

  for (const fare of fares) {
    if (fare.passengerType !== traveller.passengerType) continue;
    const count = Math.max(1, Math.trunc(fare.count));
    if (typeOccurrence < fareSlot + count) {
      return {
        ...fare,
        count: 1,
        basePrice: fare.basePrice / count,
        taxes: fare.taxes / count,
        ait: fare.ait / count,
        serviceMargin: fare.serviceMargin / count,
        totalPrice: fare.totalPrice / count,
      };
    }
    fareSlot += count;
  }

  return null;
}

const shortDateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const activityFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Dhaka',
});

/** `"2026-09-04 07:30:00"` → `"Fri, 4 Sep 2026"`, for a leg's own headline. */
function formatLongDate(stamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
  if (!match) return '';
  return shortDateFormatter.format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  );
}

/** An unambiguous business timestamp in the agency's Bangladesh timezone. */
function formatActivity(value: string | null | undefined): string {
  if (!value) return '--';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? activityFormatter.format(new Date(parsed))
    : '--';
}

const PAYMENT_LABELS: Record<PublicBooking['paymentState'], string> = {
  unpaid: 'Unpaid',
  held: 'Held',
  captured: 'Paid',
  released: 'Released',
  reconciliation: 'Reconciliation',
  'partially-refunded': 'Partially refunded',
  refunded: 'Refunded',
};

const STATUS_BADGE_COLORS: Record<PublicBooking['status'], string> = {
  'on-hold': '#F59E0B',
  pending: '#FACC15',
  'in-progress': '#3B82F6',
  confirmed: '#16A34A',
  expired: '#6B7280',
  unconfirmed: '#F97316',
  cancelled: '#DC2626',
};

/** Whole calendar days between two supplier stamps — the `+1` on an arrival. */
function dayShift(from: string, to: string): number {
  const start = dateOf(from);
  const end = dateOf(to);
  if (!start || !end) return 0;
  const diff =
    Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : 0;
}

/** `"1985-04-02"` → `"2 Apr 1985"`, or a dash when nothing was captured. */
function formatDate(value: string | undefined): string {
  if (!value) return '--';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  );
}

/**
 * The ticketing deadline as milliseconds.
 *
 * Takes the instant the server parsed once, not the supplier's zone-less
 * string. The old client-side wall-clock parse silently assumed the viewer sat
 * in Dhaka, which for anyone else was the difference between a hold that looks
 * alive and one that looks already dead.
 */
function deadlineMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `93_784_000` → `"1d 2h 3m"`, or `"02:03:04"` inside the last day. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
}

/** Ticks once a second against the airline's ticketing deadline. */
function useTicketingCountdown(deadlineAt: string | null): {
  /** Whether a deadline exists at all — safe to branch on during SSR. */
  known: boolean;
  /** False until the first client tick; nothing time-based may render before. */
  ready: boolean;
  expired: boolean;
  urgent: boolean;
  label: string;
} {
  const deadline = deadlineMs(deadlineAt);
  // Null until the browser takes over. Seeding this with `Date.now()` would
  // guarantee a hydration mismatch: the server and the client read the clock a
  // second apart and render a different number of seconds remaining.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [deadline]);

  if (deadline === null || now === null) {
    return {
      known: deadline !== null,
      ready: false,
      expired: false,
      urgent: false,
      label: '',
    };
  }
  const remaining = Math.max(0, deadline - now);
  return {
    known: true,
    ready: true,
    expired: remaining <= 0,
    // Under three hours the hold is close enough to the wire that the customer
    // needs to read it as a warning rather than as a fact.
    urgent: remaining > 0 && remaining <= 3 * 3_600_000,
    label: formatRemaining(remaining),
  };
}

/**
 * `"International · Multi-city"`.
 *
 * Both halves are derived rather than stored: the server already decided
 * whether the trip leaves the country when it set `passportRequired`, and the
 * legs say whether the second one simply retraces the first.
 */
function tripSummary(booking: PublicBooking): [string, string] {
  const legs = booking.itinerary?.legs ?? [];
  const scope = booking.passportRequired ? 'International' : 'Domestic';
  if (legs.length === 0) return ['Trip', scope];
  if (legs.length === 1) return ['Trip - One-way', scope];
  const returns =
    legs.length === 2 &&
    legs[0].from === legs[1].to &&
    legs[0].to === legs[1].from;
  return [returns ? 'Trip - Round' : 'Trip - Multi-city', scope];
}

function passengerTotal(
  counts: PublicBooking['passengerCounts']
): number {
  return Object.values(counts).reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0
  );
}

/** A titled band of the document, in the house all-caps style. */
function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Users;
  children: ReactNode;
}) {
  return (
    <section className={`${styles.section} border-t px-4 py-3.5 sm:px-5 ${HAIRLINE}`}>
      <div className="mb-2.5 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-navy-950">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

/** A table's own header row — one style for the two tables below. */
function HeadCell({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-navy-950/50 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

/**
 * The compact inline idiom: a hushed label and its value on one line.
 *
 * Used wherever a fact is worth stating but not worth a row of its own — the
 * strip under a flight, the identity line under a passenger's name, the note
 * under the fare table.
 */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap">
      {label}{' '}
      <span className="font-semibold text-navy-950">{value}</span>
    </span>
  );
}

/** A label above its value, for the reference grid. */
function Field({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-navy-950/50">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-[12.5px] font-bold leading-snug text-navy-950 ${
          wrap ? 'break-words' : 'truncate'
        }`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function HeaderLogo({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-navy-950/10">
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${name} logo`}
          className="h-full w-full object-contain p-1"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-sm font-black tracking-wide text-navy-900">
          {initials}
        </span>
      )}
    </div>
  );
}

function DocumentHeader({
  booking,
  ticketed,
  ticketManagementReferences,
  allowTicketingTimeRefresh,
  supplierActionBusy,
  onTicketingTimeRefreshChange,
}: {
  booking: PublicBooking;
  ticketed: boolean;
  ticketManagementReferences: TicketManagementRequestReference[];
  allowTicketingTimeRefresh: boolean;
  supplierActionBusy: boolean;
  onTicketingTimeRefreshChange: (refreshing: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const activity =
    booking.status === 'confirmed'
      ? ['Issued at', booking.issuedAt]
      : booking.status === 'cancelled'
        ? ['Cancelled at', booking.cancelledAt]
        : booking.status === 'expired'
          ? ['Expired at', booking.ticketingDeadlineAt]
          : booking.status === 'in-progress'
            ? ['Processing since', booking.processingSince]
            : ['Booked at', booking.bookedAt];
  const trip = tripSummary(booking);

  const copyReference = async () => {
    if (!booking.publicRef) return;
    try {
      await navigator.clipboard.writeText(booking.publicRef);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard is no loss: the PNR is on screen.
    }
  };

  return (
    <header className={styles.header}>
      <div className={`${styles.masthead} flex flex-col gap-3 border-t-4 border-brand-orange bg-brand-orange p-4 text-black sm:flex-row sm:items-start sm:justify-between`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="shrink-0 text-center">
              <HeaderLogo
                name={booking.headerContact.name}
                url={booking.headerContact.logoUrl}
              />

            </div>
            <div className="min-w-0">
              <p className={`${styles.agencyName} text-lg font-bold leading-tight`}>
                {booking.headerContact.name}
              </p>
              <p className="mt-0.5 text-[11px] font-medium leading-4 text-black">
                {ticketed
                  ? 'Electronic ticket — carry a copy while travelling.'
                  : 'Booking confirmation — seats held with the airline.'}
              </p>
              <p className={styles.license}>License No: {booking.headerContact.licenseNo || '--'}</p>
            </div>
          </div>
          <div className={`${styles.contact} mt-2.5 space-y-1 rounded-md bg-white/20 px-2.5 py-1.5 text-[11px] font-medium leading-4 text-black ring-1 ring-black/10`}>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <p className="flex items-start gap-2 whitespace-nowrap">
                <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black" aria-hidden />
                <span>{booking.headerContact.mobile}</span>
              </p>
              <p className="flex min-w-0 items-start gap-2">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black" aria-hidden />
                <span className="break-all">{booking.headerContact.email}</span>
              </p>
            </div>
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black" aria-hidden />
              <span className="max-w-xl">{booking.headerContact.address}</span>
            </p>
          </div>
        </div>

        <div className={`${styles.reference} shrink-0 sm:w-[18rem] sm:text-right`}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-black">
            Booking reference
          </p>
          <div className="mt-1 flex items-center gap-2 sm:justify-end">
            <span className="text-[13px] font-bold tracking-wide sm:text-sm">
              {booking.publicRef}
            </span>
            {booking.publicRef && (
              <button
                type="button"
                onClick={() => void copyReference()}
                aria-label="Copy booking reference"
                className="rounded p-1 text-black transition hover:bg-white/15 hover:text-black"
              >
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
              </button>
            )}
          </div>
          {ticketManagementReferences.length > 0 && (
            <div className="ticket-management-reference-screen-only mt-2 space-y-0.5 text-[10px] font-semibold leading-4 text-black sm:text-right">
              {ticketManagementReferences.map((reference) => (
                <p key={reference.publicRef}>
                  {ticketManagementRequestLabel(reference)}{' '}
                  <a
                    href={ticketManagementRequestHref(reference)}
                    className="underline decoration-black/40 underline-offset-2 transition hover:text-black hover:decoration-black"
                  >
                    {reference.publicRef}
                  </a>
                </p>
              ))}
            </div>
          )}
          <span
            className={`${styles.status} mt-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-black`}
            style={{ backgroundColor: `${STATUS_BADGE_COLORS[booking.status]}18`, color: STATUS_BADGE_COLORS[booking.status], border: `1px solid ${STATUS_BADGE_COLORS[booking.status]}40` }}
          >
            {ticketed ? (
              <Ticket className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            )}
            {BOOKING_STATUS_LABELS[booking.status]}
          </span>
          {booking.statusMessage && (
            <p className="mt-1 max-w-[18rem] text-[11px] leading-snug text-black sm:ml-auto">
              {booking.statusMessage}
            </p>
          )}
          {(booking.status === 'on-hold' || allowTicketingTimeRefresh) && (
            <BookingDeadlineNotice
              key={booking.publicRef}
              deadline={booking.ticketingDeadlineAt}
              bookingReference={booking.publicRef}
              allowRefresh={allowTicketingTimeRefresh}
              disabled={supplierActionBusy}
              onRefreshingChange={onTicketingTimeRefreshChange}
            />
          )}
        </div>
      </div>

      <div className={`${styles.summary} booking-summary-grid grid border-t border-orange-200 bg-brand-orange-light text-navy-950 sm:grid-cols-2 lg:grid-cols-4`}>
        {(
          [
            [
              'Airline PNR',
              validAirlinePnrs(booking.airlinesPnr).join(', ') || 'Not available',
              false,
            ],
            [trip[0], trip[1], false],
            [activity[0], formatActivity(activity[1]), false],
            ['Payment', PAYMENT_LABELS[booking.paymentState], false],
          ] as [string, string, boolean][]
        ).map(([label, value], index) => (
          <div
            key={label}
            className={`px-4 py-2.5 sm:px-5 ${
              index > 0 ? 'border-t border-orange-200 sm:border-t-0' : ''
            } ${index % 2 === 1 ? 'sm:border-l sm:border-orange-200' : ''} ${
              index >= 2 ? 'sm:border-t sm:border-orange-200 lg:border-t-0' : ''
            } ${index === 2 ? 'lg:border-l lg:border-orange-200' : ''} ${
              index === 3 ? 'lg:border-l lg:border-orange-200' : ''
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-navy-950/55">
              {label}
            </p>
            {/* Wraps rather than truncates: "International · Multi-city" and a
                full deadline both outrun a quarter-width cell, and half a trip
                type tells the customer nothing. */}
            <p className="mt-0.5 text-sm font-bold leading-snug" title={value}>
              {value}
            </p>
          </div>
        ))}
      </div>
    </header>
  );
}

/** One end of a flight: the clock, code, terminal, date, and airport. */
function Terminus({
  time,
  code,
  airport,
  terminal,
  date,
  plusDays = 0,
  align = 'left',
}: {
  time: string;
  code: string;
  airport: string;
  terminal?: string | null;
  date: string;
  plusDays?: number;
  align?: 'left' | 'right';
}) {
  return (
    <div
      className={`${styles.terminus} min-w-0 flex-1 basis-0 ${align === 'right' ? 'text-right' : ''}`}
    >
      <p className="text-xl font-bold leading-none tabular-nums text-navy-950 sm:text-2xl">
        {time || '--:--'}
        {plusDays > 0 && (
          <sup className="ml-0.5 align-top text-[10px] font-bold text-brand-orange">
            +{plusDays}
          </sup>
        )}
      </p>
      <p className="mt-1.5 text-[13px] font-bold leading-none text-navy-950">
        {code}
      </p>
      {terminal !== null && terminal !== undefined && terminal !== '' && (
        <p className="mt-1 text-[11px] font-medium leading-none text-neutral-500">
          Terminal {terminal}
        </p>
      )}
      {date && <p className="mt-1 text-[11px] text-neutral-500">{date}</p>}
      {airport && (
        // Clamped because "Hazrat Shahjalal International Airport" is four
        // lines in a third of a phone screen, and the airport name is the one
        // thing on this row the traveller already knows.
        <p
          className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-400"
          title={airport}
        >
          {airport}
        </p>
      )}
    </div>
  );
}

/**
 * One flight inside its leg's frame: who operates it, the two ends of it, and
 * a single strip carrying everything else the supplier said about it.
 *
 * That strip is where the baggage allowance lives now. It belongs to the
 * flight rather than to the route — a connection can change carrier and
 * allowance halfway — and inline it costs one line instead of a section.
 */
function SegmentBlock({
  segment,
  position,
  total,
  first,
}: {
  segment: ItinerarySegment;
  position: number;
  total: number;
  first: boolean;
}) {
  const overnight = dayShift(segment.departure, segment.arrival);
  const facts: [string, string][] = (
    [
      ['Check-in', segment.baggage ?? ''],
      ['Cabin bag', segment.handBaggage ?? ''],
      ['Aircraft', segment.aircraft ?? ''],
      ['RBD', segment.bookingClass ?? ''],
    ] as [string, string][]
  ).filter(([, value]) => value.trim() !== '');

  return (
    <>
      <div
        className={`${styles.carrier} flex items-center justify-between gap-3 bg-neutral-50 px-3 py-2 ${
          first ? '' : `border-t ${HAIRLINE}`
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AirlineLogo airlineCode={segment.airlineCode} size={22} />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-bold leading-tight text-navy-950">
              {segment.airline || segment.airlineCode}
            </p>
            <p className="truncate text-[11px] leading-tight text-neutral-500">
              Flight {segment.airlineCode}
              {segment.flightNumber}
              {segment.cabinClass ? ` · ${segment.cabinClass}` : ''}
            </p>
            {operatingCarrierLabel(segment) && (
              <p className="mt-1 text-[11px] leading-tight text-neutral-600">{operatingCarrierLabel(segment)}</p>
            )}
          </div>
        </div>
        {total > 1 && (
          <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-navy-950 ring-1 ring-navy-950/10">
            Flight {position} of {total}
          </span>
        )}
      </div>

      <div className={`${styles.journey} flex items-start gap-3 px-3 py-3`}>
        <Terminus
          time={timeOf(segment.departure)}
          code={segment.from}
          airport={segment.fromAirport}
          terminal={segment.departureTerminal}
          date={formatDate(dateOf(segment.departure))}
        />

        <div className="flex min-w-[4.5rem] flex-1 basis-0 flex-col items-center pt-1">
          {segment.duration && (
            <span className="text-[11px] text-neutral-500">
              {segment.duration}
            </span>
          )}
          <span className="mt-1 flex w-full items-center gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-navy-950/40 bg-white" />
            <span className="h-px flex-1 bg-navy-950/20" />
            <Plane className="h-3.5 w-3.5 shrink-0 rotate-90 text-brand-orange/60" />
            <span className="h-px flex-1 bg-navy-950/20" />
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-navy-950/40" />
          </span>
        </div>

        <Terminus
          time={timeOf(segment.arrival)}
          code={segment.to}
          airport={segment.toAirport}
          terminal={segment.arrivalTerminal}
          date={formatDate(dateOf(segment.arrival))}
          plusDays={overnight}
          align="right"
        />
      </div>

      {facts.length > 0 && (
        <p
          className={`${styles.baggage} flex flex-wrap gap-x-4 gap-y-1 border-t bg-neutral-50/50 px-3 py-1.5 text-[11px] text-neutral-500 ${HAIRLINE}`}
        >
          {facts.map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
        </p>
      )}
    </>
  );
}

/** A requested route: a one-line headline, then its flights in one frame. */
function LegBlock({
  leg,
  index,
  numbered,
  segmentOffset,
  segmentTotal,
}: {
  leg: ItineraryLeg;
  index: number;
  numbered: boolean;
  /** Flights already listed above this leg, so the counters run trip-wide. */
  segmentOffset: number;
  segmentTotal: number;
}) {
  const minutes = legDurationMinutes(leg);
  const stops = Math.max(leg.stops, leg.segments.length - 1);
  const summary = [
    formatLongDate(leg.departure),
    minutes !== null ? formatDuration(minutes) : '',
    stops <= 0 ? 'Non-stop' : stops === 1 ? '1 stop' : `${stops} stops`,
  ].filter(Boolean);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="flex items-center gap-2">
          {numbered && (
            <span className="rounded bg-brand-orange px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
              Leg {index + 1}
            </span>
          )}
          <span className="text-[13px] font-bold text-navy-950">
            {leg.from} <span className="text-navy-950/30">→</span> {leg.to}
          </span>
        </h3>
        <p className="text-[11px] text-neutral-500">{summary.join(' · ')}</p>
      </div>

      <div className={`${styles.flight} ${FRAME}`}>
        {leg.segments.map((segment, position) => {
          const previous = position > 0 ? leg.segments[position - 1] : null;
          const layover = previous
            ? minutesBetween(previous.arrival, segment.departure)
            : null;

          return (
            <Fragment
              key={`${segment.airlineCode}${segment.flightNumber}-${position}`}
            >
              {layover !== null && layover > 0 && (
                <p
                  className={`border-t bg-white px-3 py-1.5 text-center text-[11px] font-medium text-neutral-500 ${HAIRLINE}`}
                >
                  {formatDuration(layover)} layover in {segment.from}
                </p>
              )}
              <SegmentBlock
                segment={segment}
                position={segmentOffset + position + 1}
                total={segmentTotal}
                first={position === 0}
              />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Everything the customer gets after a successful Book call, laid out as the
 * booking document itself rather than as a stack of checkout cards.
 *
 * The successful checkout supplies these values directly; the dashboard detail
 * route reads the same booking and passenger snapshot back from storage.
 */
export default function BookingDetails({
  booking,
  travellers,
  showStepper = true,
  passengerPrivacyNotice,
  allowCancellation = true,
  allowSupplierRefresh = false,
  allowTicketingTimeRefresh = false,
  autoRefreshDeadline = false,
  allowTicketing = true,
  showPostTicketActions = false,
  allowPostTicketOwnerActions = false,
  allowedPostTicketActions = [],
  issuingForAssignedOwner = false,
  allowImportedConfirmation = false,
  allowImportedSync = false,
  importedBooking = false,
  manualBooking = false,
  localTimeLimit = null,
  allowLocalTimeLimitRequest = false,
  allowSmsShare = false,
  ticketManagementReferences = [],
  sidebarContent,
}: {
  booking: PublicBooking;
  travellers: BookingTraveller[];
  showStepper?: boolean;
  passengerPrivacyNotice?: string;
  allowCancellation?: boolean;
  allowSupplierRefresh?: boolean;
  allowTicketingTimeRefresh?: boolean;
  autoRefreshDeadline?: boolean;
  allowTicketing?: boolean;
  showPostTicketActions?: boolean;
  allowPostTicketOwnerActions?: boolean;
  allowedPostTicketActions?: readonly TicketManagementAction[];
  issuingForAssignedOwner?: boolean;
  allowImportedConfirmation?: boolean;
  allowImportedSync?: boolean;
  importedBooking?: boolean;
  manualBooking?: boolean;
  localTimeLimit?: LocalTimeLimitContext | null;
  allowLocalTimeLimitRequest?: boolean;
  /** Manual B2B-partner SMS sharing for agency users and authorised staff. */
  allowSmsShare?: boolean;
  /** On-screen action references; deliberately excluded from print/email copies. */
  ticketManagementReferences?: TicketManagementRequestReference[];
  /** Optional staff-only content displayed below the quick actions card. */
  sidebarContent?: ReactNode;
}) {
  const [refreshingTicketingTime, setRefreshingTicketingTime] = useState(false);
  const [supplierActionBusy, setSupplierActionBusy] = useState(false);
  const ticketed = booking.status === 'confirmed';
  const footerEmail = booking.headerContact.email.trim() &&
    booking.headerContact.email !== '--'
    ? booking.headerContact.email
    : BOOKING_CONTACT_DEFAULTS.email;
  const passportRequired = booking.passportRequired !== false;
  const legs = booking.itinerary?.legs ?? [];
  const segmentTotal = legs.reduce((sum, leg) => sum + leg.segments.length, 0);

  const namedTravellers = travellers.filter(
    (traveller) => traveller.lastName.trim() !== ''
  );
  const passengerMix = (
    Object.entries(booking.passengerCounts) as [BookingPassengerType, number][]
  ).filter(([, count]) => count > 0);

  // The supplier returns a flat list of ticket numbers with no passenger key.
  // Pairing them by position is only safe when the counts line up exactly;
  // otherwise they stay in the references section, unattributed.
  const ticketsAlign =
    booking.ticketNumbers.length > 0 &&
    booking.ticketNumbers.length === namedTravellers.length;

  const totalAit = booking.fares.reduce((sum, fare) => sum + fare.ait, 0);
  const hasMargin = booking.fares.some((fare) => fare.serviceMargin > 0);
  const individualFares = namedTravellers.map((_, index) =>
    individualPassengerFare(booking.fares, namedTravellers, index)
  );

  const carrier = booking.itinerary
    ? booking.itinerary.carrierName && booking.itinerary.carrierCode
      ? `${booking.itinerary.carrierName} (${booking.itinerary.carrierCode})`
      : booking.itinerary.carrierName || booking.itinerary.carrierCode
    : '';

  const fareNotes: [string, string][] = [
    ['Fare type', booking.directTicketing ? 'Instant ticketing' : 'Hold'],
    ['Refundable', booking.itinerary?.refundable ? 'Yes' : 'No'],
    ...(carrier ? ([['Validating carrier', carrier]] as [string, string][]) : []),
  ];

  return (
    <div className="space-y-4">
      {showStepper && <CheckoutStepper activeIndex={2} complete />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start lg:gap-6">
        <article className={`${styles.ticket} booking-print-document min-w-0 bg-white ${FRAME}`}>
          <DocumentHeader
            booking={booking}
            ticketed={ticketed}
            ticketManagementReferences={ticketManagementReferences}
            allowTicketingTimeRefresh={allowTicketingTimeRefresh}
            supplierActionBusy={supplierActionBusy}
            onTicketingTimeRefreshChange={setRefreshingTicketingTime}
          />

          <Section title="Passenger & Ticket Details" icon={Users}>
            {namedTravellers.length > 0 ? (
              <div className={`overflow-x-auto ${FRAME}`}>
                <table className="w-full min-w-[34rem] border-collapse text-left">
                  <thead>
                    <tr className="bg-neutral-50">
                      <HeadCell>Passenger</HeadCell>
                      <HeadCell>Type</HeadCell>
                      <HeadCell>Gender</HeadCell>
                      <HeadCell>Date of birth</HeadCell>
                      {ticketsAlign && <HeadCell align="right">Ticket number</HeadCell>}
                    </tr>
                  </thead>
                  {/* Uppercased wholesale, the way a carrier prints a
                      manifest: these values are transcribed against a passport
                      at the counter, and the case they were typed in during
                      checkout is noise against that. */}
                  <tbody className="uppercase">
                    {namedTravellers.map((traveller, index) => {
                      const name =
                        [traveller.title, traveller.firstName, traveller.lastName]
                          .filter(Boolean)
                          .join(' ') || `Passenger ${index + 1}`;
                      const identity: [string, string][] = [
                        [
                          'Nationality',
                          traveller.nationality
                            ? countryName(traveller.nationality)
                            : '--',
                        ],
                        ...(passportRequired
                          ? ([
                              ['Passport', traveller.passportNumber || '--'],
                              [
                                'Issued by',
                                traveller.issuingCountry
                                  ? countryName(traveller.issuingCountry)
                                  : '--',
                              ],
                              [
                                'Expiry',
                                formatDate(traveller.passportExpiry),
                              ],
                            ] as [string, string][])
                          : []),
                      ];

                      return (
                        <tr
                          key={`${traveller.passengerType}-${index}`}
                          data-print-passenger-index={index}
                          className={`border-t align-top ${HAIRLINE}`}
                        >
                          <td className="px-3 py-2.5">
                            <p className="text-[13px] font-bold leading-tight text-navy-950">
                              {name}
                            </p>
                            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-neutral-500">
                              {identity.map(([label, value]) => (
                                <Fact
                                  key={label}
                                  label={label}
                                  value={value}
                                />
                              ))}
                            </p>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-[12px] font-semibold text-navy-950">
                            {LABELS[traveller.passengerType]}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-neutral-600">
                            {traveller.gender}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-neutral-600">
                            {formatDate(traveller.dateOfBirth)}
                          </td>
                          {ticketsAlign && (
                            <td className="whitespace-nowrap px-3 py-2.5 text-right text-[12px] font-semibold tabular-nums text-navy-950">
                              {booking.ticketNumbers[index]}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={`px-3 py-2.5 ${FRAME}`}>
                <p className="text-[13px] font-bold text-navy-950">
                  Booked for{' '}
                  {passengerMix
                    .map(
                      ([type, count]) =>
                        `${count} ${LABELS[type]}${count > 1 ? 's' : ''}`
                    )
                    .join(', ')}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
                  {passengerPrivacyNotice ??
                    'Names are not shown after a reload — quote the booking reference and we can read them back to you.'}
                </p>
              </div>
            )}
          </Section>

          {legs.length > 0 && (
            <Section title="Flight Itinerary" icon={PlaneTakeoff}>
              {booking.itinerary?.codeshare === true && (
                <p className="px-3 py-2 text-xs font-medium text-navy-950">Includes codeshare flights</p>
              )}
              <div className="space-y-3">
                {legs.map((leg, index) => (
                  <LegBlock
                    key={`${leg.from}-${leg.to}-${index}`}
                    leg={leg}
                    index={index}
                    numbered={legs.length > 1}
                    segmentOffset={legs
                      .slice(0, index)
                      .reduce((sum, prior) => sum + prior.segments.length, 0)}
                    segmentTotal={segmentTotal}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-neutral-400">
                Times are local to each airport. Baggage allowance is per
                passenger, as published by the airline.
              </p>
            </Section>
          )}

          <div className="booking-fare-section">
          <Section title="Fare Breakdown" icon={ReceiptText}>
            <div className={`overflow-x-auto ${FRAME}`}>
              <table className="w-full min-w-[32rem] border-collapse text-left">
                <thead>
                  <tr className="bg-neutral-50">
                    <HeadCell>Passenger type</HeadCell>
                    <HeadCell align="right">Pax</HeadCell>
                    <HeadCell align="right">Base fare</HeadCell>
                    <HeadCell align="right">Tax &amp; other</HeadCell>
                    {hasMargin && <HeadCell align="right">Service margin</HeadCell>}
                    <HeadCell align="right">AIT / VAT</HeadCell>
                    <HeadCell align="right">Amount</HeadCell>
                  </tr>
                </thead>
                <tbody>
                  {booking.fares.length > 0 ? (
                    booking.fares.map((fare, index) => (
                      <FareRow
                        key={`${fare.passengerType}-${index}`}
                        fare={fare}
                        currency={booking.currency}
                        showMargin={hasMargin}
                        printKind="booking"
                      />
                    ))
                  ) : (
                    <tr className={`border-t ${HAIRLINE}`}>
                      <td
                        colSpan={hasMargin ? 7 : 6}
                        className="px-3 py-2.5 text-[11px] text-neutral-500"
                      >
                        A per-passenger breakdown is not available for this
                        fare.
                      </td>
                    </tr>
                  )}
                  <tr className={`${styles.total} booking-fare-total bg-brand-orange text-navy-950`}>
                    <td
                      colSpan={hasMargin ? 6 : 5}
                      className="px-3 py-2.5 text-[12px] font-bold"
                    >
                      Total price
                      {totalAit > 0 ? ' (incl. AIT / VAT)' : ''}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[15px] font-bold tabular-nums">
                      {formatPrice(booking.totalPrice, booking.currency)}
                    </td>
                  </tr>
                  {individualFares.map((fare, index) =>
                    fare ? (
                      <FareRow
                        key={`individual-${index}`}
                        fare={fare}
                        currency={booking.currency}
                        showMargin={hasMargin}
                        printKind="individual"
                        passengerIndex={index}
                      />
                    ) : null
                  )}
                  {individualFares.map((fare, index) =>
                    fare ? (
                      <tr
                        key={`individual-total-${index}`}
                        data-print-individual-fare-index={index}
                        className={`${styles.total} print-individual-fare-total bg-brand-orange text-navy-950`}
                      >
                        <td
                          colSpan={hasMargin ? 6 : 5}
                          className="px-3 py-2.5 text-[12px] font-bold"
                        >
                          Passenger total
                          {fare.ait > 0 ? ' (incl. AIT / VAT)' : ''}
                        </td>
                        <td className="px-3 py-2.5 text-right text-[15px] font-bold tabular-nums">
                          {formatPrice(fare.totalPrice, booking.currency)}
                        </td>
                      </tr>
                    ) : null
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-neutral-500">
              {fareNotes.map(([label, value]) => (
                <Fact key={label} label={label} value={value} />
              ))}
            </p>
          </Section>
          </div>

          <footer
            className={`flex flex-col gap-1 border-t bg-neutral-50 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${HAIRLINE}`}
          >
            <p className="text-[11px] text-neutral-500">
              System generated document — quote the booking reference in any
              correspondence.
            </p>
            <p className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-navy-950">
              <Mail className="h-3 w-3 text-brand-orange" aria-hidden />
              {footerEmail}
            </p>
          </footer>
        </article>

        <BookingActions
          status={booking.status}
          statusMessage={booking.statusMessage}
          directTicketing={booking.directTicketing}
          allowCancellation={allowCancellation}
          allowSupplierRefresh={allowSupplierRefresh}
          refreshingTicketingTime={refreshingTicketingTime}
          onSupplierActionBusyChange={setSupplierActionBusy}
          autoRefreshDeadline={autoRefreshDeadline}
          allowTicketing={allowTicketing}
          showPostTicketActions={showPostTicketActions}
          allowPostTicketOwnerActions={allowPostTicketOwnerActions}
          allowedPostTicketActions={allowedPostTicketActions}
          issuingForAssignedOwner={issuingForAssignedOwner}
          allowImportedConfirmation={allowImportedConfirmation}
          allowImportedSync={allowImportedSync}
          importedBooking={importedBooking}
          manualBooking={manualBooking}
          paymentState={booking.paymentState}
          localTimeLimit={localTimeLimit}
          allowLocalTimeLimitRequest={allowLocalTimeLimitRequest}
          allowSmsShare={allowSmsShare}
          bookingReference={booking.publicRef}
          ticketingDeadlineAt={booking.ticketingDeadlineAt}
          ticketIssuedAt={booking.issuedAt}
          postTicketRoutes={legs.map((leg, index) => ({
            index,
            id: `leg-${index + 1}`,
            label: legs.length > 1 ? `Route ${index + 1}` : 'Route',
            route: `${leg.from} → ${leg.to}`,
            currentDate: dateOf(leg.departure),
          }))}
          passengerCopies={namedTravellers.map((traveller, index) => ({
            index,
            hasFare: individualFares[index] !== null,
            label:
              [traveller.firstName, traveller.lastName]
                .filter(Boolean)
                .join(' ') || `Passenger ${index + 1}`,
            fileName:
              ticketed && ticketsAlign
                ? booking.ticketNumbers[index]
                : 'Booking Confirmation',
          }))}
        >
          {sidebarContent}
        </BookingActions>
      </div>
    </div>
  );
}

/** One priced passenger type as a row of the fare table. */
function FareRow({
  fare,
  currency,
  showMargin,
  printKind,
  passengerIndex,
}: {
  fare: FareBreakdown;
  currency: string;
  showMargin: boolean;
  printKind: 'booking' | 'individual';
  passengerIndex?: number;
}) {
  const cell = 'px-3 py-2.5 text-right text-[12px] tabular-nums text-neutral-600';

  return (
    <tr
      data-print-booking-fare-row={printKind === 'booking' ? '' : undefined}
      data-print-individual-fare-index={
        printKind === 'individual' ? passengerIndex : undefined
      }
      className={`${printKind === 'individual' ? 'print-individual-fare-row ' : ''}border-t ${HAIRLINE}`}
    >
      <td className="whitespace-nowrap px-3 py-2.5 text-[12.5px] font-bold text-navy-950">
        {LABELS[fare.passengerType]}
      </td>
      <td className={cell}>{fare.count}</td>
      <td className={cell}>{fare.basePrice.toLocaleString('en-US')}</td>
      <td className={cell}>{fare.taxes.toLocaleString('en-US')}</td>
      {showMargin && (
        <td className={cell}>{fare.serviceMargin.toLocaleString('en-US')}</td>
      )}
      <td className={cell}>{fare.ait.toLocaleString('en-US')}</td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right text-[12.5px] font-bold tabular-nums text-navy-950">
        {formatPrice(fare.totalPrice, currency)}
      </td>
    </tr>
  );
}
