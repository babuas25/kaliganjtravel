'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { z } from 'zod';

const supplierBalance = z.object({
  current_balance: z.string().max(64).regex(/^-?\d+(?:\.\d+)?(?![\s\S])/),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
}).strict();

type SupplierBalance = z.infer<typeof supplierBalance>;
type BalanceState = SupplierBalance | 'loading' | 'unavailable';

const suppliers = [
  { id: 'shapontravels', name: 'Shapon Travels', url: '/api/supplier-control/balance?supplier=shapontravels' },
  { id: 'triplover', name: 'TripLover', url: '/api/supplier-control/balance' },
] as const;

const initialBalances: Record<(typeof suppliers)[number]['id'], BalanceState> = {
  shapontravels: 'loading',
  triplover: 'loading',
};

const wholeNumber = new Intl.NumberFormat('en-BD');

function displayBalance(balance: BalanceState) {
  if (balance === 'loading') return 'Loading balance…';
  if (balance === 'unavailable') return 'Balance unavailable';

  const { current_balance: amount, currency } = balance;
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  // Keep the supplier's decimal value exact when adding separators.
  return `${currency} ${negative ? '-' : ''}${wholeNumber.format(BigInt(whole))}.${fraction.padEnd(2, '0')}`;
}

export default function SupplierBalancePanel() {
  const [balances, setBalances] = useState(initialBalances);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const request = new AbortController();
    inFlight.current = request;
    setBalances(initialBalances);

    // Allow a slow balance read and one token renewal to finish.
    const timeout = window.setTimeout(() => request.abort(), 65_000);
    try {
      await Promise.all(suppliers.map(async ({ id, url }) => {
        let balance: BalanceState = 'unavailable';
        try {
          const response = await fetch(url, { cache: 'no-store', signal: request.signal });
          if (response.ok) balance = supplierBalance.parse(await response.json());
        } catch {
          // Each supplier reports its own failure while its peer can still load.
        }

        if (inFlight.current === request) {
          setBalances((previous) => ({ ...previous, [id]: balance }));
        }
      }));
    } finally {
      window.clearTimeout(timeout);
      if (inFlight.current === request) inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    // React's development effect replay can cancel the first scheduled request.
    const initialRead = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(initialRead);
      const request = inFlight.current;
      inFlight.current = null;
      request?.abort();
    };
  }, [refresh]);

  const loading = Object.values(balances).includes('loading');

  return (
    <section
      aria-labelledby="supplier-balance-heading"
      className="rounded-xl border border-navy-100 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="supplier-balance-heading" className="text-lg font-bold text-navy-950">
          Supplier Balance
        </h2>
        <button
          type="button"
          aria-disabled={loading}
          onClick={() => {
            if (!loading) void refresh();
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold text-navy-700 hover:bg-navy-50 aria-disabled:opacity-50 aria-disabled:hover:bg-white"
        >
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh balance
        </button>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {suppliers.map(({ id, name }) => (
          <div key={id} className="min-w-0 rounded-lg border border-navy-100 p-3">
            <dt className="text-sm font-semibold text-navy-950">{name}</dt>
            <dd className="mt-1 text-sm text-navy-700 [overflow-wrap:anywhere]">
              <span role="status" aria-atomic="true">{displayBalance(balances[id])}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
