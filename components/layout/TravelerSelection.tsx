'use client';

import { CircleUserRound, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CABIN_CLASSES, DEFAULT_CABIN_CLASS, type CabinClassLabel } from '@/lib/flights/cabin';
import { cn } from '@/lib/utils';

/**
 * Cabin ladder, widest first — and exactly the five the Triplover API defines.
 *
 * This used to carry three combined rungs ("Economy/Premium Economy" and
 * friends). The API takes a single cabin integer with no value for "either of
 * these", so those rungs could only ever have been sent as one of their halves:
 * a visitor picking a combined rung would have searched something they did not
 * ask for. `lib/flights/cabin.ts` is now the single source of truth for both
 * this list and the integer the search request carries.
 */
export const BOOKING_CLASSES: readonly CabinClassLabel[] = CABIN_CLASSES.map((c) => c.label);

export type BookingClass = CabinClassLabel;

export type TravelerData = {
  adults: number;
  children: number;
  infants: number;
  /** One entry per child; 0 means the age has not been chosen yet. */
  childrenAges: number[];
  bookingClass: BookingClass;
};

export const DEFAULT_TRAVELERS: TravelerData = {
  adults: 1,
  children: 0,
  infants: 0,
  childrenAges: [],
  bookingClass: DEFAULT_CABIN_CLASS,
};

/** A child is 2 to 11; from 12 they book as an adult. */
const CHILD_AGES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const UNSET_AGE = 0;
/** Adults and children take a seat each, and there are only nine to sell. */
const MAX_SEATS = 9;
const MAX_CHILDREN = 8;

const POPUP_WIDTH = 360;
const MIN_POPUP_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;
const MOBILE_BREAKPOINT = 768;

type PopupLayout = { top: number; left: number; maxHeight: number; width: number; isMobile: boolean };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function totalTravelers(value: TravelerData) {
  return value.adults + value.children + value.infants;
}

export function travelerSummary(value: TravelerData) {
  const total = totalTravelers(value);
  return `${total} Traveller${total > 1 ? 's' : ''}`;
}

/** Every child needs an age before the selection can be applied. */
function hasMissingChildAge(value: TravelerData) {
  return (
    value.children > 0 &&
    Array.from({ length: value.children }).some((_, index) => !value.childrenAges[index])
  );
}

type CounterRowProps = {
  label: string;
  /** Singular noun for the screen-reader labels ("adult", "child"). */
  unit: string;
  subtitle: string;
  count: number;
  canDecrement: boolean;
  canIncrement: boolean;
  onChange: (next: number) => void;
};

