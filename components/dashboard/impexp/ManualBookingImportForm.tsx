'use client';

import { FileInput, Loader2, Minus, Plane, Plus, ReceiptText, ShieldCheck, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import ImpExpUserPicker from '@/components/dashboard/impexp/ImpExpUserPicker';
import ManualDateTimeField from '@/components/dashboard/impexp/ManualDateTimeField';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { airlineNameForCode } from '@/lib/airlines/catalog';
import { BOOKING_CURRENCY } from '@/lib/currency';
import type { ImpExpAssignableUser } from '@/lib/impexp/types';
import type { ManualBookingImportInput } from '@/lib/impexp/manual-validation';
import type { AirportOption } from '@/lib/airports/types';

type AssignRole = 'b2b' | 'b2b_sub' | 'customer';
type Passenger = {
  passengerType: 'ADT' | 'CHD' | 'CNN' | 'INF' | 'INS';
  title: 'Mr' | 'Mrs' | 'Ms' | 'Mstr' | 'Miss';
  firstName: string;
  lastName: string;
  gender: 'Male' | 'Female';
  dateOfBirth: string;
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  basePrice: string;
  taxes: string;
  ait: string;
  serviceMargin: string;
  totalPrice: string;
  ticketNumber: string;
};
type Segment = {
  leg: string;
  carrierCode: string;
  carrierName: string;
  flightNumber: string;
  fromCode: string;
  fromCity: string;
  fromAirport: string;
  fromTerminal: string;
  toCode: string;
  toCity: string;
  toAirport: string;
  toTerminal: string;
  departureAt: string;
  arrivalAt: string;
  duration: string;
  cabin: string;
  bookingClass: string;
  baggage: string;
  handBaggage: string;
  aircraft: string;
};

type AirportSearchResponse = {
  success?: boolean;
  data?: { items?: AirportOption[] };
};

const airportLookupCache = new Map<string, AirportOption | null>();
const airportLookupRequests = new Map<string, Promise<AirportOption | null>>();

async function findAirportByIata(code: string): Promise<AirportOption | null> {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCode)) return null;

  if (airportLookupCache.has(normalizedCode)) return airportLookupCache.get(normalizedCode) ?? null;
  const pending = airportLookupRequests.get(normalizedCode);
  if (pending) return pending;

  const request = fetch(`/api/airports?q=${encodeURIComponent(normalizedCode)}&limit=20`)
    .then(async (response) => {
      const body = await response.json() as AirportSearchResponse;
      const items = body.data?.items;
      if (!response.ok || body.success === false || !Array.isArray(items)) return null;
      return items.find((airport) => airport.iata === normalizedCode && !airport.isCity) ?? null;
    })
    .catch(() => null)
    .then((airport) => {
      airportLookupCache.set(normalizedCode, airport);
      return airport;
    })
    .finally(() => airportLookupRequests.delete(normalizedCode));

  airportLookupRequests.set(normalizedCode, request);
  return request;
}

const ROLES: Record<AssignRole, string> = {
  b2b: 'B2B Partner',
  b2b_sub: 'B2B Sub User',
  customer: 'Customer',
};

function emptyPassenger(): Passenger {
  return {
    passengerType: 'ADT', title: 'Mr', firstName: '', lastName: '', gender: 'Male',
    dateOfBirth: '', nationality: 'BD', passportNumber: '', passportExpiry: '',
    basePrice: '', taxes: '', ait: '0', serviceMargin: '0', totalPrice: '', ticketNumber: '',
  };
}

function emptySegment(): Segment {
  return {
    leg: '1', carrierCode: '', carrierName: '', flightNumber: '', fromCode: '', fromCity: '', fromAirport: '', fromTerminal: '',
    toCode: '', toCity: '', toAirport: '', toTerminal: '', departureAt: '', arrivalAt: '', duration: '', cabin: 'Economy', bookingClass: '', baggage: '', handBaggage: '', aircraft: '',
  };
}

function iso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatMoneyInput(value: string): string {
  const ungrouped = value.replaceAll(',', '');
  if (!/^\d*(?:\.\d*)?$/.test(ungrouped)) return value;

  const [whole, fractional] = ungrouped.split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return ungrouped.includes('.') ? `${groupedWhole}.${(fractional ?? '').slice(0, 2)}` : groupedWhole;
}

