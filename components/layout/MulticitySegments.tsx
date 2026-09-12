'use client';

import { ArrowLeftRight, ArrowUpDown, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

import AirportSelection from '@/components/layout/AirportSelection';
import FlightDatePicker, { getTodayDate } from '@/components/layout/FlightDatePicker';
import type { AirportOption } from '@/lib/airports/types';
import { cn } from '@/lib/utils';

/** One leg of a multi-city trip. */
export type FlightSegment = {
  id: string;
  from: AirportOption | null;
  to: AirportOption | null;
  /** ISO `YYYY-MM-DD`, or '' when not picked. */
  departureDate: string;
};

/** Two legs is the shortest trip that is not just a one-way. */
export const MIN_SEGMENTS = 2;
export const MAX_SEGMENTS = 6;

type MulticitySegmentsProps = {
  segments: FlightSegment[];
  /** `row` is the md+ layout — four columns per leg; `stacked` is the phone card. */
  layout: 'row' | 'stacked';
  /** Namespaces the field ids — the two layouts are both in the DOM. */
  idPrefix: string;
  onChange: (id: string, patch: Partial<FlightSegment>) => void;
  onSwap: (id: string) => void;
  onRemove: (id: string) => void;
  /** `row` only: fills the fourth column beside trip 1 (the traveller field). */
  firstRowAction?: ReactNode;
  /** `row` only: fills the fourth column beside the last trip (Add City). */
  lastRowAction?: ReactNode;
  className?: string;
};

/**
 * The legs of a multi-city search. Each leg gets From, To and Departure; the
 * fourth column carries the traveller field on the first row and Add City on
 * the last, so the block stays the same width as the one-way layout above it.
 *
 * A leg can only depart on or after the one before it, so the calendar for trip
 * N opens on trip N-1's date and refuses anything earlier.
 */
export default function MulticitySegments({
  segments,
  layout,
  idPrefix,
  onChange,
  onSwap,
  onRemove,
  firstRowAction,
  lastRowAction,
  className,
}: MulticitySegmentsProps) {
  const isRow = layout === 'row';
  const canRemove = segments.length > MIN_SEGMENTS;

  return (
    <div className={cn(isRow ? 'space-y-3' : 'space-y-4', className)}>
      {segments.map((segment, index) => {
        const previousDate = index > 0 ? segments[index - 1]?.departureDate : '';
        const isFirst = index === 0;
        const isLast = index === segments.length - 1;

        const fromField = (
          <AirportSelection
            label="From"
            inputId={`${idPrefix}-from-${segment.id}`}
            inputName={`${idPrefix}-from-${segment.id}`}
            value={segment.from}
            onChange={(value) => onChange(segment.id, { from: value })}
            placeholder="City or airport"
            className={cn('flex-1', isRow ? 'px-4 py-2 md:py-3' : 'py-2.5 pl-3.5 pr-16')}
          />
        );

        const toField = (
          <AirportSelection
            label="To"
            inputId={`${idPrefix}-to-${segment.id}`}
            inputName={`${idPrefix}-to-${segment.id}`}
            value={segment.to}
            onChange={(value) => onChange(segment.id, { to: value })}
            placeholder="City or airport"
            className={cn(
              'flex-1',
              isRow ? 'px-4 py-2 md:py-3' : 'border-t border-neutral-200 py-2.5 pl-3.5 pr-16'
            )}
          />
        );

        const swapButton = (
          <button
            type="button"
            onClick={() => onSwap(segment.id)}
            aria-label={`Swap origin and destination for trip ${index + 1}`}
            className={cn(
              'absolute z-10 flex h-10 w-10 items-center justify-center rounded-full border-4 border-white bg-brand-orange text-navy-950 shadow-md shadow-brand-orange/40 transition hover:bg-brand-orange-dark hover:text-white',
              isRow
                ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
                : 'right-4 top-1/2 -translate-y-1/2'
            )}
          >
            {isRow ? <ArrowLeftRight className="h-4 w-4" /> : <ArrowUpDown className="h-4 w-4" />}
          </button>
        );

        const dateField = (
          <FlightDatePicker
            label="Departure"
            value={segment.departureDate}
            onChange={(value) => onChange(segment.id, { departureDate: value })}
            minDate={previousDate || getTodayDate()}
            openToDate={previousDate}
            className={cn('flex-1', isRow ? 'px-4 py-2 md:py-3' : 'px-3.5 py-2.5')}
          />
        );

        if (isRow) {
          return (
            <div key={segment.id} className="flex items-stretch gap-3">
              {/* From and To are their own boxes; the swap button straddles the
                  gap between them. */}
              <div className="relative flex min-w-0 flex-[2] gap-3">
                <div className="flex min-w-0 flex-1 rounded-xl border border-neutral-200">
                  {fromField}
                </div>
                <div className="flex min-w-0 flex-1 rounded-xl border border-neutral-200">
                  {toField}
                </div>
                {swapButton}
              </div>

              <div className="flex min-w-0 flex-1 rounded-xl border border-neutral-200">
                {dateField}
              </div>

              {/* Fourth column: traveller on the first row, Add City on the
                  last, empty in between so every row lines up. */}
              <div className="flex min-w-0 flex-1 items-center">
                {isFirst ? firstRowAction : isLast ? lastRowAction : null}
              </div>

              {canRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(segment.id)}
                  aria-label={`Remove trip ${index + 1}`}
                  className="flex w-9 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-brand-orange-light hover:text-brand-orange"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          );
        }

        return (
          <div key={segment.id}>
            {/* Stacked legs need a label — unlike the desktop rows, there is no
                left-to-right reading order to make the order obvious. */}
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full bg-brand-orange-light px-2.5 py-1 text-[11px] font-semibold text-brand-orange-dark">
                Trip {index + 1}
              </span>
              {canRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(segment.id)}
                  className="flex items-center gap-1 text-xs font-medium text-neutral-500 transition hover:text-brand-orange"
                >
                  <X className="h-3.5 w-3.5" />
                  Remove
                </button>
              )}
            </div>

            <div className="relative mt-1.5 rounded-xl border border-neutral-200">
              {fromField}
              {toField}
              {swapButton}
            </div>

            <div className="mt-2 flex rounded-xl border border-neutral-200">{dateField}</div>
          </div>
        );
      })}
    </div>
  );
}

type AddCityButtonProps = {
  count: number;
  onClick: () => void;
  className?: string;
};

/** Adds the next leg. Greys out at the ceiling rather than disappearing. */
export function AddCityButton({ count, onClick, className }: AddCityButtonProps) {
  const isFull = count >= MAX_SEGMENTS;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isFull}
      title={isFull ? `Up to ${MAX_SEGMENTS} flights can be searched at once` : undefined}
      className={cn(
        'flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white transition',
        isFull
          ? 'cursor-not-allowed bg-neutral-300'
          : 'bg-brand-orange shadow-lg shadow-brand-orange/30 hover:bg-brand-orange-dark hover:text-white',
        className
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white',
          isFull ? 'text-neutral-400' : 'text-brand-orange'
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </span>
      Add City
    </button>
  );
}
