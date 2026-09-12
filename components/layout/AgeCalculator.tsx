'use client';

import { Calculator } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  calculateAgeAtTravel,
  type ExactPassengerAge,
} from '@/lib/flights/age-calculator';

function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function AgeCalculator() {
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [travelDate, setTravelDate] = useState('');
  const [result, setResult] = useState<ExactPassengerAge | null>(null);
  const [error, setError] = useState<string | null>(null);

  const calculate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = calculateAgeAtTravel(dateOfBirth, travelDate);
    if (!next) {
      setResult(null);
      setError('Enter a valid date of birth that is not after the travel date.');
      return;
    }
    setError(null);
    setResult(next);
  };

  const dobMaximum =
    travelDate && travelDate < todayIso() ? travelDate : todayIso();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Open age calculator"
          className="group fixed right-0 top-[58%] z-40 flex h-11 w-10 -translate-y-1/2 items-center justify-center rounded-l-lg bg-brand-orange text-navy-950 shadow-lg transition hover:w-11 hover:bg-brand-orange-dark hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-orange/30"
        >
          <Calculator className="h-5 w-5" aria-hidden="true" />
          <span className="pointer-events-none absolute right-full mr-2 hidden whitespace-nowrap rounded-lg bg-brand-orange px-3 py-2 text-xs font-medium text-black shadow-lg group-hover:block group-focus-visible:block">
            Age Calculator
          </span>
        </button>
      </DialogTrigger>

      <DialogContent className="w-[calc(100%-2rem)] max-w-md gap-0 rounded-2xl border-0 bg-white p-6 text-navy-950 shadow-2xl sm:p-7">
        <DialogHeader className="border-b border-neutral-200 pb-4 text-left">
          <DialogTitle className="text-xl">Age Calculator</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-neutral-500">
            Check the passenger&apos;s age and booking category on the travel date.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={calculate} className="pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-navy-950">
              Date of Birth
              <input
                type="date"
                required
                value={dateOfBirth}
                max={dobMaximum}
                onChange={(event) => {
                  setDateOfBirth(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                className="mt-2 h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-navy-950 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/15"
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Travel Date
              <input
                type="date"
                required
                value={travelDate}
                min={todayIso()}
                onChange={(event) => {
                  setTravelDate(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                className="mt-2 h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-navy-950 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/15"
              />
            </label>
          </div>

          <button
            type="submit"
            className="mt-5 flex h-12 w-full items-center justify-center rounded-lg bg-brand-orange px-5 text-base font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-orange/25"
          >
            Calculate Age
          </button>

          {error ? (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-brand-orange-dark">
              {error}
            </p>
          ) : null}

          {result ? (
            <div aria-live="polite" className="mt-5 rounded-xl border border-brand-orange/15 bg-brand-orange-light/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-orange-dark">
                Age on travel date
              </p>
              <p className="mt-1 text-2xl font-bold text-navy-950">
                {result.years}y {result.months}m {result.days}d
              </p>
              <div className="mt-3 border-t border-brand-orange/15 pt-3">
                <p className="font-semibold text-navy-950">{result.category}</p>
                <p className="mt-0.5 text-sm text-neutral-600">{result.categoryHint}</p>
              </div>
            </div>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
