'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import { ChevronDown, ChevronUp, Filter, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import AirlineLogo from '@/components/flights/AirlineLogo';
import { formatDuration, formatPrice, type AirlineFilter } from '@/lib/flights/types';

export type StopFilterKey = 'nonstop' | 'one' | 'twoPlus';
export type DepartureBandKey = 'night' | 'morning' | 'afternoon' | 'evening';

export type NumericRange = {
  min: number;
  max: number;
};

export type FlightFilterState = {
  stops: StopFilterKey[];
  refundableOnly: boolean;
  price: NumericRange;
  duration: NumericRange;
  departureBands: DepartureBandKey[];
  airlines: string[];
};

export type FlightFilterOptions = {
  stopCounts: Record<StopFilterKey, number>;
  refundableCount: number;
  priceBounds: NumericRange;
  durationBounds: NumericRange;
  departureCounts: Record<DepartureBandKey, number>;
};

const STOP_OPTIONS: { key: StopFilterKey; label: string }[] = [
  { key: 'nonstop', label: 'Non-stop' },
  { key: 'one', label: '1 stop' },
  { key: 'twoPlus', label: '2+ stops' },
];

const DEPARTURE_OPTIONS: {
  key: DepartureBandKey;
  label: string;
  time: string;
}[] = [
  { key: 'night', label: 'Night', time: '00–06' },
  { key: 'morning', label: 'Morning', time: '06–12' },
  { key: 'afternoon', label: 'Afternoon', time: '12–18' },
  { key: 'evening', label: 'Evening', time: '18–24' },
];

function toggleValue<T extends string>(values: T[], key: T, checked: boolean): T[] {
  if (checked) return values.includes(key) ? values : [...values, key];
  return values.filter((value) => value !== key);
}

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-t border-neutral-200 px-5 py-5 first:border-t-0">
      <legend className="sr-only">{title}</legend>
      <p aria-hidden className="mb-3 text-sm font-bold text-navy-950">
        {title}
      </p>
      {children}
    </fieldset>
  );
}

