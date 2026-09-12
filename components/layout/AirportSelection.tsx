'use client';

import { Clock, MapPin, PlaneTakeoff, Star } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { addToAirportHistory, getRecentAirports } from '@/lib/airports/history';
import { POPULAR_BANGLADESH_AIRPORTS } from '@/lib/airports/popular';
import type { AirportOption } from '@/lib/airports/types';
import { cn } from '@/lib/utils';

export type { AirportOption };

function normalize(value: string) {
  return value.trim().toLowerCase();
}

type AirportSearchEnvelope = {
  success?: boolean;
  data?: { items?: AirportOption[] };
};

// One cache per page load: the dataset is static, so a query answered once
// never has to go back to the server. Requests in flight are shared too, so the
// From and To fields asking the same thing only cost one round trip.
const airportSearchCache = new Map<string, AirportOption[]>();
const airportSearchRequests = new Map<string, Promise<AirportOption[]>>();

async function loadAirportOptions(query: string): Promise<AirportOption[]> {
  const key = normalize(query);
  const cached = airportSearchCache.get(key);
  if (cached) return cached;

  const pending = airportSearchRequests.get(key);
  if (pending) return pending;

  const params = new URLSearchParams({ limit: '80' });
  if (key) params.set('q', key);

  const request = fetch(`/api/airports?${params.toString()}`)
    .then(async (response) => {
      const payload = (await response.json()) as AirportSearchEnvelope;
      const items = payload.data?.items;
      if (!response.ok || payload.success === false || !Array.isArray(items)) {
        throw new Error('Failed to fetch airport suggestions');
      }

      airportSearchCache.set(key, items);
      return items;
    })
    .finally(() => airportSearchRequests.delete(key));

  airportSearchRequests.set(key, request);
  return request;
}

/** The From / To cells are narrow, so the list gets its own floor to read on. */
const MIN_DROPDOWN_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

type DropdownPosition = { top: number; left: number; width: number };

/** Place the list under the field, widened to a readable size and kept on screen. */
function measureDropdown(container: HTMLElement): DropdownPosition {
  const rect = container.getBoundingClientRect();
  const available = window.innerWidth - VIEWPORT_MARGIN * 2;
  const width = Math.min(Math.max(rect.width, MIN_DROPDOWN_WIDTH), available);
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN);
  // The portal is `position: fixed`, so these are viewport coordinates. Do NOT
  // add scroll offsets, or the list drifts as the page scrolls.
  return { top: rect.bottom + 8, left, width };
}

type AirportSelectionProps = {
  label: string;
  value: AirportOption | null;
  onChange: (airport: AirportOption) => void;
  inputId: string;
  inputName: string;
  placeholder?: string;
  className?: string;
};

/**
 * From / To field: shows the picked airport as "City (IATA)" with the airport
 * name underneath, and opens a searchable dropdown on focus. Empty query lists
 * the visitor's recent picks first, then the popular Bangladesh airports.
 */
