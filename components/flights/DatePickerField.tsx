'use client';

import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function clampMonth(date: Date, min: Date, max: Date): Date {
  const month = startOfMonth(date);
  if (month.getTime() < min.getTime()) return min;
  if (month.getTime() > max.getTime()) return max;
  return month;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
}

/** `"2026-08-15"` as a local-midnight Date, or undefined when unparseable. */
function parseIso(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function toIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const displayFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Month grid with month and year dropdowns.
 *
 * Anything outside `[minDate, maxDate]` is rendered but unclickable, and both
 * dropdowns refuse to travel past the range — the bounds come from the
 * passenger's age window, so a picker that could not leave them is the point.
 */
function Calendar({
  selected,
  onSelect,
  minDate,
  maxDate,
  defaultMonth,
}: {
  selected: Date | undefined;
  onSelect: (date: Date) => void;
  minDate: Date;
  maxDate: Date;
  defaultMonth: Date | undefined;
}) {
  const minMonth = startOfMonth(minDate);
  const maxMonth = startOfMonth(maxDate);

  const [month, setMonth] = useState<Date>(() =>
    clampMonth(defaultMonth ?? selected ?? new Date(), minMonth, maxMonth)
  );

  useEffect(() => {
    setMonth(
      clampMonth(selected ?? defaultMonth ?? new Date(), minMonth, maxMonth)
    );
    // Compared by timestamp: these are fresh Date objects on every render, so
    // depending on the objects themselves would re-run this every time.
  }, [
    selected?.getTime(),
    defaultMonth?.getTime(),
    minMonth.getTime(),
    maxMonth.getTime(),
  ]);

  const years = useMemo(() => {
    const first = minMonth.getFullYear();
    const last = maxMonth.getFullYear();
    return Array.from({ length: Math.max(1, last - first + 1) }, (_, index) =>
      // Newest first: every one of these fields asks for a past date, so the
      // useful years are at the top rather than 120 rows down.
      last - index
    );
  }, [minMonth, maxMonth]);

  const monthAllowed = (year: number, monthIndex: number) => {
    const candidate = new Date(year, monthIndex, 1).getTime();
    return candidate >= minMonth.getTime() && candidate <= maxMonth.getTime();
  };

  const changeYear = (year: number) => {
    let target = month.getMonth();
    if (!monthAllowed(year, target)) {
      const firstAllowed = MONTHS.findIndex((_, index) =>
        monthAllowed(year, index)
      );
      if (firstAllowed < 0) return;
      target = firstAllowed;
    }
    setMonth(new Date(year, target, 1));
  };

  const previous = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const canGoBack = previous.getTime() >= minMonth.getTime();
  const canGoForward = next.getTime() <= maxMonth.getTime();

  const firstWeekday = new Date(
    month.getFullYear(),
    month.getMonth(),
    1
  ).getDay();
  const dayCount = endOfMonth(month).getDate();
  const today = new Date();

  const arrowClass = (enabled: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded-md transition ${
      enabled
        ? 'text-neutral-600 hover:bg-navy-50 hover:text-navy-950'
        : 'cursor-not-allowed text-neutral-300'
    }`;

  const dropdownClass =
    'h-8 cursor-pointer appearance-none rounded border border-neutral-300 bg-white py-1 pl-3 pr-8 text-sm font-medium text-navy-950 transition hover:bg-navy-50/60 focus:outline-none focus:ring-2 focus:ring-brand-orange/50';

  return (
    <div className="p-3">
      <div className="flex w-full items-center justify-between px-1 pb-2 pt-1">
        <button
          type="button"
          onClick={() => canGoBack && setMonth(previous)}
          disabled={!canGoBack}
          aria-label="Previous month"
          className={arrowClass(canGoBack)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={month.getMonth()}
              onChange={(event) => {
                const index = Number(event.target.value);
                if (monthAllowed(month.getFullYear(), index)) {
                  setMonth(new Date(month.getFullYear(), index, 1));
                }
              }}
              aria-label="Month"
              className={dropdownClass}
            >
              {MONTHS.map((name, index) => (
                <option
                  key={name}
                  value={index}
                  disabled={!monthAllowed(month.getFullYear(), index)}
                >
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute inset-y-0 right-2 my-auto h-4 w-4 text-neutral-500"
              aria-hidden
            />
          </div>

          <div className="relative">
            <select
              value={month.getFullYear()}
              onChange={(event) => changeYear(Number(event.target.value))}
              aria-label="Year"
              className={dropdownClass}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute inset-y-0 right-2 my-auto h-4 w-4 text-neutral-500"
              aria-hidden
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => canGoForward && setMonth(next)}
          disabled={!canGoForward}
          aria-label="Next month"
          className={arrowClass(canGoForward)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="flex h-8 items-center justify-center text-xs font-medium text-neutral-500"
          >
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstWeekday }, (_, index) => (
          <div key={`pad-${index}`} className="h-9" />
        ))}
        {Array.from({ length: dayCount }, (_, index) => {
          const day = index + 1;
          const date = new Date(month.getFullYear(), month.getMonth(), day);
          const outOfRange =
            date.getTime() < minDate.getTime() ||
            date.getTime() > maxDate.getTime();
          const isSelected = selected ? sameDay(date, selected) : false;
          const isToday = sameDay(date, today);

          return (
            <button
              key={day}
              type="button"
              disabled={outOfRange}
              onClick={() => onSelect(date)}
              aria-label={displayFormatter.format(date)}
              aria-current={isToday ? 'date' : undefined}
              className={`h-9 w-9 rounded-md text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-brand-orange/40 ${
                outOfRange
                  ? 'pointer-events-none opacity-40'
                  : isSelected
                    ? 'bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white'
                    : isToday
                      ? 'bg-navy-50 font-bold text-navy-950 hover:bg-navy-100'
                      : 'text-navy-950 hover:bg-navy-50'
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A date field that opens a bounded calendar instead of the browser's own.
 *
 * `min` and `max` are ISO dates rather than `Date`s so callers can pass the
 * age-window strings the booking route validates against, with no timezone
 * conversion in between.
 */
export function DatePickerField({
  value,
  onChange,
  min,
  max,
  placeholder = 'Select date',
  ariaLabel,
  invalid = false,
}: {
  value: string;
  onChange: (value: string) => void;
  min: string;
  max: string;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  const minDate = parseIso(min) ?? new Date(1900, 0, 1);
  const maxDate = parseIso(max) ?? new Date();

  // Open on a month the traveller can actually pick in. Leaving this undefined
  // lets the calendar clamp today into the range, which lands on the nearest
  // useful month from either direction: an adult's birth year for a date that
  // must be in the past, and the first valid month for a passport expiry that
  // must be in the future.
  const defaultMonth = useMemo(() => {
    if (
      selected &&
      selected.getTime() >= minDate.getTime() &&
      selected.getTime() <= maxDate.getTime()
    ) {
      return selected;
    }
    return undefined;
    // Keyed on the ISO strings rather than the parsed Dates, which are new
    // objects on every render.
  }, [value, min, max]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={`flex h-[42px] w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-left text-sm transition hover:bg-navy-50/60 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-orange ${
            invalid ? 'border-brand-orange' : 'border-neutral-300'
          } ${selected ? 'text-navy-950' : 'text-neutral-400'}`}
        >
          <span className="truncate">
            {selected ? displayFormatter.format(selected) : placeholder}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto border-neutral-200 p-0">
        <Calendar
          selected={selected}
          minDate={minDate}
          maxDate={maxDate}
          defaultMonth={defaultMonth}
          onSelect={(date) => {
            onChange(toIso(date));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
