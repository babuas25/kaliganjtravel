'use client';

import {
  AlertCircle,
  BriefcaseBusiness,
  CheckCircle2,
  Loader2,
  Package,
  Plane,
  RefreshCw,
  Route,
} from 'lucide-react';

import AirlineLogo from '@/components/flights/AirlineLogo';
import {
  dateOf,
  formatDuration,
  formatPrice,
  legColumns,
  legLabel,
  minutesBetween,
  timeOf,
  type FareRuleSection,
  type FlightFareOption,
  type ItinerarySegment,
} from '@/lib/flights/types';

/**
 * `Tue, Aug 18`.
 *
 * The weekday is abbreviated deliberately: two of these sit side by side in a
 * column roughly 70px wide once a return itinerary puts both legs on one row,
 * and `Tuesday, Aug 18` wraps to three lines there.
 */
function travelDate(stamp: string): string {
  const value = dateOf(stamp);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(
    new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    )
  );
}

function segmentDuration(segment: ItinerarySegment): string {
  if (segment.duration) return segment.duration;

  const minutes = minutesBetween(segment.departure, segment.arrival);
  return minutes !== null && minutes >= 0 ? formatDuration(minutes) : '';
}

/**
 * One end of a segment: time, date, terminal, airport code and airport name.
 *
 * Every line is `truncate`, including the time. A return itinerary renders its
 * two legs side by side from `xl` up, which leaves each of these columns around
 * 70px — and the card is `overflow-hidden`, so anything that does not shrink is
 * not merely wide, it is silently cut in half. An ellipsis is the honest
 * version of that, and the full airport name stays reachable as a tooltip.
 */
function Endpoint({
  stamp,
  code,
  airport,
  align = 'left',
}: {
  stamp: string;
  code: string;
  airport: string;
  align?: 'left' | 'right';
}) {
  const right = align === 'right';

  return (
    <div className={`min-w-0 ${right ? 'text-right' : ''}`}>
      <p className="truncate text-base font-bold leading-tight tabular-nums text-navy-950 sm:text-lg">
        {timeOf(stamp)}
      </p>
      <p className="mt-1 truncate text-[11px] leading-tight text-neutral-500">
        {travelDate(stamp)}
      </p>
      {/* The supplier sends no terminal on any segment. The row is kept so the
          layout matches the one on the checkout and ticket pages, and reads as
          "not provided" rather than as an omission. */}
      <p className="mt-0.5 truncate text-[11px] leading-tight text-neutral-400">
        Terminal: -
      </p>
      <p className="mt-1 truncate text-xs font-semibold leading-tight text-navy-700">
        {code}
      </p>
      <p
        className="mt-0.5 truncate text-[11px] leading-tight text-neutral-500"
        title={airport}
      >
        {airport || code}
      </p>
    </div>
  );
}

