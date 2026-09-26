'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save, Server } from 'lucide-react';

import {
  saveSupplierControlAction,
} from '@/app/(dashboard)/dashboard/supplier-control/actions';
import type { SupplierOperationalControls } from '@/lib/db/supplier-controls';
import type { FlightReadSupplier } from '@/lib/flights/supplier';

type Props = {
  controls: SupplierOperationalControls;
  supplierConfigured: Record<FlightReadSupplier, boolean>;
};

const LABEL: Record<FlightReadSupplier, string> = {
  firsttrip: 'FirstTrip',
  takeoff: 'TakeOff',
  triplover: 'Triplover',
  shapontravels: 'Shapontravels',
};

export default function SupplierControlPanel({
  controls: initialControls,
  supplierConfigured,
}: Props) {
  const [controls, setControls] = useState(initialControls);
  const [activeSupplier, setActiveSupplier] = useState<FlightReadSupplier>(
    initialControls.activeSupplier
  );
  const [bookingEnabled, setBookingEnabled] = useState(initialControls.bookingEnabled);
  const [ticketingEnabled, setTicketingEnabled] = useState(initialControls.ticketingEnabled);
  const [message, setMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const availableSuppliers = (Object.keys(LABEL) as FlightReadSupplier[])
    .filter((supplier) => supplierConfigured[supplier]);
  const selectedSupplierAvailable = supplierConfigured[activeSupplier];

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveSupplierControlAction({
        activeSupplier,
        bookingEnabled,
        ticketingEnabled: activeSupplier === 'shapontravels' ? false : ticketingEnabled,
        expectedVersion: controls.version,
      });
      setMessage({
        kind: result.ok ? 'success' : 'error',
        text: result.message,
      });
      if (result.ok && result.controls) {
        setControls(result.controls);
        setActiveSupplier(result.controls.activeSupplier);
        setBookingEnabled(result.controls.bookingEnabled);
        setTicketingEnabled(result.controls.ticketingEnabled);
      }
    });
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-brand-orange/10 p-3 text-brand-orange">
            <Server className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-navy-950">Supplier Control</h1>
            <p className="mt-1 text-sm text-navy-700">
              Select the supplier account used by new flight searches and control
              whether booking and ticketing operations are available.
            </p>
          </div>
        </div>

        {controls.source === 'legacy_environment' ? (
          <div className="mt-5 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Database controls have not been saved yet. The values shown are
              temporary legacy environment settings. Saving this form makes the
              database authoritative, after which the legacy flags can be removed.
            </p>
          </div>
        ) : null}
        {controls.source === 'unavailable' ? (
          <div className="mt-5 flex gap-3 rounded-lg border border-brand-orange/40 bg-brand-orange/5 p-4 text-sm text-navy-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange" />
            <p>
              Supplier controls could not be read. Booking and ticketing are
              currently fail-closed until the database becomes available.
            </p>
          </div>
        ) : null}

        <fieldset className="mt-6">
          <legend className="text-sm font-semibold text-navy-950">
            Active supplier for new searches
          </legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {availableSuppliers.map((supplier) => (
              <label
                key={supplier}
                className={`cursor-pointer rounded-xl border p-4 transition ${
                  activeSupplier === supplier
                    ? 'border-brand-orange bg-brand-orange/5 ring-1 ring-brand-orange'
                    : 'border-navy-100 bg-white hover:border-navy-300'
                }`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="supplier"
                  value={supplier}
                  checked={activeSupplier === supplier}
                  onChange={() => {
                    setActiveSupplier(supplier);
                    if (supplier === 'shapontravels') {
                      setBookingEnabled(false);
                      setTicketingEnabled(false);
                    }
                  }}
                  disabled={isPending}
                />
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-navy-950">{LABEL[supplier]}</span>
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800">
                    Available
                  </span>
                </span>
              </label>
            ))}
          </div>
          {availableSuppliers.length === 0 ? (
            <p className="mt-3 text-sm text-navy-700">No suppliers are available.</p>
          ) : !selectedSupplierAvailable ? (
            <p className="mt-3 text-sm text-navy-700">
              The saved supplier is unavailable. Select an available supplier and save your changes.
            </p>
          ) : null}
        </fieldset>

        {activeSupplier === 'shapontravels' && (
          <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            Shapontravels supports held bookings. Ticketing is not available yet.
          </p>
        )}

        <div className="mt-6 space-y-3 rounded-xl bg-navy-50 p-4">
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-semibold text-navy-950">Enable booking</span>
              <span className="block text-xs text-navy-700">Allows new bookings. Shapontravels permits holds only.</span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-orange"
              checked={bookingEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setBookingEnabled(enabled);
                if (!enabled) setTicketingEnabled(false);
              }}
              disabled={isPending || !selectedSupplierAvailable}
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-semibold text-navy-950">Enable ticketing</span>
              <span className="block text-xs text-navy-700">Allows direct ticket fares and issuing held bookings.</span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-orange"
              checked={ticketingEnabled}
              onChange={(event) => setTicketingEnabled(event.target.checked)}
              disabled={isPending || !selectedSupplierAvailable || !bookingEnabled || activeSupplier === 'shapontravels'}
            />
          </label>
        </div>

        {message ? (
          <p
            className={`mt-4 flex items-center gap-2 text-sm ${
              message.kind === 'success' ? 'text-emerald-800' : 'text-brand-orange'
            }`}
          >
            {message.kind === 'success' ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            {message.text}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={isPending || !selectedSupplierAvailable}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isPending ? 'Saving…' : 'Save controls'}
          </button>
        </div>
      </section>

      <p className="rounded-lg border border-navy-100 bg-white px-4 py-3 text-xs leading-5 text-navy-700">
        Changing the active supplier affects only searches started after the save.
        Existing searches, RePrice requests, bookings, PNR reads, cancellations,
        and ticketing continue using the supplier account recorded when they began.
      </p>
    </main>
  );
}
