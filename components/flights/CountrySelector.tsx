'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactCountryFlag from 'react-country-flag';

import type { Country } from '@/lib/flights/countries';

/**
 * Searchable country picker with flags, used for nationality, the passport's
 * issuing country and the phone dialing code.
 *
 * The list is fixed-positioned rather than absolutely positioned inside the
 * field, so it escapes the traveller card's `overflow-hidden` and can flip
 * above the trigger when the field sits near the bottom of the viewport.
 */
export function CountrySelector({
  value,
  onChange,
  countries,
  placeholder = 'Select country',
  className = '',
  triggerClassName = '',
  type = 'nationality',
  ariaLabel,
}: {
  /** ISO-2 code, or the `+`-prefixed dial code when `type` is `phone`. */
  value: string;
  onChange: (value: string) => void;
  countries: readonly Country[];
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  type?: 'nationality' | 'phone';
  ariaLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 0,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selected = countries.find((country) =>
    type === 'phone' ? country.dialCode === value : country.code === value
  );

  const term = searchTerm.trim().toLowerCase();
  const filtered = countries.filter(
    (country) =>
      country.name.toLowerCase().includes(term) ||
      country.code.toLowerCase().includes(term) ||
      country.dialCode.includes(searchTerm.trim())
  );

  const select = (country: Country) => {
    onChange(type === 'phone' ? country.dialCode || country.code : country.code);
    setIsOpen(false);
    setSearchTerm('');
  };

  const place = () => {
    const trigger = buttonRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top = rect.bottom;
    let maxHeight = spaceBelow - 10;

    // Not enough room underneath, and more above: open upwards instead.
    if (spaceBelow < 200 && spaceAbove > spaceBelow) {
      maxHeight = Math.min(280, spaceAbove - 10);
      top = rect.top - maxHeight;
    }

    setPosition({
      top,
      left: rect.left,
      // A dial-code trigger is far narrower than its own list needs to be.
      width: type === 'phone' ? Math.max(rect.width, 240) : rect.width,
      maxHeight,
    });
  };

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        listRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
      setSearchTerm('');
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    place();

    // The list is pinned to viewport coordinates, so it has to follow the
    // trigger rather than drift away from it.
    const reposition = () => place();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, type]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => setIsOpen((open) => !open)}
        className={`flex w-full max-w-full items-center justify-between gap-2 overflow-hidden rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-navy-950 transition hover:bg-navy-50/60 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-orange ${triggerClassName}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected && (
            <ReactCountryFlag
              countryCode={selected.code}
              svg
              style={{ width: '1.25rem', height: '1.25rem' }}
              title={selected.name}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected
              ? type === 'phone'
                ? selected.dialCode
                : selected.name
              : placeholder}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>

      {isOpen && (
        <div
          ref={listRef}
          role="listbox"
          className="fixed z-[9999] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            width: `${position.width}px`,
            maxHeight: `${position.maxHeight}px`,
          }}
        >
          <div className="border-b border-neutral-200 p-2">
            <input
              type="text"
              autoFocus
              placeholder="Search country..."
              className="w-full max-w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-navy-950 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-orange"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onClick={(event) => event.stopPropagation()}
            />
          </div>

          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-center text-sm text-neutral-500">
                No countries found
              </p>
            ) : (
              filtered.map((country) => {
                const isSelected =
                  type === 'phone'
                    ? country.dialCode === value
                    : country.code === value;

                return (
                  <button
                    key={country.code}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => select(country)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-navy-50 ${
                      isSelected
                        ? 'bg-brand-orange-light text-brand-orange-dark'
                        : 'text-navy-950'
                    }`}
                  >
                    <ReactCountryFlag
                      countryCode={country.code}
                      svg
                      style={{ width: '1.25rem', height: '1.25rem' }}
                      title={country.name}
                    />
                    <span className="flex-1 truncate">{country.name}</span>
                    {type === 'phone' && (
                      <span className="shrink-0 text-neutral-500">
                        {country.dialCode}
                      </span>
                    )}
                    {isSelected && (
                      <Check
                        className="h-4 w-4 shrink-0 text-brand-orange"
                        aria-hidden
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