export default function AirportSelection({
  label,
  value,
  onChange,
  inputId,
  inputName,
  placeholder,
  className,
}: AirportSelectionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [backendQuery, setBackendQuery] = useState<string | null>(null);
  const [backendResults, setBackendResults] = useState<AirportOption[]>([]);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDropdownPosition(null);
    } else if (containerRef.current) {
      setDropdownPosition(measureDropdown(containerRef.current));
    }
  }, [open]);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const el = containerRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      const dropdownEl = dropdownRef.current;
      if (target && (el.contains(target) || dropdownEl?.contains(target))) return;
      setOpen(false);
    }

    function updateDropdownPosition() {
      if (open && containerRef.current) {
        setDropdownPosition(measureDropdown(containerRef.current));
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    // Capture phase: the panel itself may scroll, not just the window.
    window.addEventListener('scroll', updateDropdownPosition, true);
    window.addEventListener('resize', updateDropdownPosition);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('scroll', updateDropdownPosition, true);
      window.removeEventListener('resize', updateDropdownPosition);
    };
  }, [open]);

  // Debounced fetch. An empty query goes out immediately so the list is already
  // populated by the time the dropdown paints.
  useEffect(() => {
    if (!open) return;

    const normalizedQuery = normalize(query);
    let active = true;
    const timeoutId = window.setTimeout(
      () => {
        void loadAirportOptions(normalizedQuery)
          .then((items) => {
            if (!active) return;
            setBackendResults(items);
            setBackendQuery(normalizedQuery);
          })
          .catch((error) => {
            console.error('Airport suggestion error:', error);
            if (!active) return;
            setBackendResults([]);
            setBackendQuery(normalizedQuery);
          });
      },
      normalizedQuery ? 150 : 0
    );

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [open, query]);

  const filtered = useMemo(() => {
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
      const recentOptions: AirportOption[] = getRecentAirports().map((item, index) => ({
        id: `recent-${item.iata}-${index}`,
        name: item.name,
        city: item.city,
        country: item.country,
        iata: item.iata,
        isRecent: true,
      }));
      const results = [...recentOptions];
      const seenIatas = new Set(recentOptions.map((airport) => airport.iata));

      // Until the first response lands, fall back to the local shortlist so the
      // dropdown never opens empty.
      const popularOptions: AirportOption[] = POPULAR_BANGLADESH_AIRPORTS.map((airport, index) => ({
        id: `popular-${airport.iata}-${index}`,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        iata: airport.iata,
        isPopular: true,
      }));
      const defaults = backendQuery === '' ? backendResults : popularOptions;

      for (const airport of defaults) {
        if (seenIatas.has(airport.iata)) continue;
        results.push(airport);
        seenIatas.add(airport.iata);
        if (results.length >= 15) break;
      }

      return results;
    }

    // Only render results that answer the query currently in the box.
    return backendQuery === normalizedQuery ? backendResults : [];
  }, [backendQuery, backendResults, query]);

  const inputValue = open
    ? query
    : value
      ? value.isCity
        ? `${value.city} - ${value.iata}`
        : `${value.city} (${value.iata})`
      : '';

  return (
    <div ref={containerRef} className={cn('relative min-w-0', className)}>
      <label htmlFor={inputId} className="block cursor-text text-xs text-neutral-500">
        {label}
      </label>
      <input
        id={inputId}
        name={inputName}
        value={inputValue}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setQuery(''); // Start from a clean box rather than editing the pick.
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        aria-expanded={open}
        className="mt-0.5 w-full truncate bg-transparent text-base font-bold text-navy-950 outline-none placeholder:font-normal placeholder:text-neutral-400 md:mt-1 md:text-[17px]"
      />

      {/* Always rendered, even when empty, so the panel does not jump height. */}
      <p className="truncate text-xs text-neutral-500 md:mt-0.5 md:text-[13px]">
        {!open && value ? (value.isCity ? 'All Airports' : value.name) : ' '}
      </p>

      {open && dropdownPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={dropdownRef}
              className="fixed z-50 overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-[0_12px_32px_-8px_rgba(23,23,23,0.18)]"
              style={{
                top: dropdownPosition.top,
                left: dropdownPosition.left,
                width: dropdownPosition.width,
              }}
            >
              <div className="airport-suggestions-scroll max-h-72 overflow-y-auto overscroll-contain">
                {filtered.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-neutral-500">No airports found</p>
                ) : (
                  filtered.map((airport, index) => {
                    const showRecentHeader = !query && airport.isRecent && index === 0;
                    const showPopularHeader =
                      !query && airport.isPopular && (index === 0 || !filtered[index - 1]?.isPopular);
                    // A sub-item is an airport under a city row: it shares the
                    // cityCode of the nearest city row above it, so every
                    // airport of that city indents, not just the first.
                    const isSubItem =
                      !airport.isCity &&
                      !!airport.cityCode &&
                      (() => {
                        for (let i = index - 1; i >= 0; i--) {
                          const previous = filtered[i];
                          if (previous && previous.isCity) {
                            return previous.cityCode === airport.cityCode;
                          }
                        }
                        return false;
                      })();
                    const showCityHeading = airport.isCity && !!query && airport.city;

                    return (
                      // The indent lives on the wrapper, not the button: a
                      // margin on a w-full button would overflow the list.
                      <div key={airport.id} className={isSubItem ? 'pl-2' : undefined}>
                        {showRecentHeader && (
                          <p className="border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold text-neutral-600">
                            Recent Selections
                          </p>
                        )}
                        {showPopularHeader && (
                          <p className="border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold text-neutral-600">
                            Popular in Bangladesh
                          </p>
                        )}
                        {showCityHeading && (
                          <p className="border-b border-neutral-200/60 px-4 pb-1.5 pt-3 text-sm font-semibold text-navy-950">
                            {airport.city}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            // Popular and recent rows are already in the list,
                            // so only fresh picks are worth recording.
                            if (!airport.isRecent && !airport.isPopular) {
                              addToAirportHistory({
                                iata: airport.iata,
                                name: airport.isCity ? 'All Airports' : airport.name,
                                city: airport.city,
                                country: airport.country,
                              });
                            }
                            onChange(airport);
                            setOpen(false);
                          }}
                          className={cn(
                            'flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-brand-orange-light/60 focus-visible:bg-brand-orange-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange',
                            isSubItem ? 'border-l-2 border-neutral-200 pl-8 pr-4' : 'px-4'
                          )}
                        >
                          <span className="shrink-0">
                            {airport.isCity ? (
                              <MapPin className="h-4 w-4 text-neutral-500" aria-hidden />
                            ) : airport.isRecent ? (
                              <Clock className="h-4 w-4 text-navy-600" aria-hidden />
                            ) : airport.isPopular ? (
                              <Star className="h-4 w-4 text-brand-orange-dark" aria-hidden />
                            ) : (
                              <PlaneTakeoff className="h-4 w-4 text-neutral-500" aria-hidden />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-navy-950">
                              {isSubItem ? airport.name : `${airport.city}, ${airport.country}`}
                              {airport.isRecent && (
                                <span className="ml-2 text-xs font-normal text-navy-600">
                                  Recent
                                </span>
                              )}
                              {airport.isPopular && (
                                <span className="ml-2 text-xs font-normal text-brand-orange-dark">
                                  Popular
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-neutral-500">
                              {isSubItem
                                ? airport.city
                                : airport.isCity
                                  ? 'All Airports'
                                  : airport.name}
                            </span>
                          </span>
                          <span className="ml-2 shrink-0 rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-600">
                            {airport.iata}
                          </span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