function SegmentDetails({
  segment,
  nextSegment,
}: {
  segment: ItinerarySegment;
  nextSegment?: ItinerarySegment;
}) {
  const layoverMinutes = nextSegment
    ? minutesBetween(segment.arrival, nextSegment.departure)
    : null;
  const cabin = [segment.cabinClass, segment.bookingClass]
    .filter(Boolean)
    .join(' · ');
  const footnotes = [
    segment.aircraft ? `Aircraft: ${segment.aircraft}` : null,
  ].filter(Boolean);

  return (
    <div>
      {/* The airline column is capped rather than fixed at 180px: side by side,
          two legs plus a fixed column left the times too little room to fit. */}
      <div className="bg-white p-3">
        <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,148px)_minmax(0,1fr)] sm:items-center sm:gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <AirlineLogo
              airlineCode={segment.airlineCode}
              size={28}
              className="rounded-full bg-brand-orange-light"
            />
            {/* Three short lines rather than two crammed ones. The five-line
                endpoint column beside this one sets the row height, so a third
                line here is free, and `BS141 · Economy · Q` on one line does
                not fit the ~110px this column can spare. */}
            <div className="min-w-0">
              <p
                className="truncate text-[13px] font-semibold leading-tight text-navy-950"
                title={segment.airline || undefined}
              >
                {segment.airline || 'Airline'}
              </p>
              <p className="mt-0.5 truncate text-[11px] font-medium leading-tight text-neutral-500">
                {segment.airlineCode}
                {segment.flightNumber}
              </p>
              {cabin && (
                <p className="mt-0.5 truncate text-[11px] leading-tight text-neutral-500">
                  {cabin}
                </p>
              )}
            </div>
          </div>

          {/* The middle track is fixed at both sizes rather than a `minmax`:
              against `minmax(0,1fr)` neighbours a flexible track takes its
              maximum and the endpoints yield, which starts ellipsizing the
              times themselves. 48px from `xl`, where a return itinerary puts
              its two legs side by side and that is all there is to spare;
              88px below it, where the row is full width and 48px leaves the
              dashed line stunted. */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)] items-start gap-2 xl:grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)]">
            <Endpoint
              stamp={segment.departure}
              code={segment.from}
              airport={segment.fromAirport}
            />

            <div className="flex flex-col items-center pt-0.5">
              <p className="mb-1.5 whitespace-nowrap text-[11px] font-medium leading-tight text-neutral-500">
                {segmentDuration(segment)}
              </p>
              <div className="relative w-full">
                <span className="block border-t border-dashed border-neutral-300" />
                <Plane
                  className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 bg-white text-brand-orange"
                  aria-hidden
                />
              </div>
            </div>

            <Endpoint
              stamp={segment.arrival}
              code={segment.to}
              airport={segment.toAirport}
              align="right"
            />
          </div>
        </div>

        {/* Only drawn when there is something to say: an empty bordered strip
            under every segment was costing a row of height for nothing. */}
        {(footnotes.length > 0 ||
          (segment.seatsLeft !== null && segment.seatsLeft <= 9)) && (
          <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-neutral-100 pt-2 text-[11px] text-neutral-500">
            {footnotes.map((note) => (
              <span key={note}>{note}</span>
            ))}
            {segment.seatsLeft !== null && segment.seatsLeft <= 9 && (
              <span className="font-semibold text-brand-orange-dark">
                {segment.seatsLeft} seat{segment.seatsLeft === 1 ? '' : 's'} left
              </span>
            )}
          </div>
        )}
      </div>

      {nextSegment && layoverMinutes !== null && layoverMinutes > 0 && (
        <div className="border-t border-neutral-200 bg-amber-50 px-3 py-1.5 text-center text-[11px] font-medium text-amber-800">
          Change of planes {formatDuration(layoverMinutes)} · Layover at{' '}
          {segment.to}
        </div>
      )}
    </div>
  );
}

