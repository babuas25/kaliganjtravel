'use client';

import {
  AlertCircle,
  AlertTriangle,
  BookOpenCheck,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Info,
  Armchair,
  Loader2,
  Luggage,
  Plane,
  ReceiptText,
  Route,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';

import {
  bookingItinerarySnapshotFor,
  dateOf,
  fareClassLabel,
  formatDuration,
  formatPrice,
  legColumns,
  legDurationMinutes,
  legLabel,
  legLayoverMinutes,
  timeOf,
  type FlightFareOption,
  type FlightFareRulesResult,
  type FlightItinerary,
  type FlightRepriceResult,
  type ItineraryLeg,
} from '@/lib/flights/types';
import { saveBookingSnapshot } from '@/lib/flights/booking-snapshot.client';
import {
  AirlinePolicyDetails,
  BaggageDetails,
  FareDetails,
  ItineraryDetails,
} from '@/components/flights/ItineraryCardDetails';
import AirlineLogo from '@/components/flights/AirlineLogo';
import SendItineraryMenu from '@/components/flights/SendItineraryMenu';
import { itineraryShareOffer } from '@/lib/flights/share-offer';
import { itineraryShareText } from '@/lib/flights/share-text';
import { agencyPayableExceedsGross } from '@/lib/flights/display-pricing';

type RepriceEnvelope =
  | { success: true; data: FlightRepriceResult }
  | {
      success: false;
      error: { errorCode: string; errorMessage: string };
    };

/**
 * RePrice only reads and revalidates a supplier fare; unlike Book or
 * NewTicket, it cannot create a reservation or charge anyone. A second try is
 * therefore safe when the supplier gateway has timed out mid-request.
 */
const REPRICE_ATTEMPTS = 2;
const REPRICE_RETRY_DELAY_MS = 800;

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

type FareRulesEnvelope =
  | { success: true; data: FlightFareRulesResult }
  | {
      success: false;
      error: { errorCode: string; errorMessage: string };
    };

type FareRulesState =
  | {
      status: 'loading';
      rules: FlightFareRulesResult['rules'];
      error: null;
    }
  | { status: 'success'; rules: FlightFareRulesResult['rules']; error: null }
  | {
      status: 'error';
      rules: FlightFareRulesResult['rules'];
      error: string;
    };

type CardPanel =
  | 'itinerary'
  | 'fare'
  | 'baggage'
  | 'policies';

/** Supplier-authoritative total travel time, with defensive legacy fallbacks. */
function legDuration(leg: ItineraryLeg): string | null {
  const minutes = legDurationMinutes(leg);
  return minutes !== null ? formatDuration(minutes) : leg.duration;
}

function stopsLabel(leg: ItineraryLeg): string {
  const stops = Math.max(leg.stops, leg.segments.length - 1);
  if (stops <= 0) return 'Non-stop';
  return stops === 1 ? '1 stop' : `${stops} stops`;
}

const flightDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Side-by-side legs have no room for "Tuesday" spelled out. */
const shortFlightDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function formatFlightDate(stamp: string, short = false): string {
  const date = dateOf(stamp);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;

  return (short ? shortFlightDateFormatter : flightDateFormatter).format(
    new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    )
  );
}

function FlightDate({ stamp, compact }: { stamp: string; compact: boolean }) {
  if (!compact) {
    return (
      <p className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-neutral-500">
        {formatFlightDate(stamp)}
      </p>
    );
  }

  return (
    <p className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-neutral-500">
      <span className="xl:hidden">{formatFlightDate(stamp)}</span>
      <span className="hidden xl:inline">{formatFlightDate(stamp, true)}</span>
    </p>
  );
}

/**
 * The one stop left in the Book Now flow.
 *
 * RePrice came back with a different fare — usually because the booking class
 * the customer picked sold out — and the supplier requires explicit agreement
 * to the new price before Booking (§4.4). It names what is gone, what replaces
 * it and the exact difference, so the decision needs no arithmetic.
 */
function FareChangedPanel({
  result,
  previousFareClass,
  busy,
  onContinue,
  onDismiss,
}: {
  result: FlightRepriceResult;
  /** The class the customer chose, e.g. `"Economy G"`. */
  previousFareClass: string;
  busy: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const cheaper = result.priceDifference < 0;
  const rows: [string, ReactNode][] = [
    [
      'Not available',
      <span key="gone" className="flex flex-wrap items-baseline gap-2">
        {previousFareClass && (
          <span className="font-semibold text-neutral-700">
            {previousFareClass}
          </span>
        )}
        <span className="text-neutral-500 line-through">
          {formatPrice(result.previousTotalPrice, result.currency)}
        </span>
      </span>,
    ],
    [
      'New price',
      <span key="new" className="flex flex-wrap items-baseline gap-2">
        <span className="text-base font-bold text-brand-orange-dark">
          {formatPrice(result.totalPrice, result.currency)}
        </span>
        {result.fareClass && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-navy-950 ring-1 ring-amber-200">
            {result.fareClass}
          </span>
        )}
      </span>,
    ],
    [
      'Difference',
      <span
        key="difference"
        className={`font-semibold ${
          cheaper ? 'text-emerald-700' : 'text-red-700'
        }`}
      >
        {cheaper ? '−' : '+'}
        {formatPrice(Math.abs(result.priceDifference), result.currency)}
      </span>,
    ],
  ];

  return (
    <div
      className="rounded-md bg-amber-50 p-4 ring-1 ring-amber-200"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-700"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-amber-950">Price changed</p>
          <p className="mt-1 text-sm text-amber-900">
            {cheaper
              ? 'The airline confirmed this trip at a lower price.'
              : previousFareClass
                ? `${previousFareClass} is no longer available at this price.`
                : 'This fare is no longer available at the price shown.'}
          </p>

          <dl className="mt-3 space-y-1.5 text-sm">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
              >
                <dt className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-amber-800">
                  {label}
                </dt>
                <dd className="min-w-0">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-orange px-5 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange/90 hover:text-black disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4" aria-hidden />
          )}
          Continue
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="text-sm font-semibold text-neutral-600 underline-offset-2 transition hover:text-navy-950 hover:underline disabled:opacity-60"
        >
          Choose a different fare
        </button>
      </div>
    </div>
  );
}

