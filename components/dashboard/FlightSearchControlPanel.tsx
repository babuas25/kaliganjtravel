'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Activity,
  Ban,
  BarChart3,
  CheckCircle2,
  Clock3,
  Loader2,
  Save,
  Search,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';

import {
  saveSupplierSearchLimitAction,
  saveUserSearchControlAction,
} from '@/app/(dashboard)/dashboard/search-control/actions';
import type {
  FlightSearchSupplierUsage,
  FlightSearchUsageReport,
  FlightSearchUserUsage,
} from '@/lib/db/flight-search-usage';

const SUPPLIER_LABEL = {
  firsttrip: 'FirstTrip',
  takeoff: 'TakeOff',
  triplover: 'Triplover',
} as const;
const USERS_PER_PAGE = 12;

function count(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function duration(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function dateTime(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function travelDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00Z`));
}

function travelDates(values: string[]): string {
  return values.map(travelDate).join(' / ');
}

function SupplierLimitCard({ usage }: { usage: FlightSearchSupplierUsage }) {
  const router = useRouter();
  const [value, setValue] = useState(
    usage.dailyLimit === null ? '' : String(usage.dailyLimit)
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const remaining = usage.dailyLimit === null
    ? null
    : Math.max(0, usage.dailyLimit - usage.todayHitCount);

  function save() {
    const parsed = value.trim() === '' ? null : Number(value);
    setMessage(null);
    startTransition(async () => {
      const result = await saveSupplierSearchLimitAction({
        supplier: usage.supplier,
        dailyLimit: parsed,
        expectedVersion: usage.limitVersion,
      });
      setMessage(result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-navy-950">
            {SUPPLIER_LABEL[usage.supplier]}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Today: {count(usage.todayHitCount)} API hit{usage.todayHitCount === 1 ? '' : 's'}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          remaining === 0
            ? 'bg-red-100 text-red-800'
            : 'bg-emerald-100 text-emerald-800'
        }`}>
          {remaining === null ? 'Unlimited' : `${count(remaining)} remaining`}
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <label className="min-w-0 flex-1 text-xs font-semibold text-navy-800">
          Daily API hit limit
          <input
            type="number"
            min={0}
            max={1_000_000}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={pending}
            placeholder="Blank = unlimited; 0 = blocked"
            className="mt-1.5 h-9 w-full rounded-lg border border-neutral-300 px-3 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/15"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand-orange px-3 text-xs font-semibold text-black disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-navy-700">{message}</p> : null}
    </section>
  );
}

function UsageMetric({
  label,
  value,
  tone = 'text-navy-950',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-md bg-neutral-50 px-1.5 py-1.5 text-center">
      <p className={`text-xs font-bold tabular-nums ${tone}`}>{count(value)}</p>
      <p className="mt-0.5 text-[8px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </p>
    </div>
  );
}

