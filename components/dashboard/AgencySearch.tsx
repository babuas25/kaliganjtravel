'use client';

import { useId, useState } from 'react';
import { Building2, Check } from 'lucide-react';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { agencyOptionLabel, type AgencyOption } from '@/lib/agency';

export default function AgencySearch({ agencies, value, onChange, label = 'B2B agency', disabled = false, required = false }: {
  label?: string;
  disabled?: boolean;
  required?: boolean;
  agencies: AgencyOption[];
  value: string;
  onChange: (agencyCode: string) => void;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = agencies.find((agency) => agency.agencyCode === value);

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-neutral-700">{label}{required && <span className="ml-0.5 text-brand-orange">*</span>}</label>
      <Command
        className="relative overflow-visible rounded-xl border border-neutral-300 bg-white text-navy-950 focus-within:border-navy-500 focus-within:ring-2 focus-within:ring-navy-100 [&_[cmdk-input-wrapper]]:border-0"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
          if (event.key === 'ArrowDown' && !open) {
            setSearch('');
            setOpen(true);
          }
        }}
      >
        <CommandInput
          id={inputId}
          aria-label="Search B2B agency"
          aria-expanded={open}
          autoComplete="off"
          disabled={disabled || !agencies.length}
          aria-required={required}
          placeholder={agencies.length ? 'Search agency name or code…' : 'No B2B agencies found'}
          className="h-11 font-semibold placeholder:font-normal"
          value={open ? search : selected ? agencyOptionLabel(selected) : ''}
          onFocus={() => { setSearch(''); setOpen(true); }}
          onClick={() => { if (!open) { setSearch(''); setOpen(true); } }}
          onValueChange={(text) => { setSearch(text); setOpen(true); }}
        />
          <CommandList hidden={!open} className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl" aria-label="Agency suggestions">
            <CommandEmpty>No agencies found. Try another name or agency code.</CommandEmpty>
            {agencies.map((agency) => (
              <CommandItem
                key={agency.agencyCode}
                value={agency.agencyCode}
                keywords={[agency.label, agencyOptionLabel(agency)]}
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => { onChange(agency.agencyCode); setOpen(false); setSearch(''); }}
                className="gap-3 rounded-lg px-3 py-3 data-[selected=true]:bg-navy-50 data-[selected=true]:text-navy-950"
              >
                <Building2 className="h-4 w-4 shrink-0 text-navy-600" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-semibold">{agency.label || 'Unnamed agency'}</span>
                  <span className="mt-0.5 block font-mono text-xs text-neutral-500">{agency.agencyCode}</span>
                </span>
                {agency.agencyCode === value && <Check className="h-4 w-4 shrink-0 text-navy-700" aria-label="Current agency" />}
              </CommandItem>
            ))}
          </CommandList>
      </Command>
    </div>
  );
}
