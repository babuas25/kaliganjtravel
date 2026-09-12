'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

const CALENDAR_WIDTH = 336;
const CALENDAR_HEIGHT = 380;
const VIEWPORT_MARGIN = 8;
/** Below this the calendar is centred over a backdrop instead of anchored. */
const MOBILE_BREAKPOINT = 768;

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type FlightDatePickerProps = {
  label: string;
  /** ISO date, `YYYY-MM-DD`. Empty string means nothing picked yet. */
  value: string;
  onChange: (date: string) => void;
  disabled?: boolean;
  /** Visually subdued while remaining interactive. */
  muted?: boolean;
  /** Called immediately before the calendar opens. */
  onOpen?: () => void;
  placeholder?: string;
  className?: string;
  /** Earliest selectable date, ISO. Defaults to today. */
  minDate?: string;
  /** Month to open on when nothing is picked yet, ISO. */
  openToDate?: string;
};

function formatDisplayDate(value: string) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    day: new Intl.DateTimeFormat('en', { day: '2-digit' }).format(d),
    month: new Intl.DateTimeFormat('en', { month: 'short' }).format(d),
    year: new Intl.DateTimeFormat('en', { year: 'numeric' }).format(d),
    weekday: new Intl.DateTimeFormat('en', { weekday: 'long' }).format(d),
  };
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

/** Local-time ISO date. `toISOString()` would shift the day in +06 Dhaka. */
export function formatDateToString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTodayDate(): string {
  return formatDateToString(new Date());
}

export function getTomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDateToString(tomorrow);
}

/** `date` shifted by `days`, both ISO. Empty input gives tomorrow. */
export function addDays(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return getTomorrowDate();
  parsed.setDate(parsed.getDate() + days);
  return formatDateToString(parsed);
}

/** Parse an ISO date as local midnight; invalid input falls back to null. */
function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  const [year, month, day] = parts.map((part) => parseInt(part, 10));
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Months since year 0 — the comparable form of "which month is shown". */
function monthKey(date: Date) {
  return date.getFullYear() * 12 + date.getMonth();
}

type CalendarPosition = { top: number; left: number; isMobile: boolean };

/**
 * Departure / Return field: reads like the rest of the panel, and opens a
 * month calendar that never lets the visitor pick a date before `minDate`.
 */
