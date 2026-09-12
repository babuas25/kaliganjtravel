'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useRef } from 'react';

import AirlineLogo from '@/components/flights/AirlineLogo';
import { formatPrice, type AirlineFilter } from '@/lib/flights/types';

export default function AirlineFilterBar({
  airlines,
  selectedAirlines,
  currency,
  onChange,
}: {
  airlines: AirlineFilter[];
  selectedAirlines: string[];
  currency: string;
  onChange: (airlines: string[]) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sortedAirlines = useMemo(
    () => [...airlines].sort((a, b) => a.minPrice - b.minPrice),
    [airlines]
  );
  const selectedAirline =
    selectedAirlines.length === 1 ? selectedAirlines[0] : null;

  if (sortedAirlines.length === 0) return null;

  const chooseAirline = (airlineCode: string | null) => {
    if (!airlineCode || selectedAirline === airlineCode) {
      onChange([]);
      return;
    }
    onChange([airlineCode]);
  };

  const scrollBy = (distance: number) => {
    scrollerRef.current?.scrollBy({ left: distance, behavior: 'smooth' });
  };

  return (
    <nav
      aria-label="Filter by airline"
      className="w-full rounded-lg bg-white p-2 shadow-sm ring-1 ring-neutral-200"
    >
      <div className="flex min-w-0 items-stretch gap-2">
        <button
          type="button"
          onClick={() => scrollBy(-260)}
          aria-label="Scroll airlines left"
          className="flex w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition hover:border-brand-orange/40 hover:bg-brand-orange-light hover:text-brand-orange-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>

        <div
          ref={scrollerRef}
          className="min-w-0 flex-1 overflow-x-auto scroll-smooth whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex min-w-max items-stretch gap-2">
            <button
              type="button"
              aria-pressed={selectedAirlines.length === 0}
              onClick={() => chooseAirline(null)}
              className={`flex min-h-11 shrink-0 items-center rounded-md border px-4 text-xs font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange ${
                selectedAirlines.length === 0
                  ? 'border-brand-orange/40 bg-brand-orange-light text-brand-orange-dark'
                  : 'border-neutral-200 bg-white text-navy-950 hover:border-neutral-300 hover:bg-neutral-50'
              }`}
            >
              All
            </button>

            {sortedAirlines.map((airline) => {
              const isActive = selectedAirline === airline.airlineCode;

              return (
                <button
                  key={airline.airlineCode}
                  type="button"
                  title={airline.airlineName}
                  aria-label={`Show ${airline.airlineName} flights`}
                  aria-pressed={isActive}
                  onClick={() => chooseAirline(airline.airlineCode)}
                  className={`flex min-h-11 min-w-[142px] max-w-[210px] shrink-0 items-center gap-2 rounded-md border px-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange ${
                    isActive
                      ? 'border-brand-orange/50 bg-brand-orange-light'
                      : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50'
                  }`}
                >
                  <AirlineLogo airlineCode={airline.airlineCode} size={24} />
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-[11px] font-bold text-navy-950">
                      {airline.airlineCode} ({airline.totalFlights})
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-neutral-500">
                      {airline.minPrice > 0
                        ? formatPrice(airline.minPrice, currency)
                        : 'Fare unavailable'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => scrollBy(260)}
          aria-label="Scroll airlines right"
          className="flex w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition hover:border-brand-orange/40 hover:bg-brand-orange-light hover:text-brand-orange-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </nav>
  );
}