function CounterRow({
  label,
  unit,
  subtitle,
  count,
  canDecrement,
  canIncrement,
  onChange,
}: CounterRowProps) {
  const stepper = (enabled: boolean) =>
    cn(
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white transition',
      enabled ? 'bg-brand-orange hover:bg-brand-orange-dark hover:text-white' : 'cursor-not-allowed bg-brand-orange/25'
    );

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <CircleUserRound className="h-5 w-5 shrink-0 text-brand-orange" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy-950">{label}</p>
          <p className="text-xs text-neutral-500">{subtitle}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(count - 1)}
          disabled={!canDecrement}
          aria-label={`Remove one ${unit}`}
          className={stepper(canDecrement)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-4 text-center text-sm font-semibold text-navy-950" aria-live="polite">
          {count}
        </span>
        <button
          type="button"
          onClick={() => onChange(count + 1)}
          disabled={!canIncrement}
          aria-label={`Add one ${unit}`}
          className={stepper(canIncrement)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

type TravelerSelectionProps = {
  value: TravelerData;
  onChange: (value: TravelerData) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Traveller / class field: opens a popup with a counter per passenger type, an
 * age dropdown per child, and the cabin ladder. Edits are held locally until
 * Done, so an abandoned popup leaves the search untouched.
 */
export default function TravelerSelection({
  value,
  onChange,
  disabled = false,
  className,
}: TravelerSelectionProps) {
  const instanceId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<TravelerData>(value);
  const [layout, setLayout] = useState<PopupLayout | null>(null);

  const seats = draft.adults + draft.children;
  const missingChildAge = hasMissingChildAge(draft);

  const calculateLayout = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { innerWidth, innerHeight } = window;
    const isMobile = innerWidth < MOBILE_BREAKPOINT;
    const width = Math.min(POPUP_WIDTH, innerWidth - VIEWPORT_MARGIN * 2);
    const left = isMobile
      ? Math.max(VIEWPORT_MARGIN, (innerWidth - width) / 2)
      : clamp(rect.left, VIEWPORT_MARGIN, innerWidth - width - VIEWPORT_MARGIN);

    const spaceBelow = innerHeight - rect.bottom - VIEWPORT_MARGIN * 2;
    const spaceAbove = rect.top - VIEWPORT_MARGIN * 2;
    // Drop below unless there is meaningfully more room above.
    const placeBelow = spaceBelow >= MIN_POPUP_HEIGHT || spaceBelow >= spaceAbove;
    const available = placeBelow ? spaceBelow : spaceAbove;
    const maxHeight = clamp(
      Math.max(MIN_POPUP_HEIGHT, available),
      MIN_POPUP_HEIGHT,
      innerHeight - VIEWPORT_MARGIN * 2
    );
    const top = placeBelow
      ? Math.min(rect.bottom + VIEWPORT_MARGIN, innerHeight - VIEWPORT_MARGIN - maxHeight)
      : Math.max(VIEWPORT_MARGIN, rect.top - VIEWPORT_MARGIN - maxHeight);

    setLayout({ top: Math.max(VIEWPORT_MARGIN, top), left, maxHeight, width, isMobile });
  }, []);

  const closeWithoutApplying = useCallback(() => {
    setDraft(value);
    setIsOpen(false);
  }, [value]);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      closeWithoutApplying();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeWithoutApplying();
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    // Capture phase: an ancestor may scroll, not just the window.
    window.addEventListener('scroll', calculateLayout, true);
    window.addEventListener('resize', calculateLayout);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', calculateLayout, true);
      window.removeEventListener('resize', calculateLayout);
    };
  }, [isOpen, calculateLayout, closeWithoutApplying]);

  const togglePopup = () => {
    if (disabled) return;
    if (isOpen) {
      closeWithoutApplying();
      return;
    }
    setDraft(value);
    calculateLayout();
    setIsOpen(true);
  };

  const setAdults = (next: number) => {
    setDraft((prev) => ({
      ...prev,
      adults: next,
      // An infant travels on an adult's lap, so it cannot outnumber them.
      infants: Math.min(prev.infants, next),
    }));
  };

  const setChildren = (next: number) => {
    setDraft((prev) => {
      const ages = prev.childrenAges.slice(0, next);
      while (ages.length < next) ages.push(UNSET_AGE);
      return { ...prev, children: next, childrenAges: ages };
    });
  };

  const setChildAge = (index: number, age: number) => {
    setDraft((prev) => {
      const ages = [...prev.childrenAges];
      ages[index] = age;
      return { ...prev, childrenAges: ages };
    });
  };

  const applySelection = () => {
    if (missingChildAge) return;
    onChange(draft);
    setIsOpen(false);
  };

  const renderPopup = () => {
    if (!layout) return null;

    return createPortal(
      <>
        {layout.isMobile && (
          <div
            className="fixed inset-0 z-[60] bg-black/20"
            aria-hidden
            onMouseDown={closeWithoutApplying}
          />
        )}
        <div
          ref={popupRef}
          role="dialog"
          aria-label="Travellers and booking class"
          className="fixed z-[61] flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white p-3 shadow-2xl"
          style={{
            top: layout.top,
            left: layout.left,
            width: layout.width,
            maxHeight: layout.maxHeight,
          }}
        >
          <div className="min-h-0 overflow-y-auto">
          <p className="border-b border-neutral-200 pb-2 text-sm font-semibold text-navy-950">
            Travellers
          </p>

          <CounterRow
            label="Adult"
            unit="adult"
            subtitle="12 years and above"
            count={draft.adults}
            canDecrement={draft.adults > 1}
            canIncrement={seats < MAX_SEATS}
            onChange={setAdults}
          />

          <CounterRow
            label="Children"
            unit="child"
            subtitle="2 years - under 12 years"
            count={draft.children}
            canDecrement={draft.children > 0}
            canIncrement={draft.children < MAX_CHILDREN && seats < MAX_SEATS}
            onChange={setChildren}
          />

          {draft.children > 0 && (
            <div className="pb-1">
              <div className="grid grid-cols-3 gap-3">
                {Array.from({ length: draft.children }).map((_, index) => (
                  <div key={index}>
                    <label
                      htmlFor={`${instanceId}-child-age-${index}`}
                      className="block text-xs text-neutral-600"
                    >
                      Child {index + 1} Age
                    </label>
                    <select
                      id={`${instanceId}-child-age-${index}`}
                      value={draft.childrenAges[index] || ''}
                      onChange={(e) => setChildAge(index, Number(e.target.value))}
                      className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-navy-950 outline-none focus:border-brand-orange"
                    >
                      <option value="">Choose</option>
                      {CHILD_AGES.map((age) => (
                        <option key={age} value={age}>
                          {age}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {missingChildAge && (
                <p className="mt-2 text-xs text-brand-orange">Please add child Age.</p>
              )}
            </div>
          )}

          <CounterRow
            label="Infants"
            unit="infant"
            subtitle="Below 2 years"
            count={draft.infants}
            canDecrement={draft.infants > 0}
            canIncrement={draft.infants < draft.adults}
            onChange={(next) => setDraft((prev) => ({ ...prev, infants: next }))}
          />

          <p className="mt-1 border-b border-neutral-200 pb-2 pt-2 text-sm font-semibold text-navy-950">
            Booking Class
          </p>
          <div className="grid grid-cols-2 gap-x-2 py-1">
            {BOOKING_CLASSES.map((bookingClass) => {
              const isActive = draft.bookingClass === bookingClass;
              return (
                // `relative` anchors the visually-hidden input to its own row.
                // Without it the input sits at the panel's top-left, and
                // focusing it scrolls the panel away mid-click.
                <label
                  key={bookingClass}
                  className="relative flex min-h-8 cursor-pointer items-center gap-2 py-1.5"
                >
                  <input
                    type="radio"
                    // Scoped per instance: the desktop and mobile panels are
                    // both in the DOM, and a shared name would fuse them.
                    name={`booking-class-${instanceId}`}
                    aria-label={bookingClass}
                    className="peer sr-only"
                    checked={isActive}
                    onChange={() => setDraft((prev) => ({ ...prev, bookingClass }))}
                  />
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-orange peer-focus-visible:ring-offset-2',
                      isActive ? 'border-brand-orange' : 'border-neutral-800'
                    )}
                  >
                    {isActive && <span className="h-2 w-2 rounded-full bg-brand-orange" />}
                  </span>
                  <span
                    className={cn(
                      'text-[13px] leading-4',
                      isActive ? 'font-semibold text-brand-orange-dark' : 'text-neutral-800'
                    )}
                  >
                    {bookingClass}
                  </span>
                </label>
              );
            })}
          </div>

          </div>

          <div className="mt-1 flex shrink-0 gap-2 border-t border-neutral-200 pt-2">
            <button
              type="button"
              onClick={() => setDraft(DEFAULT_TRAVELERS)}
              className="flex-1 rounded-xl border border-neutral-300 py-2 text-sm font-semibold text-navy-950 transition hover:bg-neutral-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={applySelection}
              disabled={missingChildAge}
              className={cn(
                'flex-1 rounded-xl py-2 text-sm font-semibold text-white transition',
                missingChildAge
                  ? 'cursor-not-allowed bg-neutral-300'
                  : 'bg-brand-orange hover:bg-brand-orange-dark hover:text-white'
              )}
            >
              Done
            </button>
          </div>
        </div>
      </>,
      document.body
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePopup}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={cn(
          'min-w-0 text-left transition',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-neutral-50/60',
          className
        )}
      >
        <span className="block text-xs text-neutral-500">Traveller, Class</span>
        <span className="mt-0.5 block truncate text-[15px] font-bold text-navy-950 md:mt-1 md:text-[17px]">
          {travelerSummary(value)}
        </span>
        <span className="block truncate text-xs text-neutral-500 md:mt-0.5 md:text-[13px]">
          {value.bookingClass}
        </span>
      </button>

      {isOpen && renderPopup()}
    </>
  );
}
