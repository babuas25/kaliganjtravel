'use client';

import { RefreshCw, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type LedgerEntry = {
  id: string;
  transactionType: string;
  amount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  bookingReference: string | null;
  remarks: string | null;
  createdAt: string;
};

type WalletResponse = {
  success: boolean;
  data?: {
    transactions?: LedgerEntry[];
  };
  error?: {
    errorMessage?: string;
  };
};

function money(amount: number, currency = 'BDT') {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-BD', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function transactionLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function responseBody(response: Response): Promise<WalletResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as WalletResponse;
  } catch {
    throw new Error('The transaction ledger could not be loaded. Please refresh.');
  }
}

export default function UserAccountLedgerDashboard() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/wallet', { cache: 'no-store' });
      const body = await responseBody(response);
      if (!response.ok || body.success === false) {
        throw new Error(
          body.error?.errorMessage || 'The transaction ledger is unavailable.'
        );
      }
      setEntries(body.data?.transactions ?? []);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The transaction ledger is unavailable.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
            <ScrollText className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-navy-950">
              Transaction Ledger
            </h1>
            <p className="mt-0.5 text-xs text-neutral-500">
              Complete debit and credit statement with your running balance.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <p className="m-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:m-6">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-left text-sm">
          <thead className="bg-navy-50 text-xs font-bold uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-5 py-3.5">Date</th>
              <th className="px-4 py-3.5">Transaction details</th>
              <th className="px-4 py-3.5">Reference</th>
              <th className="px-4 py-3.5 text-right">Debit</th>
              <th className="px-4 py-3.5 text-right">Credit</th>
              <th className="px-5 py-3.5 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-14 text-center text-neutral-500"
                >
                  Loading transaction ledger&hellip;
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-14 text-center text-neutral-500"
                >
                  No wallet transactions yet.
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const movement = entry.availableAfter - entry.availableBefore;
                const debit = movement < 0 ? Math.abs(movement) : null;
                const credit = movement > 0 ? movement : null;

                return (
                  <tr
                    key={entry.id}
                    className="border-t border-neutral-100 transition hover:bg-neutral-50/70"
                  >
                    <td className="whitespace-nowrap px-5 py-4 text-neutral-700">
                      {dateTime(entry.createdAt)}
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-navy-950">
                        {transactionLabel(entry.transactionType)}
                      </p>
                      {entry.remarks && (
                        <p className="mt-1 max-w-[300px] text-xs text-neutral-500">
                          {entry.remarks}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs font-semibold text-navy-950">
                      {entry.bookingReference || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums text-red-700">
                      {debit === null ? '—' : money(debit, entry.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums text-emerald-700">
                      {credit === null ? '—' : money(credit, entry.currency)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right font-bold tabular-nums text-navy-950">
                      {money(entry.availableAfter, entry.currency)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
