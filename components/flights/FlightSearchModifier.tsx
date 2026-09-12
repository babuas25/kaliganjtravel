'use client';

import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  MapPin,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react';
import { useId, useState } from 'react';

import FlightSearchPanel from '@/components/layout/FlightSearchPanel';
import type { AirportOption } from '@/lib/airports/types';
import { CABIN_CLASSES } from '@/lib/flights/cabin';
import type { FlightSearchInput } from '@/lib/flights/types';

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function routeSummary(input: FlightSearchInput): string {
  return input.routes
    .map((route) => `${route.origin} → ${route.destination}`)
    .join(' · ');
}

function dateSummary(input: FlightSearchInput): string {
  return input.routes.map((route) => formatDate(route.departureDate)).join(' · ');
}

function travelerSummary(input: FlightSearchInput): string {
  const total = input.adults + input.children + input.infants;
  const cabin = CABIN_CLASSES.find((option) => option.value === input.cabinClass)?.label ?? 'Economy';
  return `${total} traveller${total === 1 ? '' : 's'} · ${cabin}`;
}

function tripTypeSummary(input: FlightSearchInput): string {
  if (input.tripType === 'round') return 'Round trip';
  if (input.tripType === 'multicity') return 'Multi-city';
  return 'One way';
}

function SummaryItem({
  icon: Icon,
  label,
  value,
  className = '',
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 items-start gap-3 ${className}`}>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
          {label}
        </p>
        <p className="mt-0.5 truncate text-sm font-bold text-navy-950 sm:text-[15px]" title={value}>
          {value}
        </p>
      </div>
    </div>
  );
}

function ModifyButton({
  isOpen,
  contentId,
  onClick,
  className = '',
}: {
  isOpen: boolean;
  contentId: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      aria-controls={contentId}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-md bg-brand-orange px-5 text-sm font-semibold text-black shadow-md shadow-brand-orange/20 transition hover:bg-brand-orange/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 ${className}`}
    >
      <SlidersHorizontal className="h-4 w-4" aria-hidden />
      {isOpen ? 'Hide search' : 'Modify search'}
      {isOpen ? (
        <ChevronUp className="h-4 w-4" aria-hidden />
      ) : (
        <ChevronDown className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

export default function FlightSearchModifier({
  input,
  initialAirports,
}: {
  input: FlightSearchInput;
  initialAirports: Record<string, AirportOption>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const contentId = useId();

  return (
    <section className="rounded-lg border border-neutral-200 bg-white shadow-sm">
      <div className="p-3 sm:hidden">
        <div className="space-y-2 text-xs text-neutral-600">
          <div className="flex min-w-0 items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
            <span className="truncate font-bold text-navy-950" title={routeSummary(input)}>
              {routeSummary(input)}
            </span>
            <span className="h-3.5 w-px shrink-0 bg-neutral-200" aria-hidden />
            <span className="flex shrink-0 items-center gap-1.5 font-medium text-navy-950">
              <CalendarDays className="h-3.5 w-3.5 text-brand-orange" aria-hidden />
              {dateSummary(input)}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-brand-orange-light px-2 py-1 font-bold text-brand-orange-dark">
              {tripTypeSummary(input)}
            </span>
            <UsersRound className="h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden />
            <span className="truncate font-medium text-navy-950">
              {travelerSummary(input)}
            </span>
          </div>
        </div>

        <ModifyButton
          isOpen={isOpen}
          contentId={contentId}
          onClick={() => setIsOpen((open) => !open)}
          className="mt-3 h-10 w-full"
        />
      </div>

      <div className="hidden gap-4 p-4 sm:grid sm:grid-cols-2 sm:p-5 lg:grid-cols-[1.25fr_1fr_1fr_auto] lg:items-center">
        <SummaryItem
          icon={MapPin}
          label={input.tripType === 'multicity' ? 'Routes' : 'Route'}
          value={routeSummary(input)}
          className="sm:col-span-2 lg:col-span-1"
        />
        <SummaryItem icon={CalendarDays} label="Date" value={dateSummary(input)} />
        <SummaryItem icon={UsersRound} label="Travellers" value={travelerSummary(input)} />

        <ModifyButton
          isOpen={isOpen}
          contentId={contentId}
          onClick={() => setIsOpen((open) => !open)}
          className="min-h-11 py-2.5 sm:col-span-2 lg:col-span-1"
        />
      </div>

      {isOpen && (
        <div
          id={contentId}
          className="border-t border-neutral-200 bg-navy-50/60 p-4 sm:p-5 lg:p-6"
        >
          <FlightSearchPanel
            initialInput={input}
            initialAirports={initialAirports}
            variant="modify"
            onSubmitted={() => setIsOpen(false)}
          />
        </div>
      )}
    </section>
  );
}