export function ItineraryDetails({
  option,
  ambiguous,
}: {
  option: FlightFareOption;
  ambiguous: boolean;
}) {
  return (
    <div className="space-y-4">
      {ambiguous && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The airline returned several departures under one fare reference,
            so this option cannot be selected safely yet.
          </span>
        </div>
      )}

      {/* Same column rule as the card above it, so opening the panel does not
          rearrange the trips the summary just showed. */}
      <div
        className={
          legColumns(option.legs.length) === 2
            ? 'grid grid-cols-1 gap-3 xl:grid-cols-2'
            : 'space-y-3'
        }
      >
        {option.legs.map((leg, legIndex) => (
          <section key={`${leg.from}-${leg.to}-${legIndex}`} className="min-w-0">
            {option.legs.length > 1 && (
              <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-navy-700">
                <Route className="h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden />
                <span className="truncate">
                  {legLabel(option.legs, legIndex)} · {leg.from} → {leg.to}
                </span>
              </div>
            )}
            <div className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200">
              {leg.segments.map((segment, segmentIndex) => (
                <SegmentDetails
                  key={`${segment.airlineCode}${segment.flightNumber}-${segmentIndex}`}
                  segment={segment}
                  nextSegment={leg.segments[segmentIndex + 1]}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function FareDetails({
  option,
  currency,
}: {
  option: FlightFareOption;
  currency: string;
}) {
  if (option.fares.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-500">
        No fare breakdown is available for this option.
      </div>
    );
  }

  const hasServiceMargin = option.fares.some(
    (fare) => fare.serviceMargin > 0
  );

  return (
    <div className="w-full space-y-2">
      <div className="space-y-2 sm:hidden">
        {option.fares.map((fare) => (
          <div
            key={fare.passengerType}
            className="overflow-hidden rounded-xl border border-neutral-200 bg-white"
          >
            <div className="border-b border-neutral-200 px-3 py-2">
              <span className="text-sm font-semibold text-navy-950">
                {fare.passengerType}
              </span>
              <span className="ml-2 text-sm text-neutral-500">
                × {fare.count}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="text-neutral-500">Base fare</span>
              <span className="text-right font-medium tabular-nums text-navy-950">
                {fare.basePrice.toLocaleString('en-US')}
              </span>
              <span className="text-neutral-500">Tax</span>
              <span className="text-right font-medium tabular-nums text-navy-950">
                {fare.taxes.toLocaleString('en-US')}
              </span>
              <span className="text-neutral-500">AIT</span>
              <span className="text-right font-medium tabular-nums text-navy-950">
                {fare.ait.toLocaleString('en-US')}
              </span>
              {hasServiceMargin && (
                <>
                  <span className="text-neutral-500">LCC service margin</span>
                  <span className="text-right font-medium tabular-nums text-amber-700">
                    {fare.serviceMargin.toLocaleString('en-US')}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center justify-between bg-navy-50/70 px-3 py-2">
              <span className="text-sm font-semibold text-navy-700">Amount</span>
              <span className="text-base font-bold tabular-nums text-navy-950">
                {formatPrice(fare.totalPrice, currency)}
              </span>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-navy-50 px-3 py-2">
          <span className="text-sm font-semibold text-navy-700">
            Total price
          </span>
          <span className="text-base font-bold tabular-nums text-brand-orange-dark">
            {formatPrice(option.totalPrice, currency)}
          </span>
        </div>
      </div>

      <div className="hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white sm:block">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 bg-navy-50/70">
              <th className="px-3 py-2 text-left text-xs font-semibold text-navy-700">
                Passenger type
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-navy-700">
                Base fare
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-navy-700">
                Tax
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-navy-700">
                AIT
              </th>
              <th className="px-3 py-2 text-center text-xs font-semibold text-navy-700">
                Pax count
              </th>
              {hasServiceMargin && (
                <th className="px-3 py-2 text-right text-xs font-semibold text-navy-700">
                  LCC service margin
                </th>
              )}
              <th className="px-3 py-2 text-right text-xs font-semibold text-navy-700">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {option.fares.map((fare) => (
              <tr
                key={fare.passengerType}
                className="border-b border-neutral-200 last:border-b-0"
              >
                <td className="px-3 py-2 text-sm font-medium text-navy-950">
                  {fare.passengerType}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-neutral-600">
                  {fare.basePrice.toLocaleString('en-US')}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-neutral-600">
                  {fare.taxes.toLocaleString('en-US')}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-neutral-600">
                  {fare.ait.toLocaleString('en-US')}
                </td>
                <td className="px-3 py-2 text-center text-sm tabular-nums text-neutral-600">
                  {fare.count}
                </td>
                {hasServiceMargin && (
                  <td className="px-3 py-2 text-right text-sm tabular-nums text-amber-700">
                    {fare.serviceMargin.toLocaleString('en-US')}
                  </td>
                )}
                <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums text-navy-950">
                  {formatPrice(fare.totalPrice, currency)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-neutral-300 bg-navy-50/70">
              <td
                colSpan={hasServiceMargin ? 6 : 5}
                className="px-3 py-2 text-right text-sm font-semibold text-navy-700"
              >
                Total price
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold tabular-nums text-brand-orange-dark">
                {formatPrice(option.totalPrice, currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BaggageDetails({ option }: { option: FlightFareOption }) {
  const segments = option.legs.flatMap((leg) => leg.segments);

  if (segments.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-500">
        No baggage information is available for this option.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => (
        <div
          key={`${segment.from}-${segment.to}-${index}`}
          className="overflow-hidden rounded-xl border border-neutral-200 bg-white"
        >
          <div className="border-b border-neutral-200 bg-navy-50/70 px-4 py-2.5">
            <span className="text-sm font-semibold text-navy-700">Route </span>
            <span className="text-sm font-medium text-navy-950">
              {segment.from} → {segment.to}
            </span>
          </div>
          <div className="grid grid-cols-1 divide-y divide-neutral-200 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="p-3 sm:p-4">
              <div className="mb-3 flex items-center gap-2">
                <BriefcaseBusiness
                  className="h-5 w-5 shrink-0 text-brand-orange"
                  aria-hidden
                />
                <span className="text-sm font-semibold text-navy-950">
                  Check-in
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-neutral-500">Allowance</span>
                <span className="text-sm font-semibold text-navy-950">
                  {segment.baggage ?? 'Not provided'}
                </span>
              </div>
            </div>

            <div className="p-3 sm:p-4">
              <div className="mb-3 flex items-center gap-2">
                <Package
                  className="h-5 w-5 shrink-0 text-emerald-600"
                  aria-hidden
                />
                <span className="text-sm font-semibold text-navy-950">
                  Cabin
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-neutral-500">Allowance</span>
                <span className="text-sm font-semibold text-navy-950">
                  {segment.handBaggage ?? 'Not provided'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ))}

      <p className="text-xs text-neutral-500">
        Baggage rules may vary by airline and fare brand. The supplier currently
        provides the lead-passenger allowance for each segment.
      </p>
    </div>
  );
}

export function PolicyDetails({
  option,
  type,
  status,
  rules,
  error,
  onRetry,
}: {
  option: FlightFareOption;
  type: 'cancellation' | 'date-change';
  status: 'loading' | 'success' | 'error';
  rules: FareRuleSection[];
  error: string | null;
  onRetry: () => void;
}) {
  const isCancellation = type === 'cancellation';
  const sectionName = isCancellation
    ? 'cancellation penalties'
    : 'date-change penalties';
  const matchingRules = rules.filter((rule) => {
    const ruleType = rule.type.toLowerCase().replace(/[-_]+/g, ' ');

    return isCancellation
      ? /\b(refund|cancel(?:lation)?|no\s*show)\b/.test(ruleType)
      : /\b(exchange|changes?|reissue)\b/.test(ruleType);
  });
  const route = option.legs
    .map((leg) => `${leg.from} → ${leg.to}`)
    .join(' · ');

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-navy-50/70 px-4 py-2.5">
        <Route className="h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
        <span className="text-sm font-semibold text-navy-950">{route}</span>
      </div>

      {status === 'loading' && (
        <div
          className="flex min-h-36 flex-col items-center justify-center gap-3 p-6 text-center"
          role="status"
        >
          <Loader2
            className="h-6 w-6 animate-spin text-brand-orange"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-navy-950">
              Loading {sectionName}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Requesting the latest fare rules from the airline.
            </p>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="p-4">
          <div
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3"
            role="alert"
          >
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-red-700"
              aria-hidden
            />
            <div>
              <p className="text-sm font-semibold text-red-900">
                {sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}{' '}
                unavailable
              </p>
              <p className="mt-1 text-sm leading-6 text-red-800">
                {error ??
                  'The fare rules could not be loaded. Please try again.'}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-2 text-xs font-semibold text-red-800 ring-1 ring-red-200 transition hover:bg-red-100"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {status === 'success' && matchingRules.length === 0 && (
        <div className="flex min-h-36 items-start gap-2 p-4">
          <AlertCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-navy-950">
              No {sectionName} returned
            </p>
            <p className="mt-1 text-sm leading-6 text-neutral-600">
              {isCancellation
                ? `The search marks this fare as ${
                    option.refundable ? 'refundable' : 'non-refundable'
                  }, but the airline did not return Refund, Cancellation, or No Show penalties.`
                : 'The airline did not return Exchange, Change, or Reissue penalties for this fare.'}
            </p>
          </div>
        </div>
      )}

      {status === 'success' && matchingRules.length > 0 && (
        <div className="divide-y divide-neutral-200">
          {matchingRules.map((rule, index) => (
            <section key={`${rule.type}-${index}`} className="p-4">
              <p className="text-sm font-semibold text-navy-950">
                {rule.type}
              </p>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-5 text-neutral-700 [overflow-wrap:anywhere]">
                {rule.detail}
              </pre>
            </section>
          ))}
        </div>
      )}

      {status === 'success' && (
        <p className="border-t border-neutral-200 bg-navy-50/40 px-4 py-2.5 text-xs text-neutral-500">
          Fare rules are supplied directly by the airline/GDS and apply to this
          fare option.
        </p>
      )}
    </div>
  );
}

export function AirlinePolicyDetails({
  option,
  status,
  rules,
  error,
  onRetry,
}: {
  option: FlightFareOption;
  status: 'loading' | 'success' | 'error';
  rules: FareRuleSection[];
  error: string | null;
  onRetry: () => void;
}) {
  const route = option.legs
    .map((leg) => `${leg.from} → ${leg.to}`)
    .join(' · ');

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-navy-50/70 px-4 py-2.5">
        <Route className="h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
        <span className="text-sm font-semibold text-navy-950">{route}</span>
      </div>

      {status === 'loading' && (
        <div
          className="flex min-h-36 flex-col items-center justify-center gap-3 p-6 text-center"
          role="status"
        >
          <Loader2
            className="h-6 w-6 animate-spin text-brand-orange"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-navy-950">
              Loading airline policies
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Requesting the latest fare rules from the airline.
            </p>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="p-4">
          <div
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3"
            role="alert"
          >
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-red-700"
              aria-hidden
            />
            <div>
              <p className="text-sm font-semibold text-red-900">
                Airline policies unavailable
              </p>
              <p className="mt-1 text-sm leading-6 text-red-800">
                {error ??
                  'The fare rules could not be loaded. Please try again.'}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-2 text-xs font-semibold text-red-800 ring-1 ring-red-200 transition hover:bg-red-100"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {status === 'success' && rules.length === 0 && (
        <div className="flex min-h-36 items-start gap-2 p-4">
          <AlertCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-navy-950">
              No detailed fare rules returned
            </p>
            <p className="mt-1 text-sm leading-6 text-neutral-600">
              The airline accepted the request but did not provide a policy
              narrative for this fare.
            </p>
          </div>
        </div>
      )}

      {status === 'success' && rules.length > 0 && (
        <div className="divide-y divide-neutral-200">
          {rules.map((rule, index) => (
            <section key={`${rule.type}-${index}`} className="p-4">
              <p className="text-sm font-semibold text-navy-950">
                {rule.type}
              </p>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-5 text-neutral-700 [overflow-wrap:anywhere]">
                {rule.detail}
              </pre>
            </section>
          ))}
        </div>
      )}

      {status === 'success' && (
        <p className="border-t border-neutral-200 bg-navy-50/40 px-4 py-2.5 text-xs text-neutral-500">
          Fare rules are supplied directly by the airline/GDS and apply to this
          fare option.
        </p>
      )}
    </div>
  );
}
