'use client';

import {
  Building2,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileSpreadsheet,
  Filter,
  RefreshCw,
  Search,
  TicketsPlane,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgencyOption } from '@/lib/agency';
import AgencySearch from '@/components/dashboard/AgencySearch';

type TicketRow = {
  id: string;
  orderReference: string;
  pnr: string;
  airlineCode: string;
  airlineName: string;
  totalSegments: number;
  createdAt: string;
  ticketedAt: string;
  totalPassengers: number;
  mainTravellerName: string;
  currency: string;
  grossFare: number | null;
  payableAmount: number;
  profit: number | null;
  bookedByUserId: string | null;
  bookedByName: string;
};

type ReportResponse = {
  rows: TicketRow[];
  total: number;
  users: Array<{ id: string; label: string }>;
  airlines: Array<{ code: string; label: string }>;
  summary: {
    totalItems: number;
    totalPassengers: number;
    missingGrossCount: number;
    totalsByCurrency: Array<{
      currency: string;
      totalGross: number;
      totalPayable: number;
      totalProfit: number;
    }>;
  };
  page: number;
  pageSize: number;
  pageCount: number;
};

type ReportEnvelope = {
  success?: boolean;
  data?: ReportResponse;
  error?: { errorMessage?: string };
};

type Filters = {
  from: string;
  to: string;
  bookedBy: string;
  airline: string;
  search: string;
};

type Props = {
  /** Present only for staff who may choose which B2B agency to inspect. */
  agencies?: AgencyOption[];
};

const PAGE_SIZE = 15;
const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  bookedBy: '',
  airline: '',
  search: '',
};

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function summaryMoney(
  summary: ReportResponse['summary'],
  key: 'totalGross' | 'totalPayable' | 'totalProfit'
) {
  if (summary.totalsByCurrency.length === 0) return '—';
  return summary.totalsByCurrency
    .map((totals) => money(totals[key], totals.currency))
    .join(' · ');
}

function reportParams(
  filters: Filters,
  page: number,
  format = 'json',
  agencyCode = ''
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    format,
  });
  if (agencyCode) params.set('agency', agencyCode);
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-sm font-semibold text-neutral-700">
      {children}
    </span>
  );
}