function CheckboxRow({
  id,
  checked,
  disabled = false,
  label,
  count,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  count: number;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="border-neutral-300 data-[state=checked]:border-brand-orange data-[state=checked]:bg-brand-orange"
      />
      <label
        htmlFor={id}
        className={`flex min-w-0 flex-1 items-center gap-2.5 ${
          disabled ? 'cursor-not-allowed text-neutral-300' : 'cursor-pointer text-neutral-700'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-xs tabular-nums text-neutral-400">{count}</span>
      </label>
    </div>
  );
}

function RangeFilter({
  label,
  bounds,
  value,
  step,
  formatValue,
  onChange,
}: {
  label: string;
  bounds: NumericRange;
  value: NumericRange;
  step: number;
  formatValue: (value: number) => string;
  onChange: (value: NumericRange) => void;
}) {
  const sliderMax = Math.max(bounds.max, bounds.min + step);
  const disabled = bounds.min === bounds.max;

  return (
    <div>
      <SliderPrimitive.Root
        aria-label={label}
        className="relative flex h-6 w-full touch-none select-none items-center"
        min={bounds.min}
        max={sliderMax}
        step={step}
        value={[value.min, value.max]}
        minStepsBetweenThumbs={0}
        disabled={disabled}
        onValueChange={([min, max]) =>
          onChange({
            min: Math.max(bounds.min, min),
            max: Math.min(bounds.max, max),
          })
        }
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-neutral-200">
          <SliderPrimitive.Range className="absolute h-full bg-brand-orange" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={`${label} minimum`}
          className="block h-4 w-4 rounded-full border-2 border-brand-orange bg-white shadow-sm outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-brand-orange disabled:opacity-60"
        />
        <SliderPrimitive.Thumb
          aria-label={`${label} maximum`}
          className="block h-4 w-4 rounded-full border-2 border-brand-orange bg-white shadow-sm outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-brand-orange disabled:opacity-60"
        />
      </SliderPrimitive.Root>
      <div className="mt-1.5 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Min</p>
          <p className="mt-0.5 text-xs font-bold text-navy-950">{formatValue(value.min)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Max</p>
          <p className="mt-0.5 text-xs font-bold text-navy-950">{formatValue(value.max)}</p>
        </div>
      </div>
    </div>
  );
}

function activeFilterCount(value: FlightFilterState, options: FlightFilterOptions): number {
  return (
    Number(value.stops.length > 0) +
    Number(value.refundableOnly) +
    Number(
      value.price.min !== options.priceBounds.min ||
        value.price.max !== options.priceBounds.max
    ) +
    Number(
      value.duration.min !== options.durationBounds.min ||
        value.duration.max !== options.durationBounds.max
    ) +
    Number(value.departureBands.length > 0) +
    Number(value.airlines.length > 0)
  );
}

export default function FlightFilters({
  value,
  options,
  airlines = [],
  currency = 'BDT',
  resultCount,
  onChange,
  onClear,
  mobileOpen: controlledMobileOpen,
  onMobileOpenChange,
  showMobileTrigger = true,
  contentId: providedContentId,
}: {
  value: FlightFilterState;
  options: FlightFilterOptions;
  airlines?: AirlineFilter[];
  currency?: string;
  resultCount: number;
  onChange: (value: FlightFilterState) => void;
  onClear: () => void;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  showMobileTrigger?: boolean;
  contentId?: string;
}) {
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  const generatedContentId = useId();
  const contentId = providedContentId ?? generatedContentId;
  const mobileOpen = controlledMobileOpen ?? internalMobileOpen;
  const setMobileOpen = (open: boolean) => {
    if (controlledMobileOpen === undefined) setInternalMobileOpen(open);
    onMobileOpenChange?.(open);
  };
  const activeCount = activeFilterCount(value, options);

  return (
    <div className="contents lg:sticky lg:top-5 lg:block">
      {showMobileTrigger && (
        <button
          type="button"
          aria-expanded={mobileOpen}
          aria-controls={contentId}
          onClick={() => setMobileOpen(!mobileOpen)}
          className="flex w-full items-center justify-between rounded-md bg-white px-4 py-3 text-sm font-bold text-navy-950 shadow-sm ring-1 ring-neutral-200 lg:hidden"
        >
          <span className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-brand-orange" aria-hidden />
            Filters
            {activeCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-orange px-1.5 text-[10px] text-navy-950">
                {activeCount}
              </span>
            )}
          </span>
          {mobileOpen ? (
            <ChevronUp className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden />
          )}
        </button>
      )}

      <aside
        id={contentId}
        aria-label="Flight filters"
        className={`${mobileOpen ? `${showMobileTrigger ? 'mt-3' : 'mt-0'} block` : 'hidden'} overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-neutral-200 lg:mt-0 lg:block lg:max-h-[calc(100vh-2.5rem)] lg:overflow-y-auto`}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-brand-orange" aria-hidden />
            <h2 className="font-bold text-navy-950">Filters</h2>
            {activeCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-orange px-1.5 text-[10px] font-bold text-navy-950">
                {activeCount}
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={activeCount === 0}
            onClick={onClear}
            className="flex items-center gap-1 text-xs font-semibold text-brand-orange transition hover:text-brand-orange-dark disabled:cursor-default disabled:text-neutral-300"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Clear
          </button>
        </div>

        <FilterSection title="Stops">
          <div className="space-y-0.5">
            {STOP_OPTIONS.map((option) => (
              <CheckboxRow
                key={option.key}
                id={`${contentId}-stops-${option.key}`}
                checked={value.stops.includes(option.key)}
                disabled={options.stopCounts[option.key] === 0}
                label={option.label}
                count={options.stopCounts[option.key]}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    stops: toggleValue(value.stops, option.key, checked),
                  })
                }
              />
            ))}
          </div>
        </FilterSection>

        {airlines.length > 0 && (
          <FilterSection title="Airlines">
            <CheckboxRow
              id={`${contentId}-airlines-all`}
              checked={value.airlines.length === 0}
              label="All airlines"
              count={airlines.reduce((total, airline) => total + airline.totalFlights, 0)}
              onCheckedChange={() => onChange({ ...value, airlines: [] })}
            />
            {[...airlines].sort((a, b) => a.minPrice - b.minPrice).map((airline) => (
              <div key={airline.airlineCode} className="flex items-center gap-2.5 py-2 text-sm">
                <Checkbox
                  id={`${contentId}-airline-${airline.airlineCode}`}
                  checked={value.airlines.includes(airline.airlineCode)}
                  onCheckedChange={(checked) => onChange({
                    ...value,
                    airlines: toggleValue(value.airlines, airline.airlineCode, checked === true),
                  })}
                  className="border-neutral-300 data-[state=checked]:border-brand-orange data-[state=checked]:bg-brand-orange"
                />
                <label
                  htmlFor={`${contentId}-airline-${airline.airlineCode}`}
                  title={airline.airlineName}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-neutral-700"
                >
                  <AirlineLogo airlineCode={airline.airlineCode} size={20} />
                  <span className="shrink-0 text-xs font-semibold">
                    <span className="sr-only">{airline.airlineName} </span>
                    {airline.airlineCode} <span className="font-normal text-neutral-400">({airline.totalFlights})</span>
                  </span>
                  <span className="ml-auto text-right text-[11px] tabular-nums text-neutral-500">
                    {airline.minPrice > 0 ? formatPrice(airline.minPrice, currency) : 'Fare unavailable'}
                  </span>
                </label>
              </div>
            ))}
          </FilterSection>
        )}

        <FilterSection title="Fare flexibility">
          <CheckboxRow
            id={`${contentId}-refundable`}
            checked={value.refundableOnly}
            disabled={options.refundableCount === 0}
            label="Refundable fares only"
            count={options.refundableCount}
            onCheckedChange={(checked) => onChange({ ...value, refundableOnly: checked })}
          />
        </FilterSection>

        <FilterSection title="Price range">
          <RangeFilter
            label="Price range"
            bounds={options.priceBounds}
            value={value.price}
            step={1}
            formatValue={(amount) => `BDT ${Math.round(amount).toLocaleString('en-US')}`}
            onChange={(price) => onChange({ ...value, price })}
          />
        </FilterSection>

        <FilterSection title="Journey duration">
          <RangeFilter
            label="Journey duration"
            bounds={options.durationBounds}
            value={value.duration}
            step={5}
            formatValue={(minutes) => formatDuration(Math.max(0, Math.round(minutes)))}
            onChange={(duration) => onChange({ ...value, duration })}
          />
        </FilterSection>

        <FilterSection title="Outbound departure">
          <div className="grid grid-cols-2 gap-2">
            {DEPARTURE_OPTIONS.map((option) => {
              const selected = value.departureBands.includes(option.key);
              const count = options.departureCounts[option.key];
              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={count === 0}
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      ...value,
                      departureBands: toggleValue(
                        value.departureBands,
                        option.key,
                        !selected
                      ),
                    })
                  }
                  className={`rounded-md border px-2 py-2 text-center transition ${
                    selected
                      ? 'border-brand-orange bg-brand-orange-light text-brand-orange-dark'
                      : 'border-neutral-200 bg-neutral-50 text-neutral-600 hover:border-neutral-300'
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <span className="block text-[10px] font-semibold uppercase tracking-wide">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs font-bold">{option.time}</span>
                  <span className="mt-0.5 block text-[10px]">{count} flights</span>
                </button>
              );
            })}
          </div>
        </FilterSection>

        <div className="border-t border-neutral-200 p-4 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="w-full rounded-md bg-brand-orange px-4 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white"
          >
            Show {resultCount} {resultCount === 1 ? 'flight' : 'flights'}
          </button>
        </div>
      </aside>
    </div>
  );
}
