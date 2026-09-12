'use client';

import {
  Banknote,
  Building2,
  Clock3,
  Landmark,
  RefreshCw,
  Search,
  Snowflake,
  UserRound,
  WalletCards,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type DepositLedgerRow = {
  id: string;
  requestReference: string;
  paymentMethod: 'cash' | 'bank' | 'mobile' | 'cheque';
  paymentReference: string | null;
  attachmentUrl: string | null;
  userLabel: string;
  userSecondary: string;
  requestedBy: string;
  issuedBy: string | null;
  amount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'approved' | 'rejected';
};

type LedgerReport = {
  currency: string;
  totals: {
    available: number;
    hold: number;
    frozenAmount: number;
    frozenCount: number;
    b2b: number;
    b2c: number;
    system: number;
  };
  requests: DepositLedgerRow[];
};

type SummaryCard = {
  label: string;
  hint: string;
  value: string;
  icon: LucideIcon;
  accent: string;
};

const PAGE_SIZE = 20;

function money(minor: number, currency = 'BDT') {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-BD', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function statusClass(status: DepositLedgerRow['status']) {
  if (status === 'approved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'rejected') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

export default function AccountLedgerDashboard() {
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/wallet/ledger', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || body.success === false) {
        throw new Error(body.error?.errorMessage || 'Account ledger is unavailable.');
      }
      setReport(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Account ledger is unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.requests ?? []).filter((row) => {
      const textMatch =
        !needle ||
        [
          row.requestReference,
          row.paymentReference,
          row.userLabel,
          row.userSecondary,
          row.requestedBy,
          row.issuedBy,
        ].some((value) => value?.toLowerCase().includes(needle));
      return (
        textMatch &&
        (method === 'all' || row.paymentMethod === method) &&
        (status === 'all' || row.status === status)
      );
    });
  }, [method, query, report, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  if (loading && !report) {
    return (
      <p className="rounded-xl border border-neutral-200 bg-white p-8 text-sm text-neutral-500">
        Loading account ledger…
      </p>
    );
  }
  if (error && !report) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {error}
      </p>
    );
  }
  if (!report) return null;

  const primaryCards: SummaryCard[] = [
    {
      label: 'Available Balance',
      hint: 'Funds available across all wallets',
      value: money(report.totals.available, report.currency),
      icon: Banknote,
      accent: 'bg-emerald-100 text-emerald-700',
    },
    {
      label: 'Hold Balance',
      hint: 'Reserved for booking confirmation',
      value: money(report.totals.hold, report.currency),
      icon: Clock3,
      accent: 'bg-amber-100 text-amber-700',
    },
    {
      label: 'Total System Balance',
      hint: 'All B2B and B2C wallet funds',
      value: money(report.totals.system, report.currency),
      icon: Landmark,
      accent: 'bg-red-100 text-brand-orange',
    },
  ];
  const secondaryCards: SummaryCard[] = [
    {
      label: 'Total B2B Balance',
      hint: 'All agency wallets',
      value: money(report.totals.b2b, report.currency),
      icon: Building2,
      accent: 'bg-sky-100 text-sky-700',
    },
    {
      label: 'Total B2C Balance',
      hint: 'All customer wallets',
      value: money(report.totals.b2c, report.currency),
      icon: UserRound,
      accent: 'bg-violet-100 text-violet-700',
    },
    {
      label: 'Frozen Wallet Amount',
      hint: 'Total funds in frozen wallets',
      value: money(report.totals.frozenAmount, report.currency),
      icon: Snowflake,
      accent: 'bg-cyan-100 text-cyan-700',
    },
    {
      label: 'Frozen Wallets',
      hint: 'Wallets currently restricted',
      value: String(report.totals.frozenCount),
      icon: WalletCards,
      accent: 'bg-neutral-100 text-neutral-700',
    },
  ];

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl bg-brand-orange px-6 py-7 text-black shadow-sm">
        <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full border-[32px] border-black/10" />
        <div className="absolute bottom-0 left-0 h-1 w-full bg-brand-orange" />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-black">
              Finance control centre
            </p>
            <h1 className="mt-2 text-3xl font-bold">Account Ledger</h1>
            <p className="mt-2 max-w-2xl text-sm text-black">
              Deposit requests, wallet exposure and approval history in one auditable view.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-black/10 bg-white/5 px-4 py-3 text-right">
              <p className="text-xs text-black">Deposit records</p>
              <p className="mt-1 text-xl font-bold tabular-nums">{report.requests.length}</p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-navy-950 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </section>

      <section aria-label="Wallet summary" className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          {primaryCards.map(({ label, hint, value, icon: Icon, accent }) => (
            <article key={label} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">{label}</p>
                  <p className="mt-3 text-2xl font-bold tabular-nums text-navy-950">{value}</p>
                  <p className="mt-2 text-xs text-neutral-500">{hint}</p>
                </div>
                <span className={`rounded-xl p-3 ${accent}`}><Icon className="h-5 w-5" /></span>
              </div>
            </article>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {secondaryCards.map(({ label, hint, value, icon: Icon, accent }) => (
            <article key={label} className="rounded-2xl border border-neutral-200 bg-white p-4">
              <div className="flex items-center gap-3">
                <span className={`rounded-lg p-2.5 ${accent}`}><Icon className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-neutral-500">{label}</p>
                  <p className="mt-1 truncate text-lg font-bold tabular-nums text-navy-950">{value}</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-neutral-500">{hint}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-200 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-navy-950">Deposit request ledger</h2>
              <p className="mt-1 text-xs text-neutral-500">
                {filtered.length} of {report.requests.length} records
              </p>
            </div>
            <div className="grid w-full gap-2 md:w-auto md:grid-cols-[minmax(260px,1fr)_160px_150px]">
              <label className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                  placeholder="Search reference or user"
                  className="w-full rounded-lg border border-neutral-200 py-2.5 pl-9 pr-3 text-sm"
                />
              </label>
              <select
                value={method}
                onChange={(event) => { setMethod(event.target.value); setPage(1); }}
                className="rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
              >
                <option value="all">All methods</option>
                <option value="bank">Bank transfer</option>
                <option value="mobile">Mobile banking</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
              </select>
              <select
                value={status}
                onChange={(event) => { setStatus(event.target.value); setPage(1); }}
                className="rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-navy-50 text-xs font-bold uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-5 py-3.5">Created at</th>
                <th className="px-4 py-3.5">Payment methods</th>
                <th className="px-4 py-3.5">Reference</th>
                <th className="px-4 py-3.5">User</th>
                <th className="px-4 py-3.5">Issued by</th>
                <th className="px-4 py-3.5 text-right">Amount</th>
                <th className="px-4 py-3.5">Updated at</th>
                <th className="px-5 py-3.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-14 text-center text-sm text-neutral-500">
                    No deposit requests match these filters.
                  </td>
                </tr>
              ) : pageRows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100 transition hover:bg-neutral-50/70">
                  <td className="whitespace-nowrap px-5 py-4 text-neutral-700">{dateTime(row.createdAt)}</td>
                  <td className="px-4 py-4">
                    <p className="font-semibold capitalize text-navy-950">{row.paymentMethod === 'mobile' ? 'Mobile banking' : row.paymentMethod === 'bank' ? 'Bank deposit / transfer' : row.paymentMethod}</p>
                    {row.paymentReference && <p className="mt-1 max-w-[190px] truncate text-xs text-neutral-500" title={row.paymentReference}>Payment ref: {row.paymentReference}</p>}
                    {row.attachmentUrl && <a href={row.attachmentUrl} target="_blank" rel="noreferrer" className="mt-1 block text-xs font-semibold text-navy-700 underline">View attachment</a>}
                  </td>
                  <td className="px-4 py-4"><span className="rounded-md bg-navy-50 px-2.5 py-1.5 font-mono text-xs font-bold tracking-wide text-navy-950">{row.requestReference}</span></td>
                  <td className="px-4 py-4"><p className="font-semibold text-navy-950">{row.userLabel}</p><p className="mt-1 text-xs text-neutral-500">{row.userSecondary}</p></td>
                  <td className="px-4 py-4"><p className="font-medium text-navy-950">{row.issuedBy || 'Awaiting approval'}</p>{!row.issuedBy && <p className="mt-1 text-xs text-neutral-500">Requested by {row.requestedBy}</p>}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right font-bold tabular-nums text-navy-950">{money(row.amount, row.currency)}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-neutral-700">{dateTime(row.updatedAt)}</td>
                  <td className="px-5 py-4"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold capitalize ${statusClass(row.status)}`}>{row.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50 px-5 py-4 text-sm">
          <p className="text-neutral-500">
            Showing {filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 font-semibold text-navy-950 disabled:opacity-40">Previous</button>
            <span className="rounded-lg bg-brand-orange px-3 py-2 font-bold text-black">{currentPage} / {pageCount}</span>
            <button type="button" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 font-semibold text-navy-950 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