export default function B2BIssuedTicketReport({ agencies }: Props) {
  const adminMode = agencies !== undefined;
  const [agencyCode, setAgencyCode] = useState(agencies?.[0]?.agencyCode ?? '');
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(Boolean(!adminMode || agencyCode));
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const selectedAgency = useMemo(
    () => agencies?.find((agency) => agency.agencyCode === agencyCode),
    [agencies, agencyCode]
  );

  const load = useCallback(async () => {
    if (adminMode && !agencyCode) {
      setReport(null);
      setLoading(false);
      return;
    }

    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/reports/issued-tickets?${reportParams(filters, page, 'json', agencyCode)}`,
        { cache: 'no-store' }
      );
      const responseText = await response.text();
      if (!responseText.trim()) {
        throw new Error(
          response.ok
            ? 'The sales report returned an empty response. Please refresh and try again.'
            : `The sales report request failed (${response.status}). Please refresh and try again.`
        );
      }
      let body: ReportEnvelope;
      try {
        body = JSON.parse(responseText) as ReportEnvelope;
      } catch {
        throw new Error('The sales report returned an invalid response. Please refresh and try again.');
      }
      if (!response.ok || body.success === false) {
        throw new Error(body.error?.errorMessage || 'The sales report is unavailable.');
      }
      if (!body.data) {
        throw new Error('The sales report returned no data. Please refresh and try again.');
      }
      if (requestId.current === currentRequest) setReport(body.data);
    } catch (reason) {
      if (requestId.current === currentRequest) {
        setError(reason instanceof Error ? reason.message : 'The sales report is unavailable.');
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [adminMode, agencyCode, filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportReport = (format: 'xlsx' | 'pdf') => {
    window.location.assign(
      `/api/reports/issued-tickets?${reportParams(filters, 1, format, agencyCode)}`
    );
  };

  const chooseAgency = (nextAgencyCode: string) => {
    setAgencyCode(nextAgencyCode);
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setReport(null);
    setError(null);
  };

  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const shownFrom = report && report.total ? (report.page - 1) * report.pageSize + 1 : 0;
  const shownTo = report ? Math.min(report.page * report.pageSize, report.total) : 0;
  const activeFilters = useMemo(
    () => Object.values(filters).filter(Boolean).length,
    [filters]
  );

  return (
    <div className="space-y-5">
      {adminMode ? (
        <section className="rounded-2xl border border-navy-100 bg-white p-5 shadow-sm">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-end">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-navy-50 p-3 text-navy-800">
                <Building2 className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="text-xl font-bold text-navy-950">Individual B2B agent sales</h2>
                <p className="mt-1 text-sm leading-6 text-neutral-600">
                  Choose an agency to review its issued tickets, team sales and profit.
                </p>
              </div>
            </div>
            <AgencySearch agencies={agencies} value={agencyCode} onChange={chooseAgency} />
          </div>
          {selectedAgency ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4 text-sm">
              <span className="font-semibold text-navy-950">
                {selectedAgency.label || 'Unnamed agency'}
              </span>
              <span className="rounded-full bg-navy-50 px-2.5 py-1 font-mono text-xs font-semibold text-navy-700">
                {selectedAgency.agencyCode}
              </span>
              <span className="text-neutral-500">
                {report ? `${report.users.length} agency user${report.users.length === 1 ? '' : 's'}` : 'Loading agency…'}
              </span>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="rounded-2xl bg-brand-orange px-5 py-5 text-black shadow-sm sm:px-6">
          <div className="flex items-center gap-4">
            <span className="rounded-xl bg-white/10 p-3">
              <TicketsPlane className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-black">B2B reporting</p>
              <h1 className="mt-1 text-2xl font-bold">Sales report</h1>
              <p className="mt-1 text-sm text-black">Issued tickets across your agency team.</p>
            </div>
          </div>
        </section>
      )}

      {adminMode && agencies.length === 0 ? (
        <section className="rounded-2xl border border-neutral-200 bg-white px-5 py-12 text-center shadow-sm">
          <Building2 className="mx-auto h-8 w-8 text-neutral-300" aria-hidden />
          <h3 className="mt-3 font-bold text-navy-950">No B2B agencies yet</h3>
          <p className="mt-1 text-sm text-neutral-500">Sales reports will appear after a B2B agency is created.</p>
        </section>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-navy-700" aria-hidden />
                <h2 className="font-bold text-navy-950">Filter sales</h2>
                {activeFilters > 0 ? (
                  <span className="rounded-full bg-brand-orange/10 px-2 py-0.5 text-xs font-bold text-brand-orange">
                    {activeFilters} active
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => exportReport('xlsx')}
                  disabled={loading || !report}
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-40"
                >
                  <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel
                </button>
                <button
                  type="button"
                  onClick={() => exportReport('pdf')}
                  disabled={loading || !report}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800 transition hover:bg-red-100 disabled:opacity-40"
                >
                  <FileDown className="h-4 w-4" aria-hidden /> PDF
                </button>
              </div>
            </div>

            <form
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6"
              onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
                setFilters(draft);
              }}
            >
              <label className="sm:col-span-2 xl:col-span-1">
                <FieldLabel>Order reference</FieldLabel>
                <span className="relative block">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" aria-hidden />
                  <input
                    value={draft.search}
                    onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                    placeholder="Search reference"
                    className="w-full rounded-lg border border-neutral-200 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
                  />
                </span>
              </label>
              <label>
                <FieldLabel>From</FieldLabel>
                <input
                  type="date"
                  value={draft.from}
                  max={draft.to || undefined}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
                />
              </label>
              <label>
                <FieldLabel>To</FieldLabel>
                <input
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
                />
              </label>
              <label>
                <FieldLabel>Sold by</FieldLabel>
                <select
                  value={draft.bookedBy}
                  onChange={(event) => setDraft({ ...draft, bookedBy: event.target.value })}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
                >
                  <option value="">All agency users</option>
                  {(report?.users ?? []).map((user) => (
                    <option key={user.id} value={user.id}>{user.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel>Airline</FieldLabel>
                <select
                  value={draft.airline}
                  onChange={(event) => setDraft({ ...draft, airline: event.target.value })}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
                >
                  <option value="">All airlines</option>
                  {(report?.airlines ?? []).map((airline) => (
                    <option key={airline.code} value={airline.code}>{airline.label}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="w-full rounded-lg bg-brand-orange px-5 py-2.5 text-sm font-bold text-black transition hover:bg-brand-orange/90"
                >
                  Apply filters
                </button>
              </div>
            </form>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4 text-sm">
              <span className="text-neutral-500">
                {activeFilters ? 'Showing filtered results' : 'Showing all issued-ticket sales'}
              </span>
              <div className="flex items-center gap-4">
                {activeFilters > 0 ? (
                  <button type="button" onClick={clearFilters} className="font-semibold text-brand-orange hover:underline">
                    Clear filters
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void load()}
                  className="inline-flex items-center gap-1.5 font-semibold text-navy-700 hover:text-navy-950"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
                </button>
              </div>
            </div>
          </section>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>
          ) : null}

          {report?.summary && !loading ? (
            <section aria-label="Sales totals" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Issued tickets</p>
                <p className="mt-2 text-2xl font-bold tabular-nums text-navy-950">
                  {report.summary.totalPassengers.toLocaleString('en-US')}
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Gross sales</p>
                <p className="mt-2 break-words text-lg font-bold tabular-nums text-navy-950">
                  {summaryMoney(report.summary, 'totalGross')}
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Payable amount</p>
                <p className="mt-2 break-words text-lg font-bold tabular-nums text-navy-950">
                  {summaryMoney(report.summary, 'totalPayable')}
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Profit</p>
                <p className={`mt-2 break-words text-lg font-bold tabular-nums ${
                  report.summary.totalsByCurrency.some((totals) => totals.totalProfit < 0)
                    ? 'text-red-700'
                    : 'text-emerald-700'
                }`}>
                  {summaryMoney(report.summary, 'totalProfit')}
                </p>
              </div>
              {report.summary.missingGrossCount > 0 ? (
                <p className="sm:col-span-2 xl:col-span-4 text-sm text-amber-700">
                  Gross and profit totals exclude {report.summary.missingGrossCount.toLocaleString('en-US')}{' '}
                  {report.summary.missingGrossCount === 1 ? 'record' : 'records'} without stored gross fare.
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
              <div>
                <h2 className="font-bold text-navy-950">Issued ticket sales</h2>
                <p className="mt-0.5 text-sm text-neutral-500">{report?.total ?? 0} matching records</p>
              </div>
              {loading ? <span className="text-sm font-semibold text-neutral-500">Loading…</span> : null}
            </div>

            <div className="hidden grid-cols-[minmax(130px,.9fr)_minmax(190px,1.35fr)_minmax(115px,.7fr)_minmax(150px,1fr)_minmax(210px,1.2fr)] gap-4 bg-navy-50 px-5 py-3 text-xs font-bold uppercase tracking-wide text-neutral-500 xl:grid">
              <span>Ticketed</span>
              <span>Order and traveller</span>
              <span>Flight</span>
              <span>Sold by</span>
              <span>Financials</span>
            </div>

            <div className="divide-y divide-neutral-100">
              {!loading && !(report?.rows.length) ? (
                <div className="px-5 py-14 text-center">
                  <TicketsPlane className="mx-auto h-8 w-8 text-neutral-300" aria-hidden />
                  <p className="mt-3 font-semibold text-navy-950">No matching ticket sales</p>
                  <p className="mt-1 text-sm text-neutral-500">Try changing the agency or clearing the filters.</p>
                </div>
              ) : (report?.rows ?? []).map((row) => (
                <article
                  key={row.id}
                  className="grid gap-4 px-5 py-4 transition hover:bg-neutral-50/70 xl:grid-cols-[minmax(130px,.9fr)_minmax(190px,1.35fr)_minmax(115px,.7fr)_minmax(150px,1fr)_minmax(210px,1.2fr)] xl:items-center"
                >
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 xl:hidden">Ticketed</p>
                    <p className="mt-1 text-sm font-semibold text-navy-950 xl:mt-0">{dateTime(row.ticketedAt)}</p>
                    <p className="mt-1 text-xs text-neutral-500">Created {dateTime(row.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 xl:hidden">Order</p>
                    <p className="mt-1 font-bold text-navy-950 xl:mt-0">{row.mainTravellerName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-semibold text-navy-700">{row.orderReference}</span>
                      <span className="text-neutral-500">{row.totalPassengers} pax</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 xl:hidden">Flight</p>
                    <p className="mt-1 font-bold text-navy-950 xl:mt-0" title={row.airlineName}>{row.airlineCode}</p>
                    <p className="mt-1 text-sm text-neutral-600">PNR {row.pnr}</p>
                    <p className="text-xs text-neutral-500">{row.totalSegments} segment{row.totalSegments === 1 ? '' : 's'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 xl:hidden">Sold by</p>
                    <p className="mt-1 text-sm font-semibold text-navy-950 xl:mt-0">{row.bookedByName}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 xl:hidden">Financials</p>
                    <dl className="mt-2 grid grid-cols-3 gap-2 xl:mt-0">
                      <div>
                        <dt className="text-xs text-neutral-500">Gross</dt>
                        <dd className="mt-0.5 break-words text-sm font-semibold text-navy-950">
                          {row.grossFare === null ? '—' : money(row.grossFare, row.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-neutral-500">Payable</dt>
                        <dd className="mt-0.5 break-words text-sm font-semibold text-navy-950">
                          {money(row.payableAmount, row.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-neutral-500">Profit</dt>
                        <dd className={`mt-0.5 break-words text-sm font-bold ${
                          row.profit !== null && row.profit < 0 ? 'text-red-700' : 'text-emerald-700'
                        }`}>
                          {row.profit === null ? '—' : money(row.profit, row.currency)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </article>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50 px-5 py-4 text-sm">
              <p className="text-neutral-500">Showing {shownFrom}–{shownTo} of {report?.total ?? 0}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Previous report page"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((value) => value - 1)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white text-navy-950 transition hover:bg-navy-50 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </button>
                <span className="rounded-lg bg-brand-orange px-3 py-2 font-bold text-black">
                  {report?.page ?? page} / {report?.pageCount ?? 1}
                </span>
                <button
                  type="button"
                  aria-label="Next report page"
                  disabled={loading || page >= (report?.pageCount ?? 1)}
                  onClick={() => setPage((value) => value + 1)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white text-navy-950 transition hover:bg-navy-50 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
