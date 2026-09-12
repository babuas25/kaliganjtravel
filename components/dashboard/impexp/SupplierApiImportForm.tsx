'use client';

import { DatabaseZap, Loader2, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import ImpExpUserPicker from '@/components/dashboard/impexp/ImpExpUserPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ImpExpAssignableUser } from '@/lib/impexp/types';
import type {
  SupplierReferenceBookingPreview,
  SupplierReferenceImportDecision,
} from '@/lib/supplier-reference-import/types';
import {
  SUPPLIER_REFERENCE_IDENTITIES,
  supplierReferenceMatchesAccount,
} from '@/lib/supplier-reference-import/identity';
import type { TriploverReferenceImportSupplier } from '@/lib/triplover/config';

type AssignRole = 'b2b' | 'b2b_sub' | 'customer';

const ROLES: Record<AssignRole, string> = {
  b2b: 'B2B Partner',
  b2b_sub: 'B2B Sub User',
  customer: 'Customer',
};

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-navy-950">
        {label}
        {required ? <span className="text-brand-orange"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function statusLabel(status: SupplierReferenceBookingPreview['status']) {
  if (status === 'on-hold') return 'On Hold';
  if (status === 'confirmed') return 'Confirmed';
  return 'Cancelled / Refunded';
}

export default function SupplierApiImportForm({
  onImported,
}: {
  onImported: () => Promise<void>;
}) {
  const [supplierAccount, setSupplierAccount] =
    useState<TriploverReferenceImportSupplier>('firsttrip');
  const [supplierReference, setSupplierReference] = useState('');
  const [assignRole, setAssignRole] = useState<AssignRole>('b2b');
  const [users, setUsers] = useState<ImpExpAssignableUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [assignedToUserId, setAssignedToUserId] = useState('');
  const [preview, setPreview] =
    useState<SupplierReferenceBookingPreview | null>(null);
  const [retrieving, setRetrieving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittingDecision, setSubmittingDecision] =
    useState<SupplierReferenceImportDecision | null>(null);
  const [chargeConfirmed, setChargeConfirmed] = useState(false);
  const [authorizationRequestId, setAuthorizationRequestId] =
    useState<string | null>(null);
  const [importRequestId, setImportRequestId] = useState<string | null>(null);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setUsersLoading(true);
    setAssignedToUserId('');
    setPreview(null);
    setAuthorizationRequestId(null);
    setImportRequestId(null);
    fetch(`/api/impexp/users?role=${assignRole}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          users?: ImpExpAssignableUser[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || 'Owners could not be loaded.');
        setUsers(Array.isArray(body.users) ? body.users : []);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setUsers([]);
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Owners could not be loaded.',
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsersLoading(false);
      });
    return () => controller.abort();
  }, [assignRole]);

  const supplierIdentity = SUPPLIER_REFERENCE_IDENTITIES[supplierAccount];
  const expectedPrefix = supplierIdentity.prefix;
  const normalizedReference = supplierReference.trim().toUpperCase();
  const validReference = supplierReferenceMatchesAccount(
    supplierAccount,
    normalizedReference,
  );
  function invalidateLookup() {
    setPreview(null);
    setAuthorizationRequestId(null);
    setImportRequestId(null);
    setChargeConfirmed(false);
    setBookingUrl(null);
    setMessage(null);
  }

  async function retrieve() {
    if (!validReference) {
      setMessage({
        kind: 'error',
        text: `Enter a valid ${expectedPrefix} supplier reference for ${supplierIdentity.label}.`,
      });
      return;
    }
    if (!assignedToUserId) {
      setMessage({ kind: 'error', text: 'Select the Booking Owner before pricing.' });
      return;
    }
    setRetrieving(true);
    setMessage(null);
    setBookingUrl(null);
    try {
      const response = await fetch('/api/supplier-reference-import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierAccount,
          supplierReference: normalizedReference,
          assignedToUserId,
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        preview?: SupplierReferenceBookingPreview;
        error?: string;
      };
      if (!response.ok || !body.success || !body.preview) {
        throw new Error(body.error || 'Supplier booking could not be retrieved.');
      }
      setPreview(body.preview);
      setAuthorizationRequestId(null);
      setImportRequestId(null);
      setChargeConfirmed(false);
      setMessage({
        kind: 'success',
        text: 'Supplier API booking retrieved and verified through the live PNR endpoint.',
      });
    } catch (error) {
      setPreview(null);
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Supplier retrieval failed.',
      });
    } finally {
      setRetrieving(false);
    }
  }

  async function submit(importDecision: SupplierReferenceImportDecision) {
    if (!preview) {
      setMessage({ kind: 'error', text: 'Retrieve and review the supplier booking first.' });
      return;
    }
    if (!assignedToUserId) {
      setMessage({ kind: 'error', text: 'Assign the booking owner first.' });
      return;
    }
    if (importDecision === 'import_and_charge' && preview.status !== 'confirmed') {
      setMessage({
        kind: 'error',
        text: 'Only an issued or ticketed booking can use Import & Charge.',
      });
      return;
    }
    if (importDecision === 'import_and_charge' && !chargeConfirmed) {
      setMessage({
        kind: 'error',
        text: 'Confirm the explicit wallet debit before authorizing Import & Charge.',
      });
      return;
    }

    setSubmitting(true);
    setSubmittingDecision(importDecision);
    setMessage(null);
    setBookingUrl(null);
    try {
      const common = {
        supplierAccount,
        supplierReference: normalizedReference,
        assignedToUserId,
        pricingConfirmation: preview.pricingConfirmation,
      };
      let chargeAuthorizationId: string | undefined;
      if (importDecision === 'import_and_charge') {
        const requestId = authorizationRequestId ?? crypto.randomUUID();
        setAuthorizationRequestId(requestId);
        const authorizationResponse = await fetch(
          '/api/supplier-reference-import/authorize-charge',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...common, requestId }),
          },
        );
        const authorization = (await authorizationResponse.json()) as {
          success?: boolean;
          authorizationId?: string;
          error?: string;
        };
        if (
          !authorizationResponse.ok ||
          !authorization.success ||
          !authorization.authorizationId
        ) {
          throw new Error(authorization.error || 'Wallet authorization failed.');
        }
        chargeAuthorizationId = authorization.authorizationId;
      }

      const requestId = importRequestId ?? crypto.randomUUID();
      setImportRequestId(requestId);
      const response = await fetch('/api/supplier-reference-import/import-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...common,
          requestId,
          importDecision,
          ...(chargeAuthorizationId ? { chargeAuthorizationId } : {}),
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        referenceNo?: string;
        bookingOrderUrl?: string;
        walletCharged?: boolean;
        chargedAmount?: number;
        paymentState?: string;
        replay?: boolean;
        error?: string;
      };
      if (!response.ok || !body.success || !body.referenceNo) {
        throw new Error(body.error || 'Supplier API Import failed.');
      }
      const chargeText = body.walletCharged
        ? ` Wallet captured ${preview.currency} ${(
            Number(body.chargedAmount) / 100
          ).toLocaleString()}.`
        : ' No wallet debit or refund transaction was created.';
      setMessage({
        kind: 'success',
        text: `${body.replay ? 'Recovered' : 'Imported'} ${supplierIdentity.label} ${normalizedReference} as ${body.referenceNo}.${chargeText}`,
      });
      setBookingUrl(body.bookingOrderUrl ?? null);
      await onImported();
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Supplier API Import failed.',
      });
    } finally {
      setSubmitting(false);
      setSubmittingDecision(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-navy-100 bg-gradient-to-r from-navy-50 via-white to-brand-orange-light/40 px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange text-black shadow-sm">
            <DatabaseZap className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-orange-dark">
              Supplier API Import
            </p>
            <h2 className="mt-1 text-lg font-bold text-navy-950">
              Retrieve by FirstTrip, TakeOff, or Triplover reference
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-neutral-600">
              The server retrieves AirTicketingDetails, recovers the real operational
              references, and verifies the current booking through PNR. Airline and
              passenger fields are populated from the supplier.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Supplier account" required>
            <Select
              value={supplierAccount}
              onValueChange={(value) => {
                setSupplierAccount(value as TriploverReferenceImportSupplier);
                setSupplierReference('');
                invalidateLookup();
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="firsttrip">FirstTrip</SelectItem>
                <SelectItem value="takeoff">TakeOff</SelectItem>
                <SelectItem value="triplover">Triplover</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={`${expectedPrefix} supplier reference`} required>
            <Input
              value={supplierReference}
              onChange={(event) => {
                setSupplierReference(event.target.value.toUpperCase());
                invalidateLookup();
              }}
              placeholder={`${expectedPrefix}639…`}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="grid gap-4 rounded-xl border border-navy-100 bg-navy-50/50 p-4 md:grid-cols-[0.8fr_1.2fr_auto] md:items-end">
          <Field label="Owner type" required>
            <Select value={assignRole} onValueChange={(value) => setAssignRole(value as AssignRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(ROLES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Booking Owner" required>
            <ImpExpUserPicker
              users={users}
              value={assignedToUserId}
              onValueChange={(value) => {
                setAssignedToUserId(value);
                invalidateLookup();
              }}
              loading={usersLoading}
              role={assignRole}
            />
          </Field>
          <Button
            type="button"
            onClick={() => void retrieve()}
            disabled={retrieving || !validReference || !assignedToUserId}
            className="bg-brand-orange text-black hover:bg-brand-orange/90"
          >
            {retrieving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            {retrieving ? 'Retrieving & pricing…' : 'Retrieve & calculate'}
          </Button>
        </div>

        {message ? (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              message.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {message.text}
          </div>
        ) : null}

        {preview ? (
          <>
            <div className="grid gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Summary label="Status" value={`${statusLabel(preview.status)} · ${preview.supplierStatus}`} />
              <Summary label="Route" value={preview.route} />
              <Summary label="PNR" value={preview.airlinesPnr.join(', ') || preview.pnr} />
              <Summary
                label="Supplier Payable"
                value={money(preview.supplierPayable, preview.currency)}
              />
              <Summary
                label="Supplier Gross"
                value={money(preview.supplierGross, preview.currency)}
              />
              <Summary
                label="User Payable · Read only"
                value={money(preview.userPayable, preview.currency)}
              />
              <Summary label="Airline" value={preview.airline || '—'} />
              <Summary label="Passengers" value={String(preview.passengerCount)} />
              <Summary label="Travel date" value={preview.travelDate} />
              <Summary label="Tickets" value={String(preview.ticketCount)} />
            </div>

            <p className="text-xs text-neutral-500">
              User Payable is calculated at import time from the supplier authoritative booked fare and the selected owner&apos;s current canonical markup rules. It is not the historical selling price.
            </p>

            <div className="rounded-xl border border-neutral-200 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                <div className="text-sm text-neutral-600">
                  <p className="font-semibold text-navy-950">Financial decision</p>
                  <p className="mt-1">
                    {preview.status === 'on-hold'
                      ? 'On Hold import makes no wallet movement. Issue Now later uses the normal API wallet reservation and ticketing flow.'
                      : preview.status === 'confirmed'
                        ? 'Choose an explicit historical no-wallet import or authorize one exact wallet debit. The supplier payment flag never counts as a local wallet payment.'
                        : 'Cancelled/refunded history is imported without inventing a local debit or refund transaction.'}
                  </p>
                </div>
              </div>

              {preview.status === 'confirmed' ? (
                <label className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={chargeConfirmed}
                    onChange={(event) => {
                      setChargeConfirmed(event.target.checked);
                      setAuthorizationRequestId(null);
                      setImportRequestId(null);
                    }}
                  />
                  I explicitly authorize debiting the assigned owner&apos;s wallet by
                  the protected User Payable amount for this already-ticketed booking.
                </label>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting || !assignedToUserId}
                  onClick={() => void submit('import_only')}
                >
                  {submitting && submittingDecision === 'import_only' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {preview.status === 'on-hold'
                    ? 'Import On Hold — No Wallet Charge'
                    : preview.status === 'confirmed'
                      ? 'Import Historical — No Wallet Movement'
                      : 'Import Terminal History — No Wallet Movement'}
                </Button>
                {preview.status === 'confirmed' ? (
                  <Button
                    type="button"
                    disabled={
                      submitting ||
                      !assignedToUserId ||
                      !chargeConfirmed
                    }
                    onClick={() => void submit('import_and_charge')}
                    className="bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white"
                  >
                    {submitting && submittingDecision === 'import_and_charge' ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Authorize Import &amp; Charge
                  </Button>
                ) : null}
                {bookingUrl ? (
                  <Button asChild type="button" variant="outline">
                    <Link href={bookingUrl}>Open booking</Link>
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-semibold text-navy-950">{value || '—'}</p>
    </div>
  );
}
