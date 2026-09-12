'use client';

import { useId, useState } from 'react';
import { Check, ChevronDown, Plane, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AIRLINE_CATALOG } from '@/lib/airlines/catalog';

export default function PreferredAirlines({
  className = '',
  value,
  onChange,
}: {
  className?: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const labelId = useId();
  const summaryId = useId();
  const nameFor = (code: string) => AIRLINE_CATALOG.find((airline) => airline.code === code)?.name ?? code;
  const matches = AIRLINE_CATALOG.filter((airline) =>
    `${airline.code} ${airline.name}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  const toggle = (code: string) => onChange(
    value.includes(code) ? value.filter((selected) => selected !== code) : [...value, code]
  );

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span id={labelId} className="font-medium text-neutral-500">Preferred Airlines</span>
        <span className="text-neutral-400">Optional</span>
      </div>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); setQuery(''); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={`${labelId} ${summaryId}`}
            className={`flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 text-left text-sm transition hover:border-navy-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 ${value.length ? 'border-brand-orange/40 bg-brand-orange-light/40' : 'border-neutral-200 bg-navy-50/50'}`}
          >
            <Plane className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
            <span id={summaryId} className="min-w-0 flex-1 truncate font-medium text-navy-950">
              {value.length ? nameFor(value[0]) : 'Any airline'}
            </span>
            {value.length > 1 && <span className="rounded-md bg-white px-1.5 py-0.5 text-xs font-semibold text-navy-700">+{value.length - 1}<span className="sr-only"> more airlines</span></span>}
            <ChevronDown className={`h-4 w-4 shrink-0 text-neutral-400 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} collisionPadding={12} aria-labelledby={labelId}
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border-neutral-200 bg-white p-0 text-navy-950 shadow-xl">
          <div className="shrink-0 border-b border-neutral-100 p-3">
            <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 focus-within:border-brand-orange focus-within:ring-2 focus-within:ring-brand-orange/15">
              <Search className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
              <input value={query} onChange={(event) => setQuery(event.target.value)}
                aria-label="Search airlines by name or code" placeholder="Search by airline or code"
                className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-neutral-400" />
              {query && <button type="button" aria-label="Clear airline search" onClick={() => setQuery('')} className="rounded p-1 text-neutral-500 hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange"><X className="h-4 w-4" /></button>}
            </div>
            {value.length > 0 && (
              <div className="mt-3 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {value.map((code) => <button key={code} type="button" onClick={() => toggle(code)} aria-label={`Remove ${nameFor(code)}`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-brand-orange-light px-2 py-1.5 text-xs font-medium text-navy-950 hover:bg-brand-orange/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">
                  <span className="truncate">{nameFor(code)}</span><X className="h-3 w-3 shrink-0" aria-hidden />
                </button>)}
              </div>
            )}
          </div>
          <div role="group" aria-label="Airlines" className="min-h-0 max-h-60 overflow-y-auto overscroll-contain p-1.5">
            {matches.map((airline) => (
              <label key={airline.code} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition hover:bg-neutral-50 has-[:checked]:bg-brand-orange-light/50">
                <input type="checkbox" checked={value.includes(airline.code)} onChange={() => toggle(airline.code)} className="peer sr-only" />
                <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300 peer-checked:border-brand-orange peer-checked:bg-brand-orange peer-focus-visible:ring-2 peer-focus-visible:ring-brand-orange peer-focus-visible:ring-offset-2">
                  {value.includes(airline.code) && <Check className="h-3 w-3" />}
                </span>
                <span className="flex-1">{airline.name}</span>
                <span className="text-xs font-medium text-neutral-400">{airline.code}</span>
              </label>
            ))}
            {matches.length === 0 && <p role="status" className="px-3 py-6 text-center text-sm text-neutral-500">No airlines found. Try another name or code.</p>}
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-neutral-100 bg-neutral-50/70 px-3 py-2.5">
            <span role="status" className="text-xs text-neutral-500">{value.length ? `${value.length} selected` : 'All airlines included'}</span>
            <div className="flex items-center gap-2">
              {value.length > 0 && <button type="button" onClick={() => onChange([])} className="min-h-9 rounded-lg px-2 text-xs font-medium text-neutral-500 hover:text-navy-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">Clear all</button>}
              <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-lg bg-navy-950 px-4 text-xs font-semibold text-white hover:bg-navy-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2">Done</button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
