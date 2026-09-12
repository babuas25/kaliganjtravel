'use client';

import { ChevronLeft, ChevronRight, Search, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type Wallet = {
  walletId: string;
  accountId: string;
  ownerType: string;
  ownerKey: string;
  status: 'active' | 'frozen';
  currency: string;
  availableBalance: number;
  holdBalance: number;
  totalBalance: number;
};

type Transaction = {
  id: string;
  ownerType?: string;
  ownerKey?: string;
  transactionType: string;
  amount: number;
  currency: string;
  bookingReference: string | null;
  createdByUserId: string;
  createdAt: string;
  ownerName?: string | null;
  processedBy?: { name: string | null; role: string | null } | null;
};

type BookingPayment = {
  ownerName: string | null;
  bookedByName: string | null;
  issuedByName: string | null;
  booking_id: string;
  public_ref: string;
  booking_owner_type: string | null;
  booking_owner_key: string | null;
  booked_by_user_id: string | null;
  issued_by_user_id: string | null;
  payment_state: string;
  payment_amount: number | null;
  captured_amount: number;
  refunded_amount: number;
  currency: string;
  booking_status: string;
  created_at: string;
};

type Report = {
  currency: string;
  totals: { available: number; hold: number; total: number; active: number; frozen: number };
  totalsByCurrency: Array<{ currency: string; available: number; hold: number; total: number }>;
  wallets: Wallet[];
  transactions: Transaction[];
  bookingPayments: BookingPayment[];
};

const PAGE_SIZE = 12;

function money(minor: number | null, currency = 'BDT') {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format((minor ?? 0) / 100);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateAndTime(value: string) {
  const date = new Date(value);
  return {
    date: `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

function dateTime(value: string) {
  const parts = dateAndTime(value);
  return `${parts.date}, ${parts.time}`;
}

function readable(value: string) {
  return value.replace(/[-_]/g, ' ');
}

function transactionLabel(value: string) {
  if (value === 'booking_confirm') return 'Ticketed';
  return readable(value);
}

function amountNumber(minor: number) {
  return new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50 px-5 py-4 text-sm">
      <p className="text-neutral-500">Showing {from}–{to} of {total}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white text-navy-950 transition hover:bg-navy-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="rounded-lg bg-brand-orange px-3 py-2 font-bold text-black">{page} / {pageCount}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white text-navy-950 transition hover:bg-navy-50 disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export default function WalletReportDashboard({ embedded = false }: { embedded?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [transactionPage, setTransactionPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/wallet/reports', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.errorMessage || 'Report unavailable.');
        setReport(body.data);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Report unavailable.'));
  }, []);

  const transactionTypes = useMemo(
    () => Array.from(new Set(report?.transactions.map((row) => row.transactionType) ?? [])).sort(),
    [report]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const toTime = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    return (report?.transactions ?? []).filter((row) => {
      const time = new Date(row.createdAt).getTime();
      const matchesText = !needle || [
        row.ownerName,
        row.ownerKey,
        row.ownerType,
        row.bookingReference,
        row.processedBy?.name,
        row.createdByUserId,
      ]
        .some((value) => value?.toLowerCase().includes(needle));
      return matchesText && (type === 'all' || row.transactionType === type) && time >= fromTime && time <= toTime;
    });
  }, [from, query, report, to, type]);

  useEffect(() => {
    setTransactionPage(1);
  }, [from, query, to, type]);

  const transactionPageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paymentPageCount = Math.max(1, Math.ceil((report?.bookingPayments.length ?? 0) / PAGE_SIZE));
  const transactions = filtered.slice(
    (transactionPage - 1) * PAGE_SIZE,
    transactionPage * PAGE_SIZE
  );
  const bookingPayments = (report?.bookingPayments ?? []).slice(
    (paymentPage - 1) * PAGE_SIZE,
    paymentPage * PAGE_SIZE
  );

  if (error) {
    return <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>;
  }
  if (!report) {
    return <p className="rounded-xl bg-white p-8 text-sm text-neutral-500">Loading financial reports…</p>;
  }

  const summaryCards: Array<[string, string | number]> = [
    ...report.totalsByCurrency.flatMap((totals): Array<[string, string]> => [
      [`Available (${totals.currency})`, money(totals.available, totals.currency)],
      [`Hold (${totals.currency})`, money(totals.hold, totals.currency)],
      [`Total (${totals.currency})`, money(totals.total, totals.currency)],
    ]),
    ['Active wallets', report.totals.active],
    ['Frozen wallets', report.totals.frozen],
  ];

  return (
    <div className="space-y-5">
      <div className={embedded ? 'rounded-2xl border border-navy-100 bg-white p-5 shadow-sm' : ''}>
        <div className="flex items-start gap-3">
          {embedded ? (
            <span className="rounded-xl bg-navy-50 p-3 text-navy-800">
              <WalletCards className="h-5 w-5" aria-hidden />
            </span>
          ) : null}
          <div>
            {embedded ? (
              <h2 className="text-xl font-bold text-navy-950">Financial activity</h2>
            ) : (
              <h1 className="text-2xl font-bold text-navy-950">Financial reports</h1>
            )}
            <p className="mt-1 text-sm text-neutral-500">Wallet balances, ledger entries and booking payments.</p>
          </div>
        </div>
      </div>

      <section aria-label="Wallet totals" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {summaryCards.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">{label}</p>
            <p className="mt-2 break-words text-xl font-bold text-navy-950">{String(value)}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-navy-700" aria-hidden />
          <h2 className="font-bold text-navy-950">Filter transactions</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label>
            <span className="mb-1.5 block text-sm font-semibold text-neutral-700">Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="User, agency or booking"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-sm font-semibold text-neutral-700">Transaction type</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
            >
              <option value="all">All transaction types</option>
              {transactionTypes.map((value) => <option key={value} value={value}>{readable(value)}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-sm font-semibold text-neutral-700">From</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-sm font-semibold text-neutral-700">To</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
            />
          </label>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="font-bold text-navy-950">Transaction report</h2>
          <p className="mt-0.5 text-sm text-neutral-500">{filtered.length} matching ledger entries</p>
        </div>
        <div className="hidden grid-cols-[.8fr_1.1fr_1.1fr_1fr_.7fr] gap-4 bg-navy-50 px-5 py-3 text-xs font-bold uppercase tracking-wide text-neutral-500 lg:grid">
          <span>Date / Time</span><span>Agency</span><span>Activity</span><span>Created by</span><span className="text-right">Amount</span>
        </div>
        <div className="divide-y divide-neutral-100">
          {transactions.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-neutral-500">No transactions match these filters.</p>
          ) : transactions.map((row) => {
            const occurred = dateAndTime(row.createdAt);
            return (
            <article key={row.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[.8fr_1.1fr_1.1fr_1fr_.7fr] lg:items-center">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Date / Time</p>
                <p className="mt-1 text-sm font-bold text-navy-950 lg:mt-0">{occurred.date}</p>
                <p className="mt-1 text-sm text-neutral-600">{occurred.time}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Agency</p>
                <p className="mt-1 text-sm font-bold text-navy-950 lg:mt-0">
                  {row.ownerName || (row.ownerType === 'user' ? 'Individual customer' : 'Unnamed agency')}
                </p>
                <p className="mt-1 font-mono text-xs font-semibold text-neutral-500">
                  {row.ownerKey || 'No account code'}
                </p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Activity</p>
                <p className="mt-1 text-sm font-bold capitalize text-navy-950 lg:mt-0">{transactionLabel(row.transactionType)}</p>
                <p className="mt-1 text-xs font-medium text-neutral-500">{row.bookingReference || 'No booking reference'}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Created by</p>
                <p className="mt-1 text-sm font-bold text-navy-950 lg:mt-0">
                  {row.processedBy?.name || 'Name unavailable'}
                </p>
              </div>
              <div className="lg:text-right">
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Amount</p>
                <p className="mt-1 text-xs font-bold uppercase tracking-wide text-neutral-500 lg:mt-0">{row.currency}</p>
                <p className="mt-1 break-words text-base font-bold tabular-nums text-navy-950">{amountNumber(row.amount)}</p>
              </div>
            </article>
          );})}
        </div>
        <Pager page={transactionPage} pageCount={transactionPageCount} total={filtered.length} onPage={setTransactionPage} />
      </section>

      <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="font-bold text-navy-950">Booking payment report</h2>
          <p className="mt-0.5 text-sm text-neutral-500">{report.bookingPayments.length} booking payments</p>
        </div>
        <div className="hidden grid-cols-[1fr_1.15fr_1fr_1fr_1.1fr] gap-4 bg-navy-50 px-5 py-3 text-xs font-bold uppercase tracking-wide text-neutral-500 lg:grid">
          <span>Booking</span><span>Owner</span><span>Payment</span><span>Handled by</span><span>Amounts</span>
        </div>
        <div className="divide-y divide-neutral-100">
          {bookingPayments.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-neutral-500">No booking payments available.</p>
          ) : bookingPayments.map((row) => (
            <article key={row.booking_id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_1.15fr_1fr_1fr_1.1fr] lg:items-center">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Booking</p>
                <p className="mt-1 font-bold text-navy-950 lg:mt-0">{row.public_ref}</p>
                <p className="mt-0.5 text-xs text-neutral-500">{dateTime(row.created_at)}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Owner</p>
                <p className="mt-1 break-words text-sm font-semibold text-navy-950 lg:mt-0">{row.ownerName || (row.booking_owner_type === 'agency' ? 'Unknown agency' : 'Unknown user')}</p>
                <p className="mt-0.5 text-xs capitalize text-neutral-500">{row.booking_owner_type === 'agency' ? row.booking_owner_key : row.booking_owner_type || 'Unknown owner'}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Payment</p>
                <p className="mt-1 text-sm font-semibold capitalize text-navy-950 lg:mt-0">{readable(row.payment_state)}</p>
                <p className="mt-0.5 text-xs capitalize text-neutral-500">Booking {readable(row.booking_status)}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 lg:hidden">Handled by</p>
                <p className="mt-1 break-words text-sm text-neutral-700 lg:mt-0">Booked: {row.bookedByName || (row.booked_by_user_id ? 'Unknown user' : '—')}</p>
                <p className="mt-0.5 break-words text-xs text-neutral-500">Issued: {row.issuedByName || (row.issued_by_user_id ? 'Unknown user' : '—')}</p>
              </div>
              <dl className="grid grid-cols-2 gap-2">
                <div>
                  <dt className="text-xs text-neutral-500">Captured</dt>
                  <dd className="mt-0.5 break-words text-sm font-bold text-navy-950">{money(row.captured_amount, row.currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Refunded</dt>
                  <dd className="mt-0.5 break-words text-sm font-bold text-red-700">{money(row.refunded_amount, row.currency)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <Pager page={paymentPage} pageCount={paymentPageCount} total={report.bookingPayments.length} onPage={setPaymentPage} />
      </section>
    </div>
  );
}
