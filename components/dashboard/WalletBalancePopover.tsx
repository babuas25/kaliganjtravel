'use client';

import Link from 'next/link';
import { ChevronDown, RefreshCw, Wallet } from 'lucide-react';
import { useCallback, useState } from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

type WalletSummary = {
  availableBalance: number;
  currency: string;
};

type WalletResponse = {
  success: boolean;
  data?: {
    summary?: WalletSummary;
  };
  error?: {
    errorMessage?: string;
  };
};

function money(amount: number, currency: string) {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

async function responseBody(response: Response): Promise<WalletResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as WalletResponse;
  } catch {
    throw new Error('Balance is temporarily unavailable.');
  }
}

export default function WalletBalancePopover() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/wallet', { cache: 'no-store' });
      const body = await responseBody(response);
      if (!response.ok || body.success === false || !body.data?.summary) {
        throw new Error(
          body.error?.errorMessage || 'Balance is temporarily unavailable.'
        );
      }
      setSummary(body.data.summary);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Balance is temporarily unavailable.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) void load();
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Show available wallet balance"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-navy-200 bg-white px-2.5 text-navy-950 shadow-sm transition hover:border-brand-orange/40 hover:bg-brand-orange-light"
        >
          <Wallet className="h-4 w-4 text-brand-orange" />
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-64 rounded-xl border-neutral-200 p-0 shadow-xl"
      >
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
                <Wallet className="h-4 w-4" />
              </span>
              <p className="text-sm font-semibold text-navy-950">
                Wallet Balance
              </p>
            </div>
            {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
          </div>

          {error ? (
            <p className="mt-3 text-sm text-red-700">{error}</p>
          ) : summary ? (
            <>
              <p className="mt-3 text-xl font-bold tabular-nums text-navy-950">
                {money(summary.availableBalance, summary.currency)}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Available balance
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">
              Loading available balance&hellip;
            </p>
          )}
        </div>

        <Link
          href="/dashboard/deposits"
          onClick={() => setOpen(false)}
          className="block border-t border-neutral-100 bg-neutral-50/70 px-4 py-2.5 text-xs font-semibold text-navy-700 transition hover:bg-navy-50 hover:text-navy-950"
        >
          View wallet and payment requests
        </Link>
      </PopoverContent>
    </Popover>
  );
}