function LegRow({
  leg,
  airportCities,
  compact = false,
}: {
  leg: ItineraryLeg;
  airportCities: Record<string, string>;
  /** Side-by-side legs share the row width, so the columns tighten up. */
  compact?: boolean;
}) {
  const first = leg.segments[0];
  const last = leg.segments[leg.segments.length - 1];
  const duration = legDuration(leg);
  const layoverMinutes = legLayoverMinutes(leg);
  const layover =
    layoverMinutes !== null && layoverMinutes > 0
      ? formatDuration(layoverMinutes)
      : null;
  const departureCity = airportCities[leg.from] || leg.from;
  const arrivalCity = airportCities[leg.to] || leg.to;
  const rawDepartureAirport = first.fromAirport?.trim() ?? '';
  const rawArrivalAirport = last.toAirport?.trim() ?? '';
  const departureAirport =
    rawDepartureAirport.toUpperCase() === leg.from.toUpperCase()
      ? ''
      : rawDepartureAirport;
  const arrivalAirport =
    rawArrivalAirport.toUpperCase() === leg.to.toUpperCase()
      ? ''
      : rawArrivalAirport;

  // Below xl the legs are still stacked full width, so compact only tightens
  // the columns from xl up.
  const sideColumn = compact
    ? 'w-24 shrink-0 sm:w-28 xl:w-[4.75rem]'
    : 'w-24 shrink-0 sm:w-28';
  const timeSize = compact ? 'text-lg xl:text-base' : 'text-lg';

  return (
    <div
      className={`flex items-center ${
        compact ? 'gap-3 sm:gap-5 xl:gap-2' : 'gap-3 sm:gap-5'
      }`}
    >
      <div className={sideColumn}>
        <p
          className="mb-0.5 truncate text-[11px] font-semibold text-neutral-600"
          title={departureCity}
        >
          {departureCity}
        </p>
        {departureAirport && (
          <p
            className="mb-1 line-clamp-2 text-[9px] font-medium leading-tight text-neutral-400"
            title={departureAirport}
          >
            {departureAirport}
          </p>
        )}
        <p className={`${timeSize} font-bold text-navy-950`}>
          {timeOf(first.departure)}
        </p>
        <FlightDate stamp={first.departure} compact={compact} />
        <p className="mt-0.5 text-xs font-semibold text-neutral-500">{leg.from}</p>
      </div>

      <div className="min-w-0 flex-1 text-center">
        {duration && (
          <>
            <p className="text-[11px] font-semibold leading-tight text-navy-950">
              {duration}
            </p>
            <p className="text-[10px] leading-tight text-neutral-500">
              Duration
            </p>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="h-[2px] flex-1 rounded bg-neutral-200" />
          <Plane className="h-3.5 w-3.5 shrink-0 text-brand-orange" />
          <span className="h-[2px] flex-1 rounded bg-neutral-200" />
        </div>
        <p className="mt-0.5 text-[11px] font-semibold leading-tight text-navy-950">
          {stopsLabel(leg)}
        </p>
        {layover && (
          <>
            <p className="mt-0.5 text-[11px] font-semibold leading-tight text-navy-950">
              {layover}
            </p>
            <p className="text-[10px] leading-tight text-neutral-500">
              Layover
            </p>
          </>
        )}
      </div>

      <div className={`${sideColumn} text-right`}>
        <p
          className="mb-0.5 truncate text-[11px] font-semibold text-neutral-600"
          title={arrivalCity}
        >
          {arrivalCity}
        </p>
        {arrivalAirport && (
          <p
            className="mb-1 line-clamp-2 text-[9px] font-medium leading-tight text-neutral-400"
            title={arrivalAirport}
          >
            {arrivalAirport}
          </p>
        )}
        <p className={`${timeSize} font-bold text-navy-950`}>
          {timeOf(last.arrival)}
        </p>
        <FlightDate stamp={last.arrival} compact={compact} />
        <p className="mt-0.5 text-xs font-semibold text-neutral-500">{leg.to}</p>
      </div>
    </div>
  );
}

/** Aircraft model(s) on their own line(s), refundability underneath. */
function AircraftSummary({
  aircraftModels,
  aircraftRows,
  refundable,
  className,
}: {
  aircraftModels: string;
  aircraftRows: string[];
  refundable: boolean;
  className: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-start gap-1 text-[10px] font-medium leading-tight text-neutral-600">
        <Plane className="h-3 w-3 shrink-0" aria-hidden />
        <div className="min-w-0">
          <div title={aircraftModels || undefined}>
            {aircraftRows.length > 0 ? (
              aircraftRows.map((row) => (
                <p key={row} className="[overflow-wrap:anywhere]">
                  {row}
                </p>
              ))
            ) : (
              <p>Aircraft unavailable</p>
            )}
          </div>
          <p
            className={`mt-0.5 font-semibold ${
              refundable ? 'text-emerald-600' : 'text-brand-orange'
            }`}
          >
            {refundable ? 'Refundable' : 'Non-refundable'}
          </p>
        </div>
      </div>
    </div>
  );
}

function fareComparisonValues(option: FlightFareOption): string[] {
  const segments = option.legs.flatMap((leg) => leg.segments);
  const allowance = (key: 'handBaggage' | 'baggage') => {
    const values = segments.map((segment) => segment[key]?.trim() || 'Not provided');
    return Array.from(new Set(values)).join(' / ') || 'Not provided';
  };
  return [
    allowance('handBaggage'),
    allowance('baggage'),
    option.refundable ? 'Refundable' : 'Non-refundable',
    Array.from(new Set(segments.map((segment) => segment.cabinClass).filter(Boolean))).join(' / ') || 'Not provided',
    Array.from(new Set(segments.map((segment) => segment.bookingClass).filter(Boolean))).join(' / ') || 'Not provided',
    option.bookable ? 'Hold booking available' : 'Instant purchase',
  ];
}

export default function ItineraryCard({
  itinerary,
  currency,
  searchId,
  bookingAvailable,
  holdOnly,
  showSendItinerary,
  airportCities,
  showAuditFares,
  showAgencyFares,
  requiresBookingAssignee,
  bookingAssigneeId,
}: {
  itinerary: FlightItinerary;
  currency: string;
  searchId: string;
  bookingAvailable: boolean;
  holdOnly: boolean;
  showSendItinerary: boolean;
  airportCities: Record<string, string>;
  showAuditFares: boolean;
  showAgencyFares: boolean;
  requiresBookingAssignee?: boolean;
  bookingAssigneeId?: string | null;
}) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const [activePanel, setActivePanel] = useState<CardPanel | null>(null);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [upsellsOpen, setUpsellsOpen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const [showAlternateFare, setShowAlternateFare] = useState(false);
  const [repricingId, setRepricingId] = useState<string | null>(null);
  const [repriceResult, setRepriceResult] =
    useState<FlightRepriceResult | null>(null);
  const [repriceError, setRepriceError] = useState<string | null>(null);
  const [acceptedUpdatedFare, setAcceptedUpdatedFare] = useState(false);
  const [preparingBooking, setPreparingBooking] = useState(false);
  const repriceFeedbackRef = useRef<HTMLDivElement>(null);
  const fareComparisonRef = useRef<HTMLDivElement>(null);
  const [fareRulesByItineraryId, setFareRulesByItineraryId] = useState<
    Record<string, FareRulesState>
  >({});
  const first = itinerary.legs[0]?.segments[0];
  const multiLeg = itinerary.legs.length > 1;
  const twoUpLegs = legColumns(itinerary.legs.length) === 2;
  // Keep long currency totals inside the narrow fare column at every breakpoint.
  const priceTextSize = multiLeg ? 'text-lg xl:text-base' : 'text-lg';
  const flightNumberList = Array.from(
    new Set(
      itinerary.legs.flatMap((leg) =>
        leg.segments.map((segment) => {
          const airlineCode = segment.airlineCode.trim();
          const rawFlightNumber = segment.flightNumber.trim();
          const includesAirlineCode =
            airlineCode.length > 0 &&
            rawFlightNumber
              .toUpperCase()
              .startsWith(airlineCode.toUpperCase());
          const flightNumber = (
            includesAirlineCode
              ? rawFlightNumber.slice(airlineCode.length)
              : rawFlightNumber
          ).replace(/^-/, '');

          if (airlineCode && flightNumber) {
            return `${airlineCode}-${flightNumber}`;
          }

          return rawFlightNumber || airlineCode;
        })
      )
    )
  ).filter(Boolean);
  const flightNumbers = flightNumberList.join(', ');
  const fareClassLabels = fareClassLabel(
    itinerary.legs.flatMap((leg) => leg.segments)
  );
  const aircraftModelList = Array.from(
    new Set(
      itinerary.legs.flatMap((leg) =>
        leg.segments
          .map((segment) => segment.aircraft?.trim() ?? '')
          .filter(Boolean)
      )
    )
  );
  const aircraftModels = aircraftModelList.join(', ');
  const aircraftRows = Array.from(
    { length: Math.ceil(aircraftModelList.length / 2) },
    (_, index) => aircraftModelList.slice(index * 2, index * 2 + 2).join(', ')
  );
  // One line per aircraft row plus the refundability line underneath.
  const aircraftHeightClass =
    aircraftRows.length >= 4
      ? 'md:min-h-[154px]'
      : aircraftRows.length === 3
        ? 'md:min-h-[142px]'
        : aircraftRows.length === 2
          ? 'md:min-h-[130px]'
          : 'md:min-h-[118px]';
  const checkedBaggage = Array.from(
    new Set(
      itinerary.legs.flatMap((leg) =>
        leg.segments
          .map((segment) => segment.baggage?.trim() ?? '')
          .filter(Boolean)
      )
    )
  ).join(' / ');
  const cabinBaggage = Array.from(
    new Set(
      itinerary.legs.flatMap((leg) =>
        leg.segments
          .map((segment) => segment.handBaggage?.trim() ?? '')
          .filter(Boolean)
      )
    )
  ).join(' / ');
  const reportedSeats = itinerary.legs.flatMap((leg) =>
    leg.segments
      .map((segment) => segment.seatsLeft)
      .filter((seats): seats is number => seats !== null)
  );
  const remainingSeats =
    reportedSeats.length > 0 ? Math.min(...reportedSeats) : null;
  const showAgencyPayableOnly =
    showAgencyFares && agencyPayableExceedsGross(itinerary);
  const hasUpsells = itinerary.upsellOptions.length > 0;
  const lowestUpsellDifference = hasUpsells
    ? Math.max(
        0,
        Math.min(
          ...itinerary.upsellOptions.map(
            (option) => option.totalPrice - itinerary.totalPrice
          )
        )
      )
    : 0;
  const options = [itinerary, ...itinerary.upsellOptions];
  const selectedOption =
    options.find((option) => option.id === repriceResult?.itineraryId) ??
    itinerary;
  /** RePrice returned something different; checkout requires confirmation. */
  const awaitingConfirmation =
    repriceResult !== null &&
    repriceResult.requiresConfirmation && !(holdOnly && !repriceResult.bookable) &&
    !acceptedUpdatedFare;
  const busy = repricingId !== null || preparingBooking;
  const primaryLabel = hasUpsells
    ? 'Select'
    : (!bookingAvailable || (holdOnly && !itinerary.bookable))
      ? (repricingId === itinerary.id ? 'Checking fare' : 'Check fare')
    : repricingId === itinerary.id
      ? 'Checking fare'
      : preparingBooking
        ? 'Opening details'
        : awaitingConfirmation
          ? 'Fare changed'
          : itinerary.bookable
            ? 'Book Now'
            : 'Instant Purchase';
  const footerTabs = [
    ['itinerary', 'Itinerary', Route],
    ['fare', 'Fare', ReceiptText],
    ['baggage', 'Baggage', BriefcaseBusiness],
    ['policies', 'Airline policies', BookOpenCheck],
  ] as const;

  // Upsell lists can be taller than the viewport. Bring the next required
  // action into view when RePrice finishes instead of leaving it below the
  // list where the button merely appears to stop loading.
  useEffect(() => {
    if (!repriceError && !awaitingConfirmation && !(!bookingAvailable && repriceResult)) return;
    const frame = window.requestAnimationFrame(() => {
      repriceFeedbackRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [awaitingConfirmation, bookingAvailable, repriceError, repriceResult]);

  const loadFareRules = async (itineraryId: string, force = false) => {
    const current = fareRulesByItineraryId[itineraryId];
    if (
      !force &&
      (current?.status === 'loading' || current?.status === 'success')
    ) {
      return;
    }

    setFareRulesByItineraryId((states) => ({
      ...states,
      [itineraryId]: { status: 'loading', rules: [], error: null },
    }));

    try {
      const response = await fetch('/api/flights/fare-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchId, itineraryId }),
      });
      const envelope = (await response.json()) as FareRulesEnvelope;
      if (envelope.success) {
        setFareRulesByItineraryId((states) => ({
          ...states,
          [itineraryId]: {
            status: 'success',
            rules: envelope.data.rules,
            error: null,
          },
        }));
      } else {
        setFareRulesByItineraryId((states) => ({
          ...states,
          [itineraryId]: {
            status: 'error',
            rules: [],
            error: envelope.error.errorMessage,
          },
        }));
      }
    } catch {
      setFareRulesByItineraryId((states) => ({
        ...states,
        [itineraryId]: {
          status: 'error',
          rules: [],
          error:
            'We could not reach the airline to load its policies. Please try again.',
        },
      }));
    }
  };

  /**
   * Keeps the exact server-side fare selection across Clerk sign-in.
   *
   * The resume route reprices for the signed-in account, prepares the attempt,
   * then replaces itself with checkout. The original results URL is carried
   * only as a local recovery link if the quote expires while the user signs in.
   */
  const signInToResumeBooking = (option: FlightFareOption) => {
    if (!saveBookingSnapshot(searchId, option.id, bookingItinerarySnapshotFor(option))) {
      setRepriceError(
        'This browser could not securely retain the selected flight while you sign in. Please sign in first, then select it again.'
      );
      return false;
    }
    const params = new URLSearchParams({
      searchId,
      itineraryId: option.id,
      returnTo: `${window.location.pathname}${window.location.search}`,
    });
    const resumeUrl = `/flights/booking/resume?${params.toString()}`;
    router.push(`/sign-in?redirect_url=${encodeURIComponent(resumeUrl)}`);
    return true;
  };

  /**
   * Opens the traveller form for a fare RePrice has just verified.
   *
   * Takes the verified fare as an argument rather than reading state, so it can
   * run in the same tick as the RePrice that produced it.
   */
  const continueToTravellers = async (
    verified: FlightRepriceResult,
    option: FlightFareOption
  ) => {
    if (preparingBooking) return;
    setPreparingBooking(true);
    setRepriceError(null);

    // RePrice is already complete, so retain that exact verified selection
    // through sign-in rather than returning to (and repeating) the search.
    if (authLoaded && !isSignedIn) {
      if (!signInToResumeBooking(option)) setPreparingBooking(false);
      return;
    }

    try {
      const response = await fetch('/api/flights/booking/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId,
          itineraryId: verified.itineraryId,
          acceptedRepricedAt: verified.requiresConfirmation
            ? verified.repricedAt
            : null,
          itinerary: bookingItinerarySnapshotFor(option),
          ...(bookingAssigneeId ? { assignedUserId: bookingAssigneeId } : {}),
        }),
      });
      const envelope = (await response.json()) as PrepareEnvelope;
      if (!envelope.success) {
        // A session that lapsed between page load and this click: send them to
        // sign in with the verified selection rather than repeating the search.
        if (envelope.error.errorCode === 'SIGN_IN_REQUIRED') {
          if (!signInToResumeBooking(option)) setPreparingBooking(false);
          return;
        }
        setRepriceError(envelope.error.errorMessage);
        setPreparingBooking(false);
        return;
      }
      sessionStorage.setItem(
        `kaliganj-booking-${envelope.data.attempt.attemptId}`,
        envelope.data.accessToken
      );
      // Deliberately left busy: the button keeps its spinner until the
      // checkout route replaces this card, so the click cannot be repeated.
      router.push(
        `/flights/checkout?bookingId=${encodeURIComponent(
          envelope.data.attempt.attemptId
        )}`
      );
    } catch {
      setRepriceError(
        'The traveller form could not be prepared. Please try again.'
      );
      setPreparingBooking(false);
    }
  };

  /**
   * Select and verify a fare. Read-only suppliers stop after the live price.
   *
   * RePrice is mandatory — Booking needs the `priceCodeRef` only RePrice issues
   * — but it is not a step the customer should have to click through. So it
   * runs behind this one press and hands straight over to the traveller form.
   *
   * The single exception is a fare that came back different: the supplier
   * requires explicit re-confirmation, and `prepare` enforces it server-side,
   * so that case stops on the confirmation panel below.
   */
  const selectFare = async (option: FlightFareOption) => {
    if (option.ambiguousSelection || repricingId || preparingBooking) return;
    if (bookingAvailable && requiresBookingAssignee && !bookingAssigneeId) {
      setRepriceError('Select the B2B or B2C user this booking belongs to first.');
      return;
    }

    // Keep the exact server-side search and option through sign-in. RePrice
    // runs after authentication so role-based pricing uses the signed-in user.
    if (bookingAvailable && authLoaded && !isSignedIn) {
      signInToResumeBooking(option);
      return;
    }

    setRepricingId(option.id);
    setRepriceResult(null);
    setRepriceError(null);
    setAcceptedUpdatedFare(false);

    let verified: FlightRepriceResult | null = null;
    try {
      for (let attempt = 1; attempt <= REPRICE_ATTEMPTS; attempt += 1) {
        const response = await fetch('/api/flights/reprice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchId,
            itineraryId: option.id,
            ...(bookingAssigneeId ? { assignedUserId: bookingAssigneeId } : {}),
          }),
        });
        const envelope = (await response.json()) as RepriceEnvelope;
        if (envelope.success) {
          verified = envelope.data;
          setRepriceResult(verified);
          if (verified.requiresConfirmation) {
            setUpsellsOpen(false);
          }
          if (activePanel === 'policies') {
            void loadFareRules(option.id);
          }
          break;
        }

        // The supplier may finish a RePrice too late for its gateway to relay
        // the answer. Repeat that read-only operation once, but surface every
        // other failure (sold-out fare, changed price, invalid selection, etc.)
        // immediately and exactly as the supplier described it.
        const retryableTimeout = envelope.error.errorCode === 'REPRICE_TIMEOUT';
        if (retryableTimeout && attempt < REPRICE_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, REPRICE_RETRY_DELAY_MS);
          });
          continue;
        }

        setRepriceError(envelope.error.errorMessage);
        break;
      }
    } catch {
      setRepriceError(
        'We could not reach the airline to verify this fare. Please try again.'
      );
    } finally {
      setRepricingId(null);
    }

    if (holdOnly && verified && !verified.bookable) {
      setRepriceError('This fare cannot be held. Choose another fare.');
      return;
    }
    if (bookingAvailable && verified && !verified.requiresConfirmation) {
      await continueToTravellers(verified, option);
    }
  };

  const togglePanel = (panel: CardPanel) => {
    const opening = activePanel !== panel;
    setActivePanel(opening ? panel : null);
    if (opening && panel === 'policies') {
      void loadFareRules(selectedOption.id);
    }
  };

  const handlePrimarySelect = () => {
    if (hasUpsells) {
      setUpsellsOpen((current) => !current);
      setActivePanel(null);
    } else {
      void selectFare(itinerary);
    }
  };

  const itineraryText = itineraryShareText(selectedOption, currency, airportCities);
  const itinerarySubject = `Flight itinerary · ${itinerary.legs.map((leg) => `${airportCities[leg.from] || leg.from} to ${airportCities[leg.to] || leg.to}`).join(' · ')}`;

  const selectionButton = (
    option: FlightFareOption,
    compact = false
  ) => {
    const chosen = repriceResult?.itineraryId === option.id;
    const loading =
      repricingId === option.id || (chosen && preparingBooking);
    const awaiting = chosen && awaitingConfirmation;

    return (
      <button
        type="button"
        onClick={() => void selectFare(option)}
        disabled={option.ambiguousSelection || busy}
        aria-pressed={chosen}
        title={
          option.ambiguousSelection
            ? 'This supplier option cannot be selected unambiguously.'
            : undefined
        }
        className={`inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-orange font-semibold text-black transition hover:bg-brand-orange/90 disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
        }`}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : awaiting ? (
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        )}
        {loading
          ? repricingId === option.id
            ? 'Checking fare'
            : 'Opening'
          : awaiting
            ? 'Fare changed'
          : (!bookingAvailable || (holdOnly && !option.bookable))
            ? 'Check fare'
            : option.bookable
              ? 'Book Now'
              : 'Instant Purchase'}
      </button>
    );
  };

  return (
    <article ref={cardRef} className="relative overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-neutral-200 transition hover:shadow-md">
      <AirlineLogo
        airlineCode={itinerary.carrierCode}
        size={52}
        className="absolute left-0 top-0 rounded-none"
      />

      <div
        className={`flex flex-col gap-4 p-4 md:flex-row md:items-center md:pb-0 md:pr-0 ${
          multiLeg ? 'xl:gap-2' : ''
        } ${aircraftHeightClass}`}
      >
        {/* Carrier */}
        <div
          className={`min-w-0 pl-12 md:flex md:shrink-0 md:self-stretch md:flex-col md:justify-between md:pb-1 ${
            multiLeg ? 'md:w-48 xl:w-32' : 'md:w-48'
          }`}
        >
          {/* Name stays on one line and clips; the flight numbers wrap instead,
              which keeps this block narrow enough to give the legs the width. */}
          <div className="md:-mt-3">
            <p
              className="truncate text-xs font-semibold leading-tight text-navy-950 md:max-w-[132px]"
              title={itinerary.carrierName || undefined}
            >
              {itinerary.carrierName || 'Airline'}
            </p>
            <p
              className="mt-1 text-xs leading-tight text-neutral-500 md:max-w-[132px]"
              title={flightNumbers || undefined}
            >
              {flightNumberList.length > 0
                ? flightNumberList.map((flightNumber, index) => {
                    const last = index === flightNumberList.length - 1;
                    // The number stays whole inside the span; the separating
                    // space sits outside it, so a line can only break after the
                    // comma — never inside "BG-347".
                    return (
                      <Fragment key={flightNumber}>
                        <span className="whitespace-nowrap">
                          {last ? flightNumber : `${flightNumber},`}
                        </span>
                        {last ? '' : ' '}
                      </Fragment>
                    );
                  })
                : '--'}
            </p>
            {itinerary.codeshare === true && (
              <p className="mt-1 text-xs font-medium text-navy-950">Codeshare</p>
            )}
          </div>
          <AircraftSummary
            aircraftModels={aircraftModels}
            aircraftRows={aircraftRows}
            refundable={itinerary.refundable}
            className={`-ml-12 mt-2 hidden md:block ${
              multiLeg ? 'w-48 xl:w-32' : 'w-48'
            }`}
          />
        </div>

        {/* Legs — stacked on narrow screens, and from xl up laid out two to a
            row when they divide evenly: a round trip side by side, four legs
            as a 2×2. Three or five stay stacked rather than orphaning the
            last one at half width. */}
        <div
          className={`grid min-w-0 flex-1 gap-3 ${
            twoUpLegs ? 'xl:grid-cols-2 xl:gap-x-0' : ''
          }`}
        >
          {itinerary.legs.map((leg, index) => (
            <div
              key={`${leg.from}-${leg.to}-${index}`}
              className={
                !twoUpLegs
                  ? undefined
                  : [
                      index % 2 === 1
                        ? 'xl:border-l xl:border-neutral-200 xl:pl-2'
                        : 'xl:pr-2',
                      // Rows after the first: a rule across the top, so a 2×2
                      // reads as a grid rather than four loose blocks.
                      index >= 2 ? 'xl:border-t xl:border-neutral-200 xl:pt-2' : '',
                    ].join(' ')
              }
            >
              {multiLeg && (
                <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  <Plane className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    {legLabel(itinerary.legs, index)} {leg.from} → {leg.to}
                  </span>
                </p>
              )}
              <LegRow
                leg={leg}
                airportCities={airportCities}
                compact={multiLeg}
              />
            </div>
          ))}
        </div>

        {/* Price */}
        <div
          className={`flex flex-col items-stretch gap-2 border-t border-neutral-100 pt-3 md:shrink-0 md:self-stretch md:justify-between md:border-l md:border-t-0 md:pb-1 md:pt-0 ${
            multiLeg ? 'md:w-44 xl:w-36' : 'md:w-44'
          }`}
        >
          {(fareClassLabels ||
            checkedBaggage ||
            cabinBaggage ||
            remainingSeats !== null) && (
            <div className="w-full space-y-1 px-2 text-[10px] font-medium leading-tight text-neutral-600">
              {fareClassLabels && (
                <div
                  className="flex min-w-0 items-center gap-1 text-[11px] font-semibold text-navy-950"
                  title={fareClassLabels}
                >
                  <span className="truncate">{fareClassLabels}</span>
                </div>
              )}
              {remainingSeats !== null && (
                <div
                  className="flex min-w-0 items-center gap-1.5"
                  title={`Remaining seats: ${remainingSeats}`}
                >
                  <Armchair className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    {remainingSeats} remaining seat
                    {remainingSeats === 1 ? '' : 's'}
                  </span>
                </div>
              )}
              {(checkedBaggage || cabinBaggage) && (
                <div
                  // The narrowed fare block cannot hold both allowances on one
                  // line, so they stack once the legs go side by side.
                  className={`flex min-w-0 items-center gap-1.5 ${
                    multiLeg ? 'xl:flex-col xl:items-start xl:gap-0.5' : ''
                  }`}
                  title={[
                    checkedBaggage
                      ? `Checked baggage: ${checkedBaggage}`
                      : '',
                    cabinBaggage ? `Cabin baggage: ${cabinBaggage}` : '',
                  ]
                    .filter(Boolean)
                    .join(' | ')}
                >
                  {checkedBaggage && (
                    <span className="flex min-w-0 items-center gap-1">
                      <Luggage className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">{checkedBaggage}</span>
                    </span>
                  )}
                  {checkedBaggage && cabinBaggage && (
                    <span
                      className={`h-3 w-px shrink-0 bg-neutral-300 ${
                        multiLeg ? 'xl:hidden' : ''
                      }`}
                      aria-hidden
                    />
                  )}
                  {cabinBaggage && (
                    <span className="flex min-w-0 items-center gap-1">
                      <BriefcaseBusiness
                        className="h-3 w-3 shrink-0"
                        aria-hidden
                      />
                      <span className="truncate">{cabinBaggage}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="text-right md:w-full">
            {showAuditFares && itinerary.auditPricing ? (
              <div className="px-2 text-center">
                <button
                  type="button"
                  onClick={() => setShowAlternateFare((current) => !current)}
                  aria-expanded={showAlternateFare}
                  aria-label={
                    showAlternateFare
                      ? 'Hide additional fare'
                      : 'Show additional fare'
                  }
                  className={`inline-flex items-center justify-center gap-0.5 whitespace-nowrap font-bold text-navy-950 transition hover:text-brand-orange-dark ${priceTextSize}`}
                >
                  {formatPrice(
                    itinerary.auditPricing.grossPrice,
                    currency
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      showAlternateFare ? 'rotate-180' : ''
                    }`}
                    aria-hidden
                  />
                </button>
                {showAlternateFare && (
                  <p className="mt-0.5 text-[11px] font-semibold text-brand-orange">
                    {formatPrice(itinerary.auditPricing.netFare, currency)}
                  </p>
                )}
              </div>
            ) : showAgencyPayableOnly && itinerary.agencyPricing ? (
              <p
                className={`whitespace-nowrap px-2 font-bold text-brand-orange-dark md:text-center ${priceTextSize}`}
              >
                {formatPrice(itinerary.agencyPricing.agentFare, currency)}
              </p>
            ) : showAgencyFares && itinerary.agencyPricing ? (
              <div className="px-2 text-center">
                <button
                  type="button"
                  onClick={() => setShowAlternateFare((current) => !current)}
                  aria-expanded={showAlternateFare}
                  aria-label={
                    showAlternateFare
                      ? 'Hide additional fare'
                      : 'Show additional fare'
                  }
                  className={`inline-flex items-center justify-center gap-0.5 whitespace-nowrap font-bold text-navy-950 transition hover:text-brand-orange-dark ${priceTextSize}`}
                >
                  {formatPrice(
                    itinerary.agencyPricing.grossPrice,
                    currency
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      showAlternateFare ? 'rotate-180' : ''
                    }`}
                    aria-hidden
                  />
                </button>
                {showAlternateFare && (
                  <p className="mt-0.5 text-[11px] font-semibold text-brand-orange">
                    {formatPrice(
                      itinerary.agencyPricing.agentFare,
                      currency
                    )}
                  </p>
                )}
              </div>
            ) : (
              <p
                className={`whitespace-nowrap font-bold text-brand-orange-dark md:text-center ${priceTextSize}`}
              >
                {formatPrice(itinerary.totalPrice, currency)}
              </p>
            )}
            {bookingAvailable && !itinerary.bookable && (
              <p className="mt-1 text-center text-[10px] font-semibold text-blue-700">
                <span className="block">{holdOnly ? 'Booking unavailable' : 'Instant purchase only'}</span>
                <span className="block">Hold unavailable</span>
              </p>
            )}
          </div>
        </div>

        <AircraftSummary
          aircraftModels={aircraftModels}
          aircraftRows={aircraftRows}
          refundable={itinerary.refundable}
          className="border-t border-neutral-200 pt-2 md:hidden"
        />
      </div>

      {!bookingAvailable && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-5">
          Booking is currently unavailable for this supplier. You can check the live fare and airline policies.
        </div>
      )}

      <div className="border-t border-neutral-200 bg-navy-50/60">
        {/* Mobile: keep every footer tab behind one compact View Details control. */}
        <div className="lg:hidden">
          <button
            type="button"
            onClick={() => setMobileDetailsOpen((current) => !current)}
            aria-expanded={mobileDetailsOpen}
            className="flex min-h-11 w-full items-center justify-between px-4 py-2.5 text-left text-sm font-semibold text-navy-950 transition hover:bg-white/70"
          >
            <span>{mobileDetailsOpen ? 'Hide Details' : 'View Details'}</span>
            <ChevronDown
              className={`h-4 w-4 text-neutral-500 transition-transform ${
                mobileDetailsOpen ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>

          {mobileDetailsOpen && (
            <div className="border-t border-neutral-200 bg-white/70 p-2">
              <div className="overflow-hidden rounded-md ring-1 ring-neutral-200">
                {footerTabs.map(([panel, label, Icon], index) => (
                  <button
                    key={panel}
                    type="button"
                    onClick={() => togglePanel(panel)}
                    aria-expanded={activePanel === panel}
                    className={`flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold transition ${
                      index > 0 ? 'border-t border-neutral-200' : ''
                    } ${
                      activePanel === panel
                        ? 'bg-brand-orange-light text-brand-orange-dark'
                        : 'bg-white text-neutral-700 hover:bg-navy-50'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {label}
                  </button>
                ))}
                {showSendItinerary && (
                  <SendItineraryMenu cardRef={cardRef} text={itineraryText} subject={itinerarySubject} offer={itineraryShareOffer(selectedOption, currency, airportCities)} mobile />
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handlePrimarySelect}
            disabled={
              (!hasUpsells && itinerary.ambiguousSelection) ||
              (!hasUpsells && busy)
            }
            aria-expanded={hasUpsells ? upsellsOpen : undefined}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 bg-brand-orange px-7 py-3 text-sm font-bold text-navy-950 transition hover:bg-brand-orange/90 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!hasUpsells && busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : awaitingConfirmation ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {primaryLabel}
            {hasUpsells && (
              <ChevronDown
                className={`h-4 w-4 transition-transform ${
                  upsellsOpen ? 'rotate-180' : ''
                }`}
              />
            )}
          </button>
        </div>

        {/* Desktop: retain the existing horizontal footer. */}
        <div className="hidden lg:flex lg:items-stretch">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-4 py-2">
            {footerTabs.map(([panel, label, Icon]) => (
              <button
                key={panel}
                type="button"
                onClick={() => togglePanel(panel)}
                aria-expanded={activePanel === panel}
                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  activePanel === panel
                    ? 'bg-white text-brand-orange-dark shadow-sm ring-1 ring-brand-orange/20'
                    : 'text-neutral-600 hover:bg-white hover:text-navy-950'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {label}
              </button>
            ))}
            {showSendItinerary && (
              <SendItineraryMenu cardRef={cardRef} text={itineraryText} subject={itinerarySubject} offer={itineraryShareOffer(selectedOption, currency, airportCities)} />
            )}
          </div>

          <button
            type="button"
            onClick={handlePrimarySelect}
            disabled={
              (!hasUpsells && itinerary.ambiguousSelection) ||
              (!hasUpsells && busy)
            }
            aria-expanded={hasUpsells ? upsellsOpen : undefined}
            className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-2 bg-brand-orange py-2 text-sm font-bold text-black transition hover:bg-brand-orange/90 disabled:cursor-not-allowed disabled:opacity-50 ${
              multiLeg ? 'w-44 px-7 xl:w-36 xl:px-3' : 'w-44 px-7'
            }`}
          >
            {!hasUpsells && busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : awaitingConfirmation ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {primaryLabel}
            {hasUpsells && (
              <ChevronDown
                className={`h-4 w-4 transition-transform ${
                  upsellsOpen ? 'rotate-180' : ''
                }`}
              />
            )}
          </button>
        </div>
      </div>

      {hasUpsells && upsellsOpen && (
        <div className="border-t border-neutral-200 bg-amber-50/40">
          <div className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left sm:px-5">
            <span className="flex min-w-0 items-center gap-2">
              <CircleDollarSign
                className="h-4 w-4 shrink-0 text-amber-700"
                aria-hidden
              />
              <span className="truncate text-sm font-semibold text-navy-950">
                {itinerary.upsellOptions.length}{' '}
                {itinerary.upsellOptions.length === 1
                  ? 'upsell option'
                  : 'upsell options'}
              </span>
              <span className="hidden text-xs text-neutral-500 sm:inline">
                Same flights with different fare conditions
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-xs font-semibold text-amber-800">
                {lowestUpsellDifference > 0
                  ? `from +${formatPrice(lowestUpsellDifference, currency)}`
                  : 'same price available'}
              </span>
              <ChevronDown
                className="h-4 w-4 rotate-180 text-amber-800"
                aria-hidden
              />
            </span>
          </div>

          <div className="border-t border-neutral-200 px-4 py-4 sm:px-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs text-neutral-500">Compare fares side by side.</p>
              <div className="flex shrink-0 gap-2">
                {([-1, 1] as const).map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    aria-label={direction === -1 ? 'Previous fare options' : 'Next fare options'}
                    onClick={() => fareComparisonRef.current?.scrollBy({
                      left: direction * 306,
                      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                    })}
                    className="rounded-md border border-neutral-200 bg-white p-2 text-navy-950 transition hover:border-brand-orange hover:text-brand-orange focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-orange"
                  >
                    {direction === -1 ? <ChevronLeft className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                  </button>
                ))}
              </div>
            </div>
            <div
              ref={fareComparisonRef}
              className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-orange"
              tabIndex={0}
              role="region"
              aria-label="Fare comparison"
            >
              {options.map((option, index) => {
                const values = fareComparisonValues(option);
                const selected = option.id === repriceResult?.itineraryId || option.id === repricingId;
                return (
                  <article key={option.id} className={`min-w-0 flex-[1_0_270px] snap-start rounded-xl border bg-white p-4 sm:basis-[290px] ${selected ? 'border-brand-orange ring-1 ring-brand-orange' : 'border-neutral-200'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-navy-950">{index === 0 ? 'Lowest fare' : `Fare option ${index + 1}`}</h3>
                        <p className="mt-1 text-[11px] text-neutral-500">{values[3]} · Class {values[4]}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="whitespace-nowrap text-base font-bold text-navy-950">{formatPrice(option.totalPrice, currency)}</p>
                        <p className="mt-1 text-[11px] text-neutral-500">{option.totalPrice > itinerary.totalPrice ? `+${formatPrice(option.totalPrice - itinerary.totalPrice, currency)}` : 'Starting fare'}</p>
                      </div>
                    </div>
                    <dl className="my-4 grid grid-cols-2 gap-x-3 gap-y-3 border-y border-neutral-100 py-3 text-xs">
                      {[
                        { label: 'Hand baggage', icon: BriefcaseBusiness, value: values[0] },
                        { label: 'Checked baggage', icon: Luggage, value: values[1] },
                        { label: 'Refundability', icon: ShieldCheck, value: values[2] },
                        { label: 'Booking option', icon: BookOpenCheck, value: bookingAvailable ? values[5] : 'Unavailable' },
                      ].map(({ label, icon: Icon, value }) => (
                        <div key={label} className="min-w-0">
                          <dt className="flex items-center gap-1.5 text-[10px] text-neutral-500"><Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{label}</dt>
                          <dd className="mt-1 leading-5 text-navy-950">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="[&>button]:w-full">{selectionButton(option)}</div>
                  </article>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] text-neutral-500">{bookingAvailable ? 'Fares are revalidated before booking.' : 'Use Check fare to verify the latest price.'} Allowances may vary by flight segment; check Baggage for details.</p>
          </div>
        </div>
      )}

      {(repriceError || awaitingConfirmation || (!bookingAvailable && repriceResult)) && (
        <div
          ref={repriceFeedbackRef}
          className="scroll-mt-24 space-y-3 border-t border-neutral-200 px-4 py-4 sm:px-5"
        >
          {repriceError && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md p-3 text-sm ring-1',
                repriceError === 'No eligible fare found'
                  ? 'bg-neutral-50 text-neutral-700 ring-neutral-200'
                  : 'bg-red-50 text-red-800 ring-red-200'
              )}
              role={repriceError === 'No eligible fare found' ? 'status' : 'alert'}
            >
              {repriceError === 'No eligible fare found' ? (
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <span>{repriceError}</span>
            </div>
          )}

          {!bookingAvailable && repriceResult && (
            <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" role="status">
              Verified fare: {formatPrice(repriceResult.totalPrice, repriceResult.currency)}. Booking is currently unavailable.
            </p>
          )}

          {repriceResult && awaitingConfirmation && (
            <FareChangedPanel
              result={repriceResult}
              previousFareClass={fareClassLabel(
                selectedOption.legs.flatMap((leg) => leg.segments)
              )}
              busy={preparingBooking}
              onContinue={() => {
                setAcceptedUpdatedFare(true);
                void continueToTravellers(repriceResult, selectedOption);
              }}
              onDismiss={() => {
                setRepriceResult(null);
                setAcceptedUpdatedFare(false);
              }}
            />
          )}
        </div>
      )}

      {activePanel && (
        <div className="fixed inset-0 z-[60] border-0 bg-transparent p-0 lg:static lg:z-auto lg:border-t lg:border-neutral-200 lg:bg-neutral-50 lg:p-5">
          <button
            type="button"
            aria-label="Close details"
            onClick={() => setActivePanel(null)}
            className="absolute inset-0 bg-navy-950/50 lg:hidden"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-neutral-50 p-4 shadow-2xl lg:static lg:max-h-none lg:overflow-visible lg:rounded-none lg:bg-transparent lg:p-0 lg:shadow-none">
            <div className="mb-3 flex items-center justify-between lg:hidden">
              <p className="text-sm font-semibold text-navy-950">
                {activePanel === 'itinerary'
                  ? 'Flight Details'
                  : activePanel === 'fare'
                    ? 'Fare Summary'
                    : activePanel === 'baggage'
                      ? 'Baggage'
                      : 'Airline policies'}
              </p>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                aria-label="Close details"
                className="-m-2 rounded-full p-2 text-neutral-500 transition hover:bg-white hover:text-navy-950"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

          {activePanel === 'itinerary' && (
            <ItineraryDetails
              option={selectedOption}
              ambiguous={itinerary.ambiguousSelection}
            />
          )}

          {activePanel === 'fare' && (
            <FareDetails option={selectedOption} currency={currency} />
          )}

          {activePanel === 'baggage' && (
            <BaggageDetails option={selectedOption} />
          )}

          {activePanel === 'policies' && (
            <AirlinePolicyDetails
              option={selectedOption}
              status={
                fareRulesByItineraryId[selectedOption.id]?.status ?? 'loading'
              }
              rules={
                fareRulesByItineraryId[selectedOption.id]?.rules ?? []
              }
              error={
                fareRulesByItineraryId[selectedOption.id]?.error ?? null
              }
              onRetry={() => void loadFareRules(selectedOption.id, true)}
            />
          )}
          </div>
        </div>
      )}
    </article>
  );
}