export default function FlightDatePicker({
  label,
  value,
  onChange,
  disabled = false,
  muted = false,
  onOpen,
  placeholder = 'Select date',
  className,
  minDate,
  openToDate,
}: FlightDatePickerProps) {
  const containerRef = useRef<HTMLButtonElement | null>(null);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<CalendarPosition | null>(null);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const now = new Date();
    return { month: now.getMonth(), year: now.getFullYear() };
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const displayDate = formatDisplayDate(value);
  const selectedDate = parseIsoDate(value);
  const minimumDate = parseIsoDate(minDate) ?? today;
  const minimumMonthKey = monthKey(minimumDate);
  const visibleMonthKey = visibleMonth.year * 12 + visibleMonth.month;
  const isPrevDisabled = visibleMonthKey <= minimumMonthKey;

  const calculatePosition = useCallback(() => {
    const trigger = containerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { innerWidth, innerHeight } = window;
    const isMobile = innerWidth < MOBILE_BREAKPOINT;

    if (isMobile) {
      // Centred, and pinned near the top whenever the field sits too low for
      // the calendar to fit under it.
      const left = Math.max(VIEWPORT_MARGIN, (innerWidth - CALENDAR_WIDTH) / 2);
      const spaceBelow = innerHeight - rect.bottom - VIEWPORT_MARGIN * 2;
      const top = spaceBelow < CALENDAR_HEIGHT ? 20 : rect.bottom + VIEWPORT_MARGIN;
      setPosition({ top, left, isMobile });
      return;
    }

    const left = Math.min(
      Math.max(rect.left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, innerWidth - CALENDAR_WIDTH - VIEWPORT_MARGIN)
    );
    const spaceBelow = innerHeight - rect.bottom - VIEWPORT_MARGIN * 2;
    const spaceAbove = rect.top - VIEWPORT_MARGIN * 2;
    const top =
      spaceBelow >= CALENDAR_HEIGHT || spaceBelow >= spaceAbove
        ? rect.bottom + VIEWPORT_MARGIN
        : Math.max(VIEWPORT_MARGIN, rect.top - CALENDAR_HEIGHT - VIEWPORT_MARGIN);

    setPosition({ top, left, isMobile });
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (calendarRef.current?.contains(target)) return;
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    // Capture phase: an ancestor may scroll, not just the window.
    window.addEventListener('scroll', calculatePosition, true);
    window.addEventListener('resize', calculatePosition);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', calculatePosition, true);
      window.removeEventListener('resize', calculatePosition);
    };
  }, [isOpen, calculatePosition]);

  const openCalendar = () => {
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
      return;
    }

    onOpen?.();

    // Open on the picked date, else where the caller points us, else the first
    // month the visitor is allowed to choose from.
    const anchor = selectedDate ?? parseIsoDate(openToDate) ?? minimumDate;
    const clampedKey = Math.max(monthKey(anchor), minimumMonthKey);
    setVisibleMonth({ year: Math.floor(clampedKey / 12), month: clampedKey % 12 });

    calculatePosition();
    setIsOpen(true);
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    setVisibleMonth((current) => {
      const key = current.year * 12 + current.month + (direction === 'prev' ? -1 : 1);
      if (direction === 'prev' && key < minimumMonthKey) return current;
      return { year: Math.floor(key / 12), month: key % 12 };
    });
  };

  const handleDateClick = (day: number) => {
    const picked = new Date(visibleMonth.year, visibleMonth.month, day);
    picked.setHours(0, 0, 0, 0);
    if (picked.getTime() < minimumDate.getTime()) return;

    onChange(formatDateToString(picked));
    setIsOpen(false);
  };

  const renderCalendar = () => {
    if (!position) return null;

    const { year, month } = visibleMonth;
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    const monthName = new Intl.DateTimeFormat('en', { month: 'long' }).format(
      new Date(year, month)
    );

    const cells = [];
    for (let i = 0; i < firstDay; i++) {
      cells.push(<div key={`empty-${i}`} className="h-10" />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      date.setHours(0, 0, 0, 0);

      const isToday = date.getTime() === today.getTime();
      const isSelected = !!selectedDate && date.getTime() === selectedDate.getTime();
      // Same-day is allowed: a return on the day of departure is a valid trip.
      const isDisabled = date.getTime() < minimumDate.getTime();

      cells.push(
        <button
          key={day}
          type="button"
          onClick={() => handleDateClick(day)}
          disabled={isDisabled}
          aria-current={isToday ? 'date' : undefined}
          className={cn(
            'mx-auto h-10 w-10 rounded-full text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40',
            isDisabled && 'cursor-not-allowed text-neutral-300',
            !isDisabled && !isSelected && 'text-navy-950 hover:bg-brand-orange-light hover:text-brand-orange-dark',
            !isDisabled && !isSelected && isToday && 'font-bold text-brand-orange ring-1 ring-inset ring-brand-orange/30',
            isSelected && 'bg-brand-orange text-navy-950 shadow-md shadow-brand-orange/30'
          )}
        >
          {day}
        </button>
      );
    }

    return createPortal(
      <>
        {position.isMobile && (
          <div className="fixed inset-0 z-[60] bg-black/20" aria-hidden onMouseDown={() => setIsOpen(false)} />
        )}
        <div
          ref={calendarRef}
          role="dialog"
          aria-label={`${label} date`}
          className="fixed z-[61] max-h-[calc(100vh-40px)] overflow-auto rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl"
          style={{ top: position.top, left: position.left, width: CALENDAR_WIDTH }}
        >
          <div className="mb-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => navigateMonth('prev')}
              disabled={isPrevDisabled}
              aria-label="Previous month"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-100 hover:text-navy-950 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <p className="text-sm font-semibold text-navy-950">
              {monthName} {year}
            </p>
            <button
              type="button"
              onClick={() => navigateMonth('next')}
              aria-label="Next month"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-100 hover:text-navy-950"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="mb-2 grid grid-cols-7 gap-1">
            {WEEK_DAYS.map((day) => (
              <div
                key={day}
                className="flex h-8 items-center justify-center text-xs font-medium text-neutral-500"
              >
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">{cells}</div>
        </div>
      </>,
      document.body
    );
  };

  return (
    <>
      <button
        ref={containerRef}
        type="button"
        onClick={openCalendar}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={cn(
          'min-w-0 text-left transition',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-neutral-50/60',
          muted && !disabled && 'opacity-50',
          className
        )}
      >
        <span className="block text-xs text-neutral-500">{label}</span>
        {/* Smaller than the From / To value on phones, as the dates are longer. */}
        <span className="mt-0.5 block truncate text-sm font-bold text-navy-950 md:mt-1 md:text-[17px]">
          {displayDate ? `${displayDate.day} ${displayDate.month}, ${displayDate.year}` : placeholder}
        </span>
        {/* Always rendered, even when empty, so the row keeps its height. */}
        <span className="block truncate text-xs text-neutral-500 md:mt-0.5 md:text-[13px]">
          {displayDate ? displayDate.weekday : ' '}
        </span>
      </button>

      {isOpen && renderCalendar()}
    </>
  );
}