function UserControlRow({ usage }: { usage: FlightSearchUserUsage }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(usage.searchEnabled);
  const [limit, setLimit] = useState(
    usage.dailyLimit === null ? '' : String(usage.dailyLimit)
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const personLabel = usage.displayName || usage.email || usage.userId || 'Anonymous visitors';
  const isAgencyUser = usage.role === 'b2b' || usage.role === 'b2b_sub';
  const userLabel = isAgencyUser
    ? usage.agencyName || usage.agencyCode || personLabel
    : personLabel;
  const searchedBy = isAgencyUser && personLabel !== userLabel ? personLabel : null;

  function save() {
    if (!usage.userId) return;
    const parsed = limit.trim() === '' ? null : Number(limit);
    setMessage(null);
    startTransition(async () => {
      const result = await saveUserSearchControlAction({
        userId: usage.userId!,
        searchEnabled: enabled,
        dailyLimit: parsed,
        expectedVersion: usage.controlVersion,
      });
      setMessage(result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <article className="grid gap-3 border-t border-neutral-100 px-3 py-3 first:border-t-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1.2fr)_minmax(220px,1fr)_minmax(130px,.75fr)_minmax(220px,1.25fr)] lg:items-center">
      <div className="min-w-0">
        <p className="truncate text-xs font-bold text-navy-950" title={userLabel}>
          {userLabel}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[10px] text-neutral-500">
          {[
            searchedBy ? `Searched by ${searchedBy}` : null,
            usage.role,
            usage.agencyCode,
          ].filter(Boolean).join(' · ') || 'Public search'}
        </p>
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-400 lg:hidden">
          Searched routes
        </p>
        {usage.searchedRoutes.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {usage.searchedRoutes.slice(0, 3).map((route) => (
              <span key={`${route.route}:${route.departureDates.join(',')}`} className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-800">
                <span>
                  {route.route}
                  <span className="ml-1 text-blue-400">×{count(route.requestCount)}</span>
                </span>
                {route.departureDates.length > 0 ? (
                  <span className="mt-0.5 block text-[9px] font-medium text-blue-500">
                    Travel {travelDates(route.departureDates)}
                  </span>
                ) : null}
              </span>
            ))}
            {usage.distinctRouteCount > 3 ? (
              <details className="w-full text-[10px] text-neutral-500">
                <summary className="cursor-pointer font-semibold text-blue-700 marker:text-blue-300">
                  +{count(usage.distinctRouteCount - 3)} more routes
                </summary>
                <div className="mt-1 flex flex-wrap gap-1">
                  {usage.searchedRoutes.slice(3).map((route) => (
                    <span key={`${route.route}:${route.departureDates.join(',')}`} className="rounded bg-neutral-100 px-1.5 py-1">
                      {route.route} ×{count(route.requestCount)}
                      {route.departureDates.length > 0 ? ` · ${travelDates(route.departureDates)}` : ''}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <span className="text-[11px] text-neutral-400">—</span>
        )}
      </div>
      <div className="grid grid-cols-5 gap-1">
        <UsageMetric label="Req" value={usage.requestCount} />
        <UsageMetric label="API" value={usage.supplierApiHitCount} tone="text-blue-700" />
        <UsageMetric label="OK" value={usage.successCount} tone="text-emerald-700" />
        <UsageMetric label="Fail" value={usage.failedCount} tone="text-red-700" />
        <UsageMetric label="Block" value={usage.blockedCount} tone="text-amber-700" />
      </div>
      <div>
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-400 lg:hidden">
          Last search
        </p>
        <p className="whitespace-nowrap text-[11px] text-neutral-600">{dateTime(usage.lastSearchAt)}</p>
      </div>
      <div>
        {usage.userId ? (
          <div className="space-y-1.5">
            <label className="flex items-center justify-between gap-2 text-[10px] font-semibold text-navy-800">
              <span>{enabled ? 'Enabled' : 'Disabled'} · today {count(usage.todayHitCount)}</span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={pending}
                className="h-4 w-4 shrink-0 accent-brand-orange"
              />
            </label>
            <div className="flex gap-1.5">
              <input
                type="number"
                min={1}
                max={1_000_000}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                disabled={pending}
                placeholder="Daily limit"
                aria-label={`Daily search limit for ${userLabel}`}
                className="h-8 min-w-0 flex-1 rounded-md border border-neutral-300 px-2 text-xs"
              />
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="h-8 shrink-0 rounded-md bg-brand-orange px-2.5 text-[10px] font-semibold text-black disabled:opacity-60"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
            </div>
            {message ? <p className="text-[10px] text-navy-700">{message}</p> : null}
          </div>
        ) : (
          <span className="text-[11px] text-neutral-400">Controlled by supplier limit</span>
        )}
      </div>
    </article>
  );
}

export default function FlightSearchControlPanel({
  report,
  fromDate,
  toDate,
}: {
  report: FlightSearchUsageReport;
  fromDate: string;
  toDate: string;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [page, setPage] = useState(1);
  const needle = query.trim().toLowerCase();
  const activeUserCount = report.users.filter((row) => row.requestCount > 0).length;
  const users = report.users
    .filter((row) => scope === 'all' || row.requestCount > 0)
    .filter((row) =>
      !needle || [
        row.displayName,
        row.email,
        row.role,
        row.agencyCode,
        row.agencyName,
        ...row.searchedRoutes.map((route) => route.route),
        ...row.searchedRoutes.flatMap((route) => route.departureDates),
      ].some((value) => value?.toLowerCase().includes(needle))
    );
  const totalPages = Math.max(1, Math.ceil(users.length / USERS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * USERS_PER_PAGE;
  const visibleUsers = users.slice(pageStart, pageStart + USERS_PER_PAGE);
  const cards = [
    ['Total search requests', report.totals.requestCount, Search],
    ['Supplier API hits', report.totals.supplierApiHitCount, Server],
    ['Successful', report.totals.successCount, CheckCircle2],
    ['Failed', report.totals.failedCount, Activity],
    ['Blocked', report.totals.blockedCount, Ban],
    ['Unique users', report.totals.uniqueUserCount, Users],
  ] as const;

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-xl border border-navy-100 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-orange">
              <BarChart3 className="h-4 w-4" /> Flight Search Control
            </p>
            <h1 className="mt-1 text-xl font-bold text-navy-950">Search usage and supplier API limits</h1>
            <p className="mt-1 max-w-3xl text-sm text-neutral-600">
              Website search requests and outbound supplier API hits are counted separately.
              Daily limits reset at midnight in Asia/Dhaka.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-navy-50 px-3 py-1.5 text-[11px] font-semibold text-navy-700">
            <ShieldCheck className="h-3.5 w-3.5" /> Super Admin only
          </span>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-3" method="get">
          <label className="text-xs font-semibold text-navy-800">
            From
            <input name="from" type="date" defaultValue={fromDate} className="mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-semibold text-navy-800">
            To
            <input name="to" type="date" defaultValue={toDate} className="mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <button type="submit" className="rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950">Apply dates</button>
        </form>
      </header>

      {!report.available ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Flight-search usage storage is not available yet. Apply the latest flight-search usage migrations before enabling these controls.
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map(([label, value, Icon]) => (
          <div key={label} className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
            <Icon className="h-4 w-4 text-brand-orange" />
            <p className="mt-3 text-2xl font-bold tabular-nums text-navy-950">{count(value)}</p>
            <p className="mt-1 text-[11px] font-semibold text-neutral-500">{label}</p>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-navy-950">Supplier daily limits</h2>
            <p className="text-xs text-neutral-500">Blank means unlimited. Counts reset at Dhaka midnight.</p>
          </div>
          <p className="flex items-center gap-1 text-xs text-neutral-500"><Clock3 className="h-3.5 w-3.5" /> Average response {duration(report.totals.averageTotalMs)}</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {report.suppliers.map((supplier) => <SupplierLimitCard key={supplier.supplier} usage={supplier} />)}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-navy-100 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-4">
          <div>
            <h2 className="text-base font-bold text-navy-950">User and agency usage</h2>
            <p className="text-xs text-neutral-500">Review routes and manage daily supplier-hit access.</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="inline-flex rounded-lg bg-neutral-100 p-1 text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => { setScope('active'); setPage(1); }}
                className={`rounded-md px-2.5 py-1.5 ${scope === 'active' ? 'bg-white text-navy-950 shadow-sm' : 'text-neutral-500'}`}
              >
                Searched {count(activeUserCount)}
              </button>
              <button
                type="button"
                onClick={() => { setScope('all'); setPage(1); }}
                className={`rounded-md px-2.5 py-1.5 ${scope === 'all' ? 'bg-white text-navy-950 shadow-sm' : 'text-neutral-500'}`}
              >
                All users {count(report.users.length)}
              </button>
            </div>
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              placeholder="Search name, agency or route"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm sm:w-64 sm:flex-none"
            />
          </div>
        </div>
        <div className="hidden bg-navy-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-neutral-500 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1.2fr)_minmax(220px,1fr)_minmax(130px,.75fr)_minmax(220px,1.25fr)] lg:gap-3">
          <span>Account</span>
          <span>Routes</span>
          <span>Usage</span>
          <span>Last search</span>
          <span>Daily control</span>
        </div>
        <div>
          {visibleUsers.map((usage) => (
            <UserControlRow key={usage.userId ?? 'anonymous'} usage={usage} />
          ))}
          {users.length === 0 ? (
            <p className="p-8 text-center text-sm text-neutral-500">No searches match this period or filter.</p>
          ) : null}
        </div>
        {users.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] text-neutral-500">
            <span>
              Showing {count(pageStart + 1)}–{count(Math.min(pageStart + USERS_PER_PAGE, users.length))} of {count(users.length)}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={currentPage === 1}
                className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 font-semibold text-navy-800 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="px-1.5 font-semibold text-neutral-600">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                disabled={currentPage === totalPages}
                className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 font-semibold text-navy-800 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
