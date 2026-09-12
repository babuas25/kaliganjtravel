'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';

import {
  activeFilterCount,
  STATUS_FILTERS,
  USER_SORTS,
  type RosterFilters,
} from '@/lib/dashboard/user-roster';
import { ROLES, ROLE_LABELS } from '@/lib/roles';

const FIELD_CLASS =
  'rounded-md border border-navy-100 bg-white px-2.5 py-2 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange';

const LABEL_CLASS = 'text-xs font-medium text-navy-700';

/** Live roster filters keep the search draft in the form while results load. */
export default function UsersFilterBar({
  filters,
  matched,
}: {
  filters: RosterFilters;
  /** How many accounts the current filters match, for the open panel. */
  matched: number;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPending, startTransition] = useTransition();

  function cancelSearch() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function applyFilters() {
    cancelSearch();
    if (!formRef.current) return;
    const params = new URLSearchParams();
    new FormData(formRef.current).forEach((value, name) => {
      const text = String(value).trim();
      if (text) params.set(name, text);
    });
    startTransition(() => router.replace(`/dashboard/users?${params}`, { scroll: false }));
  }

  useEffect(() => {
    const restore = () => {
      if (timer.current) clearTimeout(timer.current);
      const params = new URLSearchParams(window.location.search);
      const defaults: Record<string, string> = { q: '', role: 'all', status: 'all', from: '', to: '', sort: 'newest' };
      for (const [name, fallback] of Object.entries(defaults)) {
        const field = formRef.current?.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
          field.value = params.get(name) ?? fallback;
        }
      }
    };
    window.addEventListener('popstate', restore);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('popstate', restore);
    };
  }, []);

  const active = activeFilterCount(filters);
  const [open, setOpen] = useState(active > 0);

  return (
    <div className="border-b border-navy-100">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 text-sm font-semibold text-navy-950"
        >
          <SlidersHorizontal className="h-4 w-4 text-navy-700/70" />
          Filter &amp; sort
          {active > 0 && (
            <span className="rounded-full bg-brand-orange-light px-2 py-0.5 text-xs font-semibold text-brand-orange-dark">
              {active}
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-navy-700/70 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Reachable without opening the panel: undoing a filter should never
            need the thing that applied it to be on screen first. */}
        {active > 0 && (
          <Link
            href="/dashboard/users"
            onClick={() => {
              cancelSearch();
              const form = formRef.current;
              if (!form) return;
              for (const element of Array.from(form.elements)) {
                if (element instanceof HTMLInputElement) element.value = '';
                if (element instanceof HTMLSelectElement) element.selectedIndex = 0;
              }
            }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-orange transition hover:underline"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Link>
        )}
      </div>

      {open && (
        <form
          ref={formRef}
          action="/dashboard/users"
          onSubmit={(event) => { event.preventDefault(); applyFilters(); }}
          onChange={(event) => {
            cancelSearch();
            const field = event.target;
            if (field instanceof HTMLInputElement && field.name === 'q') {
              timer.current = setTimeout(applyFilters, 300);
            } else {
              applyFilters();
            }
          }}
          className="flex flex-wrap items-end gap-2 border-t border-navy-100 px-4 py-3"
        >
          <label className="min-w-[230px] flex-1">
            <span className={LABEL_CLASS}>Search</span>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-700/50" />
              <input
                type="search"
                name="q"
                autoComplete="off"
                defaultValue={filters.query}
                placeholder="Name, email or agency ID"
                className={`${FIELD_CLASS} w-full pl-9`}
              />
            </div>
          </label>

          <label>
            <span className={LABEL_CLASS}>User type</span>
            <select
              name="role"
              defaultValue={filters.role}
              className={`${FIELD_CLASS} mt-1 block`}
            >
              <option value="all">All types</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className={LABEL_CLASS}>Status</span>
            <select
              name="status"
              defaultValue={filters.status}
              className={`${FIELD_CLASS} mt-1 block`}
            >
              {STATUS_FILTERS.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className={LABEL_CLASS}>Joined from</span>
            <input
              type="date"
              name="from"
              defaultValue={filters.from}
              className={`${FIELD_CLASS} mt-1 block`}
            />
          </label>

          <label>
            <span className={LABEL_CLASS}>Joined to</span>
            <input
              type="date"
              name="to"
              defaultValue={filters.to}
              className={`${FIELD_CLASS} mt-1 block`}
            />
          </label>

          <label>
            <span className={LABEL_CLASS}>Sort</span>
            <select
              name="sort"
              defaultValue={filters.sort}
              className={`${FIELD_CLASS} mt-1 block`}
            >
              {USER_SORTS.map((sort) => (
                <option key={sort.id} value={sort.id}>
                  {sort.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="rounded-md bg-brand-orange px-4 py-2 text-sm font-medium text-black transition hover:bg-brand-orange/90"
          >
            {isPending ? 'Updating…' : 'Apply'}
          </button>

          {active > 0 && (
            <span className="py-2 text-xs text-navy-700/70">
              {isPending ? 'Searching…' : `${matched} matching`}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
