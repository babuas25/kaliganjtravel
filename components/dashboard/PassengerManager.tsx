'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react';

import { isValidTitleForPassenger, titleOptionsForPassenger } from '@/lib/flights/booking';
import {
  canonicalPassengerProfileType,
  passengerProfileDobBounds,
  passengerProfileTypeLabel,
} from '@/lib/passengers';
import type { PassengerProfile, PassengerSsrRequest } from '@/lib/passengers';

type PassengerDraft = Omit<
  Pick<
    PassengerProfile,
    | 'passengerType'
    | 'title'
    | 'firstName'
    | 'lastName'
    | 'gender'
    | 'nationality'
    | 'phoneCountryCode'
    | 'phone'
    | 'email'
    | 'dateOfBirth'
    | 'passportNumber'
    | 'passportExpiry'
    | 'issuingCountry'
    | 'loyaltyAirlineCode'
    | 'loyaltyAccountNumber'
    | 'ssrRequests'
    | 'organization'
  >,
  'passengerType' | 'title' | 'gender'
> & {
  passengerType: PassengerProfile['passengerType'] | '';
  title: PassengerProfile['title'] | '';
  gender: PassengerProfile['gender'] | '';
};

type Props = {
  title: string;
  description: string;
  canDelete: boolean;
};

const EMPTY_DRAFT: PassengerDraft = {
  passengerType: '',
  title: '',
  firstName: '',
  lastName: '',
  gender: '',
  nationality: '',
  phoneCountryCode: '',
  phone: '',
  email: '',
  dateOfBirth: '',
  passportNumber: '',
  passportExpiry: '',
  issuingCountry: '',
  loyaltyAirlineCode: '',
  loyaltyAccountNumber: '',
  ssrRequests: [],
  organization: '',
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm uppercase outline-none transition placeholder:normal-case placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100';

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = (await response.json()) as {
    success?: boolean;
    data?: { passengers?: PassengerProfile[]; passenger?: PassengerProfile; removed?: boolean };
    error?: { errorMessage?: string };
  };
  if (!response.ok || body.success === false) {
    throw new Error(body.error?.errorMessage || 'Passenger profile operation failed.');
  }
  return body.data ?? {};
}

function fullName(passenger: PassengerProfile) {
  return `${passenger.firstName} ${passenger.lastName}`.trim();
}

function phoneLabel(passenger: PassengerProfile) {
  return passenger.phone ? `${passenger.phoneCountryCode} ${passenger.phone}`.trim() : 'Not saved';
}

