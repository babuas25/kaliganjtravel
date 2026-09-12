'use client';

import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

export type ResultsSortKey =
  | 'none'
  | 'dep-early-late'
  | 'dep-late-early'
  | 'price-low-high'
  | 'price-high-low'
  | 'layover-short-long'
  | 'layover-long-short';

type SortMenuKey = 'departure' | 'price' | 'layover';

type SortOption = {
  value: ResultsSortKey;
  label: string;
};

const SORT_GROUPS: {
  key: SortMenuKey;
  label: string;
  options: SortOption[];
}[] = [
  {
    key: 'departure',
    label: 'Departure',
    options: [
      { value: 'dep-early-late', label: 'Early to Late' },
      { value: 'dep-late-early', label: 'Late to Early' },
    ],
  },
  {
    key: 'price',
    label: 'Price',
    options: [
      { value: 'price-low-high', label: 'Low to High' },
      { value: 'price-high-low', label: 'High to Low' },
    ],
  },
  {
    key: 'layover',
    label: 'Layover',
    options: [
      { value: 'layover-short-long', label: 'Short to Long' },
      { value: 'layover-long-short', label: 'Long to Short' },
    ],
  },
];

function belongsToGroup(value: ResultsSortKey, group: SortMenuKey): boolean {
  if (group === 'departure') return value.startsWith('dep-');
  return value.startsWith(`${group}-`);
}

export default function ResultsSortBar({
  value,
  onChange,
}: {
  value: ResultsSortKey;
  onChange: (value: ResultsSortKey) => void;
}) {
  const [openMenu, setOpenMenu] = useState<SortMenuKey | null>(null);
  const menuIdPrefix = useId();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const selectedLabels = useMemo(() => {
    const labels: Partial<Record<SortMenuKey, string>> = {};
    for (const group of SORT_GROUPS) {
      const selected = group.options.find((option) => option.value === value);
      if (selected) labels[group.key] = selected.label;
    }
    return labels;
  }, [value]);

  const choose = (next: ResultsSortKey) => {
    onChange(next);
    setOpenMenu(null);
  };

  return (
    <nav aria-label="Sort flight results" className="relative w-full">
      {openMenu && (
        <button
          type="button"
          aria-label="Close sort menu"
          onClick={() => setOpenMenu(null)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {SORT_GROUPS.map((group) => {
          const isOpen = openMenu === group.key;
          const isActive = belongsToGroup(value, group.key);
          const menuId = `${menuIdPrefix}-${group.key}`;

          return (
            <div key={group.key} className={`relative min-w-0 ${isOpen ? 'z-50' : ''}`}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={menuId}
                onClick={() => setOpenMenu(isOpen ? null : group.key)}
                className={`flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 text-left text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange ${
                  isActive
                    ? 'border-brand-orange/40 bg-brand-orange-light text-brand-orange-dark'
                    : 'border-neutral-200 bg-white text-navy-950 hover:border-neutral-300 hover:bg-neutral-50'
                }`}
              >
                <span className="truncate">
                  {group.label}
                  {selectedLabels[group.key] ? ` - ${selectedLabels[group.key]}` : ''}
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
                  id={menuId}
                  role="menu"
                  className="absolute left-0 right-0 top-full mt-1 overflow-hidden rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => choose('none')}
                    className={`w-full rounded px-3 py-2 text-left text-xs transition ${
                      !isActive
                        ? 'bg-brand-orange-light font-semibold text-brand-orange-dark'
                        : 'text-neutral-700 hover:bg-neutral-100'
                    }`}
                  >
                    {group.label} (Default)
                  </button>

                  {group.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      onClick={() => choose(option.value)}
                      className={`w-full rounded px-3 py-2 text-left text-xs transition ${
                        value === option.value
                          ? 'bg-brand-orange-light font-semibold text-brand-orange-dark'
                          : 'text-neutral-700 hover:bg-neutral-100'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