function canonicalMoney(value: string): string {
  return value.replaceAll(',', '');
}

function moneyNumber(value: string): number {
  return Number(canonicalMoney(value)) || 0;
}

function Field({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return <label className="block"><span className="mb-1 block text-xs font-semibold text-neutral-700">{label}{required && <span className="ml-0.5 text-brand-orange">*</span>}</span>{children}</label>;
}

export default function ManualBookingImportForm({ onImported }: { onImported: () => Promise<void> }) {
  const [assignRole, setAssignRole] = useState<AssignRole>('b2b');
  const [users, setUsers] = useState<ImpExpAssignableUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [assignedToUserId, setAssignedToUserId] = useState('');
  const [initialStatus, setInitialStatus] = useState<'on-hold' | 'confirmed'>('on-hold');
  const [passengers, setPassengers] = useState<Passenger[]>([emptyPassenger()]);
  const [segments, setSegments] = useState<Segment[]>([emptySegment()]);
  const [airportLookupErrors, setAirportLookupErrors] = useState<Record<string, string>>({});
  const [carrierLookupErrors, setCarrierLookupErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [form, setForm] = useState({
    externalReference: '', pnr: '', airlinePnr: '', userPayableAmount: '', supplierGrossAmount: '', supplierPayableAmount: '',
    ticketingDeadlineAt: '', travelDate: '', phone: '', phoneCountryCode: '+880', customerEmail: '', email: '',
    countryCode: 'BD', cityName: 'Dhaka', issuedAt: '', supplierMessage: '', refundable: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    setUsersLoading(true);
    setAssignedToUserId('');
    fetch(`/api/impexp/users?role=${assignRole}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { users?: ImpExpAssignableUser[]; error?: string };
        if (!response.ok) throw new Error(body.error || 'Users could not be loaded.');
        setUsers(Array.isArray(body.users) ? body.users : []);
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Users could not be loaded.' });
      })
      .finally(() => setUsersLoading(false));
    return () => controller.abort();
  }, [assignRole]);

  const totalPassengerFare = useMemo(
    () => passengers.reduce((sum, passenger) => sum + moneyNumber(passenger.totalPrice), 0),
    [passengers],
  );
  function updateForm(key: keyof typeof form, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function updatePassenger(index: number, key: keyof Passenger, value: string) {
    setPassengers((current) => current.map((passenger, itemIndex) => itemIndex === index ? { ...passenger, [key]: value } : passenger));
  }
  function updateMoneyForm(key: 'userPayableAmount' | 'supplierGrossAmount' | 'supplierPayableAmount', value: string) {
    updateForm(key, formatMoneyInput(value));
  }
  function updateMoneyPassenger(index: number, key: 'basePrice' | 'taxes' | 'ait' | 'serviceMargin' | 'totalPrice', value: string) {
    updatePassenger(index, key, formatMoneyInput(value));
  }
  function updateSegment(index: number, key: keyof Segment, value: string) {
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, [key]: value } : segment));
  }
  function updateCarrierCode(index: number, value: string) {
    const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);
    const carrierName = airlineNameForCode(code);

    setCarrierLookupErrors((current) => ({
      ...current,
      [code]: carrierName || code.length !== 2
        ? ''
        : `Carrier ${code} was not found. Enter the airline name below.`,
    }));
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index
      ? { ...segment, carrierCode: code, carrierName: carrierName ?? '' }
      : segment));
  }
  function updateAirportCode(index: number, direction: 'from' | 'to', value: string) {
    const code = value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    const codeKey = code;
    const cityKey = direction === 'from' ? 'fromCity' : 'toCity';
    const airportKey = direction === 'from' ? 'fromAirport' : 'toAirport';
    const codeField = direction === 'from' ? 'fromCode' : 'toCode';

    setAirportLookupErrors((current) => ({ ...current, [codeKey]: '' }));
    setSegments((current) => current.map((segment, itemIndex) => itemIndex === index
      ? { ...segment, [codeField]: code, [cityKey]: '', [airportKey]: '' }
      : segment));

    if (code.length !== 3) return;

    void findAirportByIata(code).then((airport) => {
      setSegments((current) => current.map((segment, itemIndex) => {
        if (itemIndex !== index || segment[codeField] !== code) return segment;
        if (!airport) return segment;
        return { ...segment, [cityKey]: airport.city, [airportKey]: airport.name };
      }));
      setAirportLookupErrors((current) => ({
        ...current,
        [codeKey]: airport ? '' : `Airport ${code} was not found. Enter the city and airport name below.`,
      }));
    });
  }

  async function submit() {
    setMessage(null); setBookingUrl(null);
    const deadline = iso(form.ticketingDeadlineAt);
    const issuedAt = iso(form.issuedAt);
    const mappedSegments = segments.map((segment) => ({
      leg: Number(segment.leg), carrierCode: segment.carrierCode, carrierName: segment.carrierName, flightNumber: segment.flightNumber,
      from: { code: segment.fromCode, city: segment.fromCity, airport: segment.fromAirport, terminal: segment.fromTerminal },
      to: { code: segment.toCode, city: segment.toCity, airport: segment.toAirport, terminal: segment.toTerminal },
      departureAt: iso(segment.departureAt) ?? '', arrivalAt: iso(segment.arrivalAt) ?? '', cabin: segment.cabin,
      duration: segment.duration, bookingClass: segment.bookingClass, baggage: segment.baggage,
      handBaggage: segment.handBaggage, aircraft: segment.aircraft,
    }));
    const payload: ManualBookingImportInput = {
      requestId: crypto.randomUUID(), assignedToUserId, initialStatus, externalReference: form.externalReference,
      pnr: form.pnr, airlinePnr: form.airlinePnr, currency: BOOKING_CURRENCY, userPayableAmount: canonicalMoney(form.userPayableAmount),
      supplierGrossAmount: canonicalMoney(form.supplierGrossAmount), supplierPayableAmount: canonicalMoney(form.supplierPayableAmount), ticketingDeadlineAt: deadline, travelDate: form.travelDate,
      refundable: form.refundable, supplierMessage: form.supplierMessage,
      passengers: {
        travellers: passengers.map(({ basePrice, taxes, ait, serviceMargin, totalPrice, ticketNumber, ...traveller }) => traveller),
        contact: { phone: form.phone, phoneCountryCode: form.phoneCountryCode, customerEmail: form.customerEmail, email: form.email || form.customerEmail, countryCode: form.countryCode, cityName: form.cityName },
      },
      segments: mappedSegments,
      fares: passengers.map((passenger) => ({ passengerType: passenger.passengerType, basePrice: canonicalMoney(passenger.basePrice), taxes: canonicalMoney(passenger.taxes), ait: canonicalMoney(passenger.ait), serviceMargin: canonicalMoney(passenger.serviceMargin), totalPrice: canonicalMoney(passenger.totalPrice) })),
      ...(initialStatus === 'confirmed' ? { ticketing: { ticketNumbers: passengers.map((passenger) => passenger.ticketNumber), issuedAt: issuedAt ?? '' } } : {}),
    };
    setSubmitting(true);
    try {
      const response = await fetch('/api/impexp/manual-booking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json() as { success?: boolean; error?: string; bookingOrderUrl?: string; referenceNo?: string; walletCharged?: boolean; chargedAmount?: number; currency?: string };
      if (!response.ok || !body.success) throw new Error(body.error || 'Manual booking import failed.');
      setBookingUrl(body.bookingOrderUrl ?? null);
      setMessage({ kind: 'success', text: `Manual booking ${body.referenceNo} was saved as ${initialStatus === 'confirmed' ? 'Confirmed' : 'On Hold'}${body.walletCharged ? ` and ${body.currency ?? BOOKING_CURRENCY} ${(Number(body.chargedAmount) / 100).toLocaleString()} was charged once.` : '. No wallet charge was made.'}` });
      await onImported();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Manual booking import failed.' });
    } finally { setSubmitting(false); }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-navy-100 bg-gradient-to-r from-violet-50 via-white to-brand-orange-light/30 px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange text-black shadow-sm">
            <FileInput className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-orange-dark">Manual Import</p>
            <h2 className="mt-1 text-lg font-bold text-navy-950">Create a booking from airline documents</h2>
            <p className="mt-1 max-w-3xl text-sm text-neutral-600">
              Copy the details from the airline booking, ticket, and passenger passport. Save it as On Hold to import only, or Confirmed to import and charge.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-bold text-black">1</span>
            <div>
              <h3 className="text-base font-semibold text-navy-950">Booking reference and owner</h3>
              <p className="mt-0.5 text-sm text-neutral-500">Start with the airline references, then choose who owns this booking. Fields marked <span className="font-semibold text-brand-orange">*</span> are required.</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Booking or ticket reference" required><Input value={form.externalReference} onChange={(event) => updateForm('externalReference', event.target.value)} placeholder="Booking or ticket reference" /></Field>
            <Field label="PNR" required><Input value={form.pnr} onChange={(event) => updateForm('pnr', event.target.value.toUpperCase())} placeholder="e.g. HSNL5" /></Field>
            <Field label="Airline PNR" required><Input value={form.airlinePnr} onChange={(event) => updateForm('airlinePnr', event.target.value.toUpperCase())} placeholder="e.g. DGPBMD" /></Field>
            <Field label="Travel date" required><Input type="date" value={form.travelDate} onChange={(event) => updateForm('travelDate', event.target.value)} /></Field>
          </div>

          <div className="mt-5 grid gap-4 rounded-lg border border-navy-100 bg-navy-50/50 p-4 md:grid-cols-3">
            <Field label="Import as" required><Select value={initialStatus} onValueChange={(value) => setInitialStatus(value as 'on-hold' | 'confirmed')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="on-hold">On Hold — Import Only</SelectItem><SelectItem value="confirmed">Confirmed — Import & Charge</SelectItem></SelectContent></Select></Field>
            <Field label="Owner type" required><Select value={assignRole} onValueChange={(value) => setAssignRole(value as AssignRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
            <Field label="Booking owner" required><ImpExpUserPicker users={users} value={assignedToUserId} onValueChange={setAssignedToUserId} loading={usersLoading} role={assignRole} /></Field>
          </div>

          <details className="mt-4 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/70 px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold text-navy-800 marker:text-brand-orange">Ticketing options <span className="ml-2 text-xs font-normal text-neutral-500">Add a ticketing deadline when needed.</span></summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Ticketing deadline (optional)"><Input type="datetime-local" value={form.ticketingDeadlineAt} onChange={(event) => updateForm('ticketingDeadlineAt', event.target.value)} /></Field>
            </div>
          </details>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-navy-50/50 p-4 sm:p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-bold text-navy-950">2</span>
            <div>
              <h3 className="text-base font-semibold text-navy-950">Contact and booking price</h3>
              <p className="mt-0.5 text-sm text-neutral-500">Record the customer contact and the amounts printed on the booking or ticket.</p>
            </div>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-navy-950"><UserCheck className="h-4 w-4 text-brand-orange" aria-hidden />Contact of record</div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Field label="Customer email" required><Input type="email" value={form.customerEmail} onChange={(event) => updateForm('customerEmail', event.target.value)} placeholder="Customer's personal email" /></Field>
              <Field label="Contact email (if different)"><Input type="email" value={form.email} onChange={(event) => updateForm('email', event.target.value)} placeholder="Same as customer email" /></Field>
              <Field label="Mobile number" required><Input value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} placeholder="Customer's personal mobile number" /></Field>
              <Field label="Country phone code"><Input value={form.phoneCountryCode} onChange={(event) => updateForm('phoneCountryCode', event.target.value)} placeholder="e.g. +880" /></Field>
              <Field label="Country code"><Input value={form.countryCode} onChange={(event) => updateForm('countryCode', event.target.value.toUpperCase().slice(0, 3))} placeholder="e.g. BD" /></Field>
              <Field label="City" required><Input value={form.cityName} onChange={(event) => updateForm('cityName', event.target.value)} placeholder="e.g. Dhaka" /></Field>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-navy-950"><ReceiptText className="h-4 w-4 text-brand-orange" aria-hidden />Commercial details</div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Currency"><Input value={BOOKING_CURRENCY} readOnly aria-label="Currency (BDT only)" /></Field>
              <Field label="Gross amount" required><Input inputMode="decimal" value={form.supplierGrossAmount} onChange={(event) => updateMoneyForm('supplierGrossAmount', event.target.value)} placeholder="9,000.00" /></Field>
              <Field label="Supplier payable" required><Input inputMode="decimal" value={form.supplierPayableAmount} onChange={(event) => updateMoneyForm('supplierPayableAmount', event.target.value)} placeholder="8,750.00" /></Field>
              <Field label="User payable amount" required><Input inputMode="decimal" value={form.userPayableAmount} onChange={(event) => updateMoneyForm('userPayableAmount', event.target.value)} placeholder="9,500.00" /></Field>
              <Field label="Refundability" required><Select value={form.refundable ? 'refundable' : 'non-refundable'} onValueChange={(value) => updateForm('refundable', value === 'refundable')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="refundable">Refundable</SelectItem><SelectItem value="non-refundable">Non-refundable</SelectItem></SelectContent></Select></Field>
            </div>
            <p className="mt-3 text-xs text-neutral-500">All amounts must be in BDT. Amounts are grouped automatically. Enter <strong>42388.00</strong> or <strong>42,388.00</strong>.</p>
          </div>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-bold text-black">3</span>
              <div>
                <h3 className="text-base font-semibold text-navy-950">Passengers and fare breakdown</h3>
                <p className="mt-0.5 text-sm text-neutral-500">Add one card per passenger. The fare total is currently {BOOKING_CURRENCY} {totalPassengerFare.toLocaleString()}.</p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPassengers((items) => [...items, emptyPassenger()])} disabled={passengers.length >= 20}><Plus className="mr-1 h-4 w-4" />Add passenger</Button>
          </div>

          <div className="space-y-4">
            {passengers.map((passenger, index) => (
              <article key={index} className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/70">
                <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
                  <strong className="text-sm text-navy-950">Passenger #{index + 1}</strong>
                  {passengers.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setPassengers((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Minus className="mr-1 h-4 w-4" />Remove</Button>}
                </div>
                <div className="space-y-5 p-4">
                  <div>
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Traveller details</p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                      <Field label="Passenger type" required><Select value={passenger.passengerType} onValueChange={(value) => updatePassenger(index, 'passengerType', value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['ADT', 'CHD', 'CNN', 'INF', 'INS'].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
                      <Field label="Title" required><Select value={passenger.title} onValueChange={(value) => updatePassenger(index, 'title', value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss'].map((value) => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent></Select></Field>
                      <Field label="First name" required><Input value={passenger.firstName} onChange={(event) => updatePassenger(index, 'firstName', event.target.value)} placeholder="As printed in passport" /></Field>
                      <Field label="Last name" required><Input value={passenger.lastName} onChange={(event) => updatePassenger(index, 'lastName', event.target.value)} placeholder="As printed in passport" /></Field>
                      <Field label="Gender" required><Select value={passenger.gender} onValueChange={(value) => updatePassenger(index, 'gender', value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Male">Male</SelectItem><SelectItem value="Female">Female</SelectItem></SelectContent></Select></Field>
                      <Field label="Date of birth" required><Input type="date" value={passenger.dateOfBirth} onChange={(event) => updatePassenger(index, 'dateOfBirth', event.target.value)} /></Field>
                      <Field label="Nationality" required><Input value={passenger.nationality} onChange={(event) => updatePassenger(index, 'nationality', event.target.value.toUpperCase().slice(0, 3))} placeholder="e.g. BD" /></Field>
                      <Field label="Passport number"><Input value={passenger.passportNumber} onChange={(event) => updatePassenger(index, 'passportNumber', event.target.value)} placeholder="Passport document number" /></Field>
                      <Field label="Passport expiry"><Input type="date" value={passenger.passportExpiry} onChange={(event) => updatePassenger(index, 'passportExpiry', event.target.value)} /></Field>
                    </div>
                  </div>

                  <div className="border-t border-neutral-200 pt-4">
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Fare for this passenger</p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                      <Field label="Base fare" required><Input inputMode="decimal" value={passenger.basePrice} onChange={(event) => updateMoneyPassenger(index, 'basePrice', event.target.value)} placeholder="0.00" /></Field>
                      <Field label="Taxes" required><Input inputMode="decimal" value={passenger.taxes} onChange={(event) => updateMoneyPassenger(index, 'taxes', event.target.value)} placeholder="0.00" /></Field>
                      <Field label="AIT" required><Input inputMode="decimal" value={passenger.ait} onChange={(event) => updateMoneyPassenger(index, 'ait', event.target.value)} placeholder="0.00" /></Field>
                      <Field label="Service margin" required><Input inputMode="decimal" value={passenger.serviceMargin} onChange={(event) => updateMoneyPassenger(index, 'serviceMargin', event.target.value)} placeholder="0.00" /></Field>
                      <Field label="Fare total" required><Input inputMode="decimal" value={passenger.totalPrice} onChange={(event) => updateMoneyPassenger(index, 'totalPrice', event.target.value)} placeholder="0.00" /></Field>
                      {initialStatus === 'confirmed' && <Field label="Ticket number" required><Input value={passenger.ticketNumber} onChange={(event) => updatePassenger(index, 'ticketNumber', event.target.value)} placeholder="e.g. 6181234567890" /></Field>}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {initialStatus === 'confirmed' && <div className="mt-4 max-w-sm rounded-lg border border-amber-200 bg-amber-50/70 p-4"><Field label="Ticket issued date and time" required><Input type="datetime-local" value={form.issuedAt} onChange={(event) => updateForm('issuedAt', event.target.value)} /></Field></div>}
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-bold text-navy-950">4</span>
              <div>
                <h3 className="text-base font-semibold text-navy-950">Flight itinerary</h3>
                <p className="mt-0.5 text-sm text-neutral-500">Use the same leg number for connections. Add another leg for a return or multi-city journey.</p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setSegments((items) => [...items, emptySegment()])} disabled={segments.length >= 40}><Plus className="mr-1 h-4 w-4" />Add segment</Button>
          </div>

          <div className="space-y-4">
            {segments.map((segment, index) => (
              <article key={index} className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/70">
                <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-2"><Plane className="h-4 w-4 text-brand-orange" aria-hidden /><strong className="text-sm text-navy-950">Segment #{index + 1}</strong></div>
                  {segments.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setSegments((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Minus className="mr-1 h-4 w-4" />Remove</Button>}
                </div>
                <div className="space-y-5 p-4">
                  <div>
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Flight</p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                      <Field label="Leg" required><Input type="number" min="1" value={segment.leg} onChange={(event) => updateSegment(index, 'leg', event.target.value)} placeholder="e.g. 1" /></Field>
                      <Field label="Carrier code" required><Input value={segment.carrierCode} onChange={(event) => updateCarrierCode(index, event.target.value)} placeholder="e.g. SQ" maxLength={2} />{carrierLookupErrors[segment.carrierCode] && <p className="mt-1 text-xs text-amber-700">{carrierLookupErrors[segment.carrierCode]}</p>}</Field>
                      <Field label="Carrier name" required><Input value={segment.carrierName} onChange={(event) => updateSegment(index, 'carrierName', event.target.value)} readOnly={!carrierLookupErrors[segment.carrierCode]} placeholder="Enter carrier code first" /></Field>
                      <Field label="Flight number" required><Input value={segment.flightNumber} onChange={(event) => updateSegment(index, 'flightNumber', event.target.value)} placeholder="e.g. 447" /></Field>
                      <Field label="Cabin" required><Input value={segment.cabin} onChange={(event) => updateSegment(index, 'cabin', event.target.value)} placeholder="e.g. Economy" /></Field>
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-neutral-200 pt-4 lg:grid-cols-2">
                    <div className="rounded-md border border-neutral-200 bg-white p-3">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Origin</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Airport code" required><Input value={segment.fromCode} onChange={(event) => updateAirportCode(index, 'from', event.target.value)} placeholder="e.g. DAC" maxLength={3} />{airportLookupErrors[segment.fromCode] && <p className="mt-1 text-xs text-amber-700">{airportLookupErrors[segment.fromCode]}</p>}</Field>
                        <Field label="City" required><Input value={segment.fromCity} onChange={(event) => updateSegment(index, 'fromCity', event.target.value)} readOnly={!airportLookupErrors[segment.fromCode]} placeholder="Enter airport code first" /></Field>
                        <Field label="Airport name"><Input value={segment.fromAirport} onChange={(event) => updateSegment(index, 'fromAirport', event.target.value)} readOnly={!airportLookupErrors[segment.fromCode]} placeholder="Enter airport code first" /></Field>
                        <Field label="Departure terminal (optional)"><Input value={segment.fromTerminal} onChange={(event) => updateSegment(index, 'fromTerminal', event.target.value)} placeholder="e.g. Terminal 1" /></Field>
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-white p-3">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Destination</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Airport code" required><Input value={segment.toCode} onChange={(event) => updateAirportCode(index, 'to', event.target.value)} placeholder="e.g. CGP" maxLength={3} />{airportLookupErrors[segment.toCode] && <p className="mt-1 text-xs text-amber-700">{airportLookupErrors[segment.toCode]}</p>}</Field>
                        <Field label="City" required><Input value={segment.toCity} onChange={(event) => updateSegment(index, 'toCity', event.target.value)} readOnly={!airportLookupErrors[segment.toCode]} placeholder="Enter airport code first" /></Field>
                        <Field label="Airport name"><Input value={segment.toAirport} onChange={(event) => updateSegment(index, 'toAirport', event.target.value)} readOnly={!airportLookupErrors[segment.toCode]} placeholder="Enter airport code first" /></Field>
                        <Field label="Arrival terminal (optional)"><Input value={segment.toTerminal} onChange={(event) => updateSegment(index, 'toTerminal', event.target.value)} placeholder="e.g. Terminal 2" /></Field>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 border-t border-neutral-200 pt-4 sm:grid-cols-2 xl:grid-cols-5">
                    <Field label="Departure" required><ManualDateTimeField ariaLabel={`Segment ${index + 1} departure`} value={segment.departureAt} onChange={(value) => updateSegment(index, 'departureAt', value)} /></Field>
                    <Field label="Arrival" required><ManualDateTimeField ariaLabel={`Segment ${index + 1} arrival`} value={segment.arrivalAt} onChange={(value) => updateSegment(index, 'arrivalAt', value)} /></Field>
                    <Field label="Flight duration" required><Input value={segment.duration} onChange={(event) => updateSegment(index, 'duration', event.target.value)} placeholder="e.g. 4h 5m or 04:05" /></Field>
                    <Field label="Booking class (RBD)" required><Input value={segment.bookingClass} onChange={(event) => updateSegment(index, 'bookingClass', event.target.value)} placeholder="e.g. N" /></Field>
                    <Field label="Aircraft model" required><Input value={segment.aircraft} onChange={(event) => updateSegment(index, 'aircraft', event.target.value)} placeholder="e.g. A350-900 or DH8" /></Field>
                    <Field label="Check-in baggage" required><Input value={segment.baggage} onChange={(event) => updateSegment(index, 'baggage', event.target.value)} placeholder="e.g. 25 Kg or 1 PC" /></Field>
                    <Field label="Cabin baggage" required><Input value={segment.handBaggage} onChange={(event) => updateSegment(index, 'handBaggage', event.target.value)} placeholder="e.g. 7 Kg" /></Field>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-navy-100 bg-navy-50/50 p-4 sm:p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-orange text-xs font-bold text-black">5</span>
            <div>
              <h3 className="text-base font-semibold text-navy-950">Review and import</h3>
              <p className="mt-0.5 text-sm text-neutral-500">Add an internal note if helpful, then save the booking. The server validates every detail before any wallet charge.</p>
            </div>
          </div>
          <Field label="Internal note (optional)"><textarea className="min-h-20 w-full rounded-md border border-input bg-white px-3 py-2 text-sm" value={form.supplierMessage} onChange={(event) => updateForm('supplierMessage', event.target.value)} placeholder="e.g. Ticketing must be completed by the airline deadline." /></Field>
          {message && <p role="status" className={`mt-4 rounded-md border px-3 py-2 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</p>}
          <div className="mt-5 flex flex-col gap-3 border-t border-navy-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-xs text-neutral-500"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-navy-800" aria-hidden />All validation, ticket evidence, ownership, wallet debit and idempotency checks are enforced by the server.</div>
            <div className="flex shrink-0 flex-wrap items-center gap-3"><Button type="button" onClick={() => void submit()} disabled={submitting || !assignedToUserId} className="bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white">{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{initialStatus === 'confirmed' ? 'Import & Charge Confirmed Booking' : 'Import On Hold — No Wallet Charge'}</Button>{bookingUrl && <Button asChild variant="outline"><Link href={bookingUrl}>Open booking</Link></Button>}</div>
          </div>
        </section>
      </div>
    </section>
  );
}