export default function PassengerManager({ title, description, canDelete }: Props) {
  const [passengers, setPassengers] = useState<PassengerProfile[]>([]);
  const [draft, setDraft] = useState<PassengerDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<PassengerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const data = await api('/api/passengers?limit=100');
      setPassengers(data.passengers ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Saved passengers could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return passengers;
    return passengers.filter((passenger) =>
      [passenger.publicRef, passenger.firstName, passenger.lastName, passenger.email, passenger.phone]
        .join(' ')
        .toLowerCase()
        .includes(term)
    );
  }, [passengers, search]);

  const availableTitles = draft.passengerType && draft.gender
    ? titleOptionsForPassenger(draft.passengerType, draft.gender)
    : [];
  const profileDobBounds = draft.passengerType
    ? passengerProfileDobBounds(draft.passengerType)
    : null;

  function update(field: keyof PassengerDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updatePassengerType(value: PassengerProfile['passengerType']) {
    setDraft((current) => {
      const title = current.gender && current.title && !isValidTitleForPassenger(value, current.gender, current.title)
        ? titleOptionsForPassenger(value, current.gender)[0]
        : current.title;
      return { ...current, passengerType: value, title };
    });
  }

  function updatePassengerGender(value: PassengerProfile['gender']) {
    setDraft((current) => {
      const title = current.passengerType && (!current.title || !isValidTitleForPassenger(current.passengerType, value, current.title))
        ? titleOptionsForPassenger(current.passengerType, value)[0]
        : current.title;
      return { ...current, gender: value, title };
    });
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  function beginEdit(passenger: PassengerProfile) {
    const passengerType = canonicalPassengerProfileType(passenger.passengerType);
    const title = isValidTitleForPassenger(passengerType, passenger.gender, passenger.title)
      ? passenger.title
      : titleOptionsForPassenger(passengerType, passenger.gender)[0];
    setEditing(passenger);
    setDraft({
      passengerType,
      title,
      firstName: passenger.firstName,
      lastName: passenger.lastName,
      gender: passenger.gender,
      nationality: passenger.nationality,
      phoneCountryCode: passenger.phoneCountryCode,
      phone: passenger.phone,
      email: passenger.email,
      dateOfBirth: passenger.dateOfBirth,
      passportNumber: passenger.passportNumber,
      passportExpiry: passenger.passportExpiry,
      issuingCountry: passenger.issuingCountry,
      loyaltyAirlineCode: passenger.loyaltyAirlineCode,
      loyaltyAccountNumber: passenger.loyaltyAccountNumber,
      ssrRequests: passenger.ssrRequests,
      organization: passenger.organization,
    });
    setNotice(null);
  }

  function updateSsr(index: number, field: keyof PassengerSsrRequest, value: string) {
    setDraft((current) => ({
      ...current,
      ssrRequests: current.ssrRequests.map((request, position) =>
        position === index ? { ...request, [field]: value } : request
      ),
    }));
  }

  function addSsr() {
    setDraft((current) => ({
      ...current,
      ssrRequests: [...current.ssrRequests, { code: '', remark: '' }],
    }));
  }

  function removeSsr(index: number) {
    setDraft((current) => ({
      ...current,
      ssrRequests: current.ssrRequests.filter((_, position) => position !== index),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('form');
    setNotice(null);
    try {
      const data = await api('/api/passengers', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { ...draft, id: editing.id } : draft),
      });
      if (!data.passenger) throw new Error('The saved passenger was not returned.');
      setPassengers((current) =>
        editing
          ? current.map((passenger) => passenger.id === data.passenger?.id ? data.passenger : passenger)
          : [data.passenger!, ...current]
      );
      setNotice(editing ? 'Passenger profile updated.' : `Passenger saved as ${data.passenger.publicRef}.`);
      cancelEdit();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Passenger profile could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(passenger: PassengerProfile) {
    if (!window.confirm(`Delete ${fullName(passenger)} (${passenger.publicRef})?`)) return;
    setBusy(passenger.id);
    setNotice(null);
    try {
      await api('/api/passengers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: passenger.id }),
      });
      setPassengers((current) => current.filter((item) => item.id !== passenger.id));
      if (editing?.id === passenger.id) cancelEdit();
      setNotice('Passenger profile deleted. Existing bookings were not changed.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Passenger profile could not be deleted.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <section className="overflow-hidden rounded-xl border border-navy-100 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-navy-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
              <Users className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-bold text-navy-950">{title}</h1>
              <p className="mt-0.5 max-w-2xl text-sm text-neutral-500">{description}</p>
            </div>
          </div>
          <p className="rounded-full bg-navy-50 px-3 py-1.5 text-xs font-semibold text-navy-700">
            {passengers.length} saved
          </p>
        </div>

        <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-navy-950">{editing ? 'Edit passenger' : 'Add passenger'}</h2>
              {editing && (
                <button type="button" onClick={cancelEdit} className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-navy-950">
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-navy-950">
                Passenger type <span className="text-brand-orange">*</span>
                <select required value={draft.passengerType} onChange={(event) => updatePassengerType(event.target.value as PassengerProfile['passengerType'])} className={`${CONTROL} normal-case`}>
                  <option value="" disabled>Select passenger type</option>
                  <option value="ADT">Adult</option><option value="CHD">Child</option><option value="INF">Infant</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-navy-950">
                Title <span className="text-brand-orange">*</span>
                <select required disabled={!availableTitles.length} value={draft.title} onChange={(event) => update('title', event.target.value)} className={`${CONTROL} normal-case`}>
                  <option value="" disabled>Select title</option>
                  {availableTitles.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-navy-950">
                First name <span className="text-brand-orange">*</span>
                <input required maxLength={60} value={draft.firstName} onChange={(event) => update('firstName', event.target.value.toUpperCase())} className={CONTROL} />
              </label>
              <label className="block text-sm font-medium text-navy-950">
                Last name <span className="text-brand-orange">*</span>
                <input required maxLength={60} value={draft.lastName} onChange={(event) => update('lastName', event.target.value.toUpperCase())} className={CONTROL} />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-navy-950">
                Gender <span className="text-brand-orange">*</span>
                <select required value={draft.gender} onChange={(event) => updatePassengerGender(event.target.value as PassengerProfile['gender'])} className={`${CONTROL} normal-case`}><option value="" disabled>Select gender</option><option value="Male">Male</option><option value="Female">Female</option></select>
              </label>
              <label className="block text-sm font-medium text-navy-950">
                Nationality <span className="text-brand-orange">*</span>
                <input required maxLength={2} value={draft.nationality} onChange={(event) => update('nationality', event.target.value.toUpperCase())} placeholder="e.g. BD" className={CONTROL} />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <label className="block text-sm font-medium text-navy-950">Country code
                <input inputMode="tel" maxLength={5} value={draft.phoneCountryCode} onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
                  update('phoneCountryCode', digits ? `+${digits}` : '');
                }} placeholder="+880" className={`${CONTROL} normal-case`} />
              </label>
              <label className="block text-sm font-medium text-navy-950">Phone number
                <input inputMode="tel" maxLength={15} value={draft.phone} onChange={(event) => update('phone', event.target.value.replace(/\D/g, ''))} placeholder="01XXXXXXXXX" className={`${CONTROL} normal-case`} />
              </label>
            </div>
            <label className="block text-sm font-medium text-navy-950">Email address
              <input type="email" maxLength={254} value={draft.email} onChange={(event) => update('email', event.target.value)} placeholder="customer@example.com" className={`${CONTROL} normal-case`} />
            </label>
            <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
              <legend className="px-1 text-sm font-semibold text-navy-950">Document details <span className="font-normal text-neutral-500">(optional)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-medium text-navy-950">Date of birth
                  <input type="date" min={profileDobBounds?.min} max={profileDobBounds?.max} disabled={!profileDobBounds} value={draft.dateOfBirth} onChange={(event) => update('dateOfBirth', event.target.value)} className={`${CONTROL} normal-case`} />
                </label>
                <label className="block text-sm font-medium text-navy-950">Passport number
                  <input maxLength={20} value={draft.passportNumber} onChange={(event) => update('passportNumber', event.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())} className={CONTROL} />
                </label>
                <label className="block text-sm font-medium text-navy-950">Passport expiry (DOE)
                  <input type="date" value={draft.passportExpiry} onChange={(event) => update('passportExpiry', event.target.value)} className={`${CONTROL} normal-case`} />
                </label>
                <label className="block text-sm font-medium text-navy-950">Passport issuing country
                  <input maxLength={2} value={draft.issuingCountry} onChange={(event) => update('issuingCountry', event.target.value.toUpperCase())} placeholder="e.g. BD" className={CONTROL} />
                </label>
              </div>
            </fieldset>
            <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
              <legend className="px-1 text-sm font-semibold text-navy-950">Loyalty & organisation <span className="font-normal text-neutral-500">(optional)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-medium text-navy-950">Loyalty airline code
                  <input maxLength={10} value={draft.loyaltyAirlineCode} onChange={(event) => update('loyaltyAirlineCode', event.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())} placeholder="e.g. BG" className={CONTROL} />
                </label>
                <label className="block text-sm font-medium text-navy-950">Loyalty membership ID
                  <input maxLength={50} value={draft.loyaltyAccountNumber} onChange={(event) => update('loyaltyAccountNumber', event.target.value.toUpperCase())} className={CONTROL} />
                </label>
              </div>
              <label className="block text-sm font-medium text-navy-950">Organisation
                <input maxLength={120} value={draft.organization} onChange={(event) => update('organization', event.target.value)} placeholder="Optional employer or organisation" className={`${CONTROL} normal-case`} />
              </label>
            </fieldset>
            <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="px-1 text-sm font-semibold text-navy-950">Special service requests (SSR) <span className="font-normal text-neutral-500">(optional)</span></p>
                <button type="button" onClick={addSsr} disabled={draft.ssrRequests.length >= 8} className="rounded-md border border-navy-200 px-2.5 py-1.5 text-xs font-semibold text-navy-700 hover:bg-navy-50 disabled:opacity-60">Add SSR</button>
              </div>
              {draft.ssrRequests.map((request, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
                  <input maxLength={10} value={request.code} onChange={(event) => updateSsr(index, 'code', event.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())} placeholder="Code" aria-label={`SSR code ${index + 1}`} className={CONTROL} />
                  <input maxLength={250} value={request.remark} onChange={(event) => updateSsr(index, 'remark', event.target.value)} placeholder="Optional remark" aria-label={`SSR remark ${index + 1}`} className={`${CONTROL} normal-case`} />
                  <button type="button" onClick={() => removeSsr(index)} className="mt-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">Remove</button>
                </div>
              ))}
              <p className="text-xs text-neutral-500">Only services supported by the selected airline can be requested during a booking.</p>
            </fieldset>
            <button disabled={busy === 'form'} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60">
              {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {busy === 'form' ? 'Saving...' : editing ? 'Save changes' : 'Save passenger'}
            </button>
          </form>

          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by KTP ID, name, email, or phone" className="w-full rounded-lg border border-neutral-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-navy-400 focus:ring-2 focus:ring-navy-100" />
            </div>
            {notice && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">{notice}</p>}
            {loading ? (
              <p className="rounded-lg border border-neutral-200 px-4 py-10 text-center text-sm text-neutral-500">Loading saved passengers…</p>
            ) : filtered.length ? filtered.map((passenger) => (
              <article key={passenger.id} className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-navy-950">{passenger.title} {fullName(passenger)}</p>
                    <p className="mt-0.5 font-mono text-xs font-semibold text-brand-orange-dark">{passenger.publicRef}</p>
                    <p className="mt-2 text-sm text-neutral-600">{passengerProfileTypeLabel(passenger.passengerType)} · {passenger.gender} · {passenger.nationality}</p>
                    <p className="mt-1 text-xs text-neutral-500">{phoneLabel(passenger)}{passenger.email ? ` · ${passenger.email}` : ''}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => beginEdit(passenger)} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-md border border-navy-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-700 hover:bg-navy-50 disabled:opacity-60"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    {canDelete && <button type="button" onClick={() => void remove(passenger)} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"><Trash2 className="h-3.5 w-3.5" /> Delete</button>}
                  </div>
                </div>
              </article>
            )) : (
              <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center"><Users className="mx-auto h-8 w-8 text-navy-200" /><p className="mt-3 text-sm font-semibold text-navy-950">No saved passengers found</p><p className="mt-1 text-sm text-neutral-500">Add a passenger, or change the search.</p></div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
