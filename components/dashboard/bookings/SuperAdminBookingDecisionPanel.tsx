'use client';

import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import type {
  SuperAdminIssueResolutionContext,
  SuperAdminIssueResolutionPreview,
  SuperAdminManualResolutionPreview,
  SuperAdminManualWalletAction,
  SuperAdminRefundDisposition,
  SuperAdminSupplierOutcome,
} from '@/lib/db/superadmin-booking-decisions';
import { formatWalletMoney, majorToMinor } from '@/lib/wallet/money';

type Preview =
  | SuperAdminIssueResolutionPreview
  | SuperAdminManualResolutionPreview;

const OUTCOMES: Array<{
  value: SuperAdminSupplierOutcome;
  label: string;
  description: string;
}> = [
  {
    value: 'ticket_issued',
    label: 'Ticket was issued',
    description: 'Confirm the booking and settle the customer wallet safely.',
  },
  {
    value: 'still_valid',
    label: 'Booking is still valid',
    description: 'Restore On Hold and release any active Issue Now Hold.',
  },
  {
    value: 'not_issued',
    label: 'Ticket was not issued',
    description: 'Cancel the booking and release or refund customer money safely.',
  },
];

const MANUAL_ACTIONS: Array<{
  value: SuperAdminManualWalletAction;
  label: string;
}> = [
  { value: 'none', label: 'No customer-wallet movement' },
  { value: 'credit_available', label: 'Credit Available balance' },
  { value: 'debit_available', label: 'Debit Available balance' },
  { value: 'release_orphan_hold', label: 'Move Hold back to Available' },
  { value: 'capture_orphan_hold', label: 'Capture from Hold' },
];

const AUTOMATIC_MONEY_EFFECTS = new Set([
  'capture_hold',
  'release_hold',
  'refund',
]);

class ResolutionError extends Error {
  code: string;

  constructor(message: string, code = 'RESOLUTION_REQUEST_FAILED') {
    super(message);
    this.code = code;
  }
}

function title(value: string | null | undefined): string {
  return value
    ? value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'Not recorded';
}

function accountingLabel(value: string | undefined): string {
  if (value === 'paid') return 'Already paid / captured';
  if (value === 'active_hold') return 'Active wallet Hold';
  if (value === 'unpaid') return 'No Hold and no captured payment';
  return 'Local accounting is incomplete';
}

function responseError(value: unknown): ResolutionError {
  if (!value || typeof value !== 'object') {
    return new ResolutionError('The resolution request failed.');
  }
  const error = (value as {
    error?: { errorCode?: unknown; errorMessage?: unknown };
  }).error;
  return new ResolutionError(
    typeof error?.errorMessage === 'string'
      ? error.errorMessage
      : 'The resolution request failed.',
    typeof error?.errorCode === 'string'
      ? error.errorCode
      : 'RESOLUTION_REQUEST_FAILED'
  );
}

function minorAmount(value: string, allowZero = false): number | null {
  if (!value.trim()) return allowZero ? 0 : null;
  try {
    return majorToMinor(value);
  } catch {
    return null;
  }
}

function automaticEffectText(preview: SuperAdminIssueResolutionPreview): string {
  const amount = formatWalletMoney(
    preview.walletAmount ?? 0,
    preview.currency ?? 'BDT'
  );
  switch (preview.walletEffect) {
    case 'capture_hold':
      return `Capture the existing ${amount} Hold exactly once.`;
    case 'release_hold':
      return `Release the existing ${amount} Hold back to Available.`;
    case 'refund':
      return `Credit a ${amount} refund to Available.`;
    case 'no_refund':
      return 'Record No Refund Due; no wallet balance moves.';
    case 'externally_settled':
      return 'Record the external settlement; no wallet balance moves.';
    default:
      return 'No customer-wallet balance movement.';
  }
}

function balance(
  label: string,
  amount: number | null | undefined,
  currency: string
) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-bold text-navy-950">
        {typeof amount === 'number'
          ? formatWalletMoney(amount, currency)
          : 'Unavailable'}
      </p>
    </div>
  );
}

export default function SuperAdminBookingDecisionPanel({
  bookingReference,
  storedStatus,
  lifecycleStatus,
  paymentState,
  initialContext,
}: {
  bookingReference: string;
  storedStatus: string;
  lifecycleStatus: string;
  paymentState: string;
  initialContext: SuperAdminIssueResolutionContext;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'automatic' | 'manual'>('automatic');
  const [supplierOutcome, setSupplierOutcome] =
    useState<SuperAdminSupplierOutcome | ''>('');
  const [refundDisposition, setRefundDisposition] =
    useState<SuperAdminRefundDisposition>('full_refund');
  const [partialAmount, setPartialAmount] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [deadline, setDeadline] = useState('');
  const [note, setNote] = useState('');
  const [manualAction, setManualAction] =
    useState<SuperAdminManualWalletAction>('none');
  const [issueNowCaseConfirmed, setIssueNowCaseConfirmed] = useState(false);
  const [customerAmount, setCustomerAmount] = useState('');
  const [customerAmountBasis, setCustomerAmountBasis] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [supplierAmount, setSupplierAmount] = useState('');
  const [supplierCurrency, setSupplierCurrency] = useState(
    initialContext.wallet?.currency ?? initialContext.accounting?.currency ?? 'BDT'
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [effectConfirmed, setEffectConfirmed] = useState(false);
  const [automaticErrorCode, setAutomaticErrorCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const accounting = initialContext.accounting;
  const currency =
    initialContext.wallet?.currency ?? accounting?.currency ?? 'BDT';
  const needsRefundDecision =
    mode === 'automatic' &&
    supplierOutcome === 'not_issued' &&
    accounting?.accountingState === 'paid' &&
    (accounting.outstandingAmount ?? 0) > 0;
  const deadlineRequired =
    supplierOutcome === 'still_valid' &&
    (mode === 'manual' || initialContext.lifecycleStatus === 'expired');
  const normalizedPartialAmount = useMemo(
    () => minorAmount(partialAmount),
    [partialAmount]
  );
  const normalizedCustomerAmount = useMemo(
    () => minorAmount(customerAmount, manualAction === 'none'),
    [customerAmount, manualAction]
  );
  const normalizedSupplierAmount = useMemo(
    () => (supplierAmount.trim() ? minorAmount(supplierAmount) : null),
    [supplierAmount]
  );
  const deadlineIso = useMemo(() => {
    if (!deadline) return null;
    const parsed = new Date(deadline);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }, [deadline]);

  const allowedManualActions = useMemo(() => {
    const allowed =
      supplierOutcome === 'ticket_issued'
        ? new Set(['none', 'debit_available', 'capture_orphan_hold'])
        : new Set(['none', 'credit_available', 'release_orphan_hold']);
    return MANUAL_ACTIONS.filter((item) => allowed.has(item.value));
  }, [supplierOutcome]);

  useEffect(() => {
    if (!allowedManualActions.some((item) => item.value === manualAction)) {
      setManualAction('none');
    }
  }, [allowedManualActions, manualAction]);

  useEffect(() => {
    setEffectConfirmed(false);
    setMessage(null);
    setPreview(null);
    setError(null);
    if (!supplierOutcome || !initialContext.ok) return;
    if (deadlineRequired && !deadlineIso) return;
    if (
      needsRefundDecision &&
      refundDisposition === 'partial_refund' &&
      normalizedPartialAmount === null
    ) {
      return;
    }
    if (
      needsRefundDecision &&
      refundDisposition === 'externally_settled' &&
      !externalReference.trim()
    ) {
      return;
    }
    if (mode === 'manual') {
      if (!issueNowCaseConfirmed) return;
      if (normalizedCustomerAmount === null) return;
      if (manualAction !== 'none' && !customerAmountBasis.trim()) return;
      if (supplierAmount.trim() && normalizedSupplierAmount === null) return;
    }

    const controller = new AbortController();
    const query = new URLSearchParams({ mode, supplierOutcome });
    if (deadlineIso) query.set('newDeadlineAt', deadlineIso);
    if (mode === 'automatic') {
      if (needsRefundDecision) {
        query.set('refundDisposition', refundDisposition);
        if (
          refundDisposition === 'partial_refund' &&
          normalizedPartialAmount !== null
        ) {
          query.set('refundAmount', String(normalizedPartialAmount));
        }
        if (refundDisposition === 'externally_settled') {
          query.set('externalSettlementReference', externalReference.trim());
        }
      }
    } else {
      query.set('customerWalletAction', manualAction);
      query.set('issueNowCaseConfirmed', 'true');
      query.set('customerWalletAmount', String(normalizedCustomerAmount ?? 0));
      if (customerAmountBasis.trim()) {
        query.set('customerAmountBasis', customerAmountBasis.trim());
      }
      if (supplierReference.trim()) {
        query.set('supplierReference', supplierReference.trim());
      }
      if (normalizedSupplierAmount !== null) {
        query.set('supplierAmount', String(normalizedSupplierAmount));
        query.set('supplierCurrency', supplierCurrency.toUpperCase());
      }
    }

    setPreviewBusy(true);
    void fetch(
      `/api/admin/bookings/${encodeURIComponent(bookingReference)}/decision?${query.toString()}`,
      { signal: controller.signal, cache: 'no-store' }
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          success?: boolean;
          data?: Preview;
        };
        if (!response.ok || !body.success || !body.data) {
          throw responseError(body);
        }
        setPreview(body.data);
        if (mode === 'automatic') setAutomaticErrorCode(null);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        const resolutionError =
          caught instanceof ResolutionError
            ? caught
            : new ResolutionError('The preview failed.');
        setError(resolutionError.message);
        if (mode === 'automatic') {
          setAutomaticErrorCode(resolutionError.code);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewBusy(false);
      });
    return () => controller.abort();
  }, [
    allowedManualActions,
    bookingReference,
    customerAmountBasis,
    deadlineRequired,
    deadlineIso,
    externalReference,
    initialContext.ok,
    issueNowCaseConfirmed,
    manualAction,
    mode,
    needsRefundDecision,
    normalizedCustomerAmount,
    normalizedPartialAmount,
    normalizedSupplierAmount,
    refundDisposition,
    supplierAmount,
    supplierCurrency,
    supplierOutcome,
    supplierReference,
  ]);

  const automaticMoneyMoves =
    mode === 'automatic' &&
    AUTOMATIC_MONEY_EFFECTS.has(
      (preview as SuperAdminIssueResolutionPreview | null)?.walletEffect ?? ''
    );
  const manualPreview =
    mode === 'manual' && preview?.ok
      ? (preview as SuperAdminManualResolutionPreview)
      : null;
  const automaticPreview =
    mode === 'automatic' && preview?.ok
      ? (preview as SuperAdminIssueResolutionPreview)
      : null;
  const canApply =
    Boolean(preview?.ok) &&
    (mode === 'manual' || automaticMoneyMoves ? effectConfirmed : true);
  const manualAvailable =
    automaticErrorCode === 'MANUAL_RESOLUTION_REQUIRED' ||
    !accounting?.ok ||
    (supplierOutcome === 'ticket_issued' && accounting?.accountingState === 'unpaid');

  async function applyResolution() {
    if (!supplierOutcome || !preview?.ok || !canApply) return;
    setApplyBusy(true);
    setError(null);
    setMessage(null);
    try {
      const common = {
        requestId: crypto.randomUUID(),
        mode,
        supplierOutcome,
        newDeadlineAt: deadlineIso,
        note: note.trim() || null,
      };
      const body =
        mode === 'automatic'
          ? {
              ...common,
              refundDisposition: needsRefundDecision
                ? refundDisposition
                : null,
              refundAmount:
                needsRefundDecision && refundDisposition === 'partial_refund'
                  ? normalizedPartialAmount
                  : null,
              externalSettlementReference:
                needsRefundDecision && refundDisposition === 'externally_settled'
                  ? externalReference.trim()
                  : null,
              moneyMovementConfirmed: automaticMoneyMoves
                ? effectConfirmed
                : false,
            }
          : {
              ...common,
              customerWalletAction: manualAction,
              issueNowCaseConfirmed,
              customerWalletAmount: normalizedCustomerAmount ?? 0,
              customerAmountBasis: customerAmountBasis.trim() || null,
              supplierReference: supplierReference.trim() || null,
              supplierAmount: normalizedSupplierAmount,
              supplierCurrency:
                normalizedSupplierAmount === null
                  ? null
                  : supplierCurrency.toUpperCase(),
              manualEffectConfirmed: effectConfirmed,
            };
      const response = await fetch(
        `/api/admin/bookings/${encodeURIComponent(bookingReference)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const responseBody = (await response.json()) as {
        success?: boolean;
        data?: { replay?: boolean };
      };
      if (!response.ok || !responseBody.success) {
        throw responseError(responseBody);
      }
      setMessage(
        responseBody.data?.replay
          ? 'The existing resolution result was safely reused.'
          : 'The Super Admin resolution was applied successfully.'
      );
      setSupplierOutcome('');
      setPreview(null);
      setEffectConfirmed(false);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The resolution failed.'
      );
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-navy-200 bg-white shadow-sm">
      <div className="border-b border-navy-100 bg-navy-50 px-5 py-4">
        <p className="flex items-center gap-2 text-sm font-bold text-navy-950">
          <ShieldCheck className="h-4 w-4 text-brand-orange" aria-hidden />
          Super Admin Issue Now Resolution
        </p>
        <p className="mt-1 text-xs leading-5 text-neutral-600">
          Record the supplier outcome directly. No evidence upload or second
          approval is required. This panel is restricted to stuck ordinary
          B2B/B2C Issue Now bookings.
        </p>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Stored status</p>
            <p className="mt-1 text-sm font-semibold text-navy-950">{title(storedStatus)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Lifecycle status</p>
            <p className="mt-1 text-sm font-semibold text-navy-950">{title(lifecycleStatus)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Displayed payment state</p>
            <p className="mt-1 text-sm font-semibold text-navy-950">{title(paymentState)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Actual local accounting</p>
            <p className="mt-1 text-sm font-semibold text-navy-950">{accountingLabel(accounting?.accountingState)}</p>
          </div>
        </div>

        {initialContext.wallet && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-bold text-blue-950">
              Current customer wallet ({title(initialContext.wallet.ownerType)})
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {balance('Available now', initialContext.wallet.availableBalance, currency)}
              {balance('Hold now', initialContext.wallet.holdBalance, currency)}
            </div>
          </div>
        )}

        {!initialContext.ok ? (
          <p className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            This booking is not eligible for this Issue Now resolution panel ({title(initialContext.code)}).
            Instant Purchase, imports, deposits, and other wallet flows remain unchanged.
          </p>
        ) : (
          <>
            {accounting?.paymentStateStale && (
              <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                The displayed payment state is stale. Actual reservation and ledger state takes priority.
              </p>
            )}
            {initialContext.legacyOperational && (
              <p className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                This is a retained historical operational booking. This explicit resolution is available, but the legacy flag remains unchanged so normal lifecycle workers are not broadened.
              </p>
            )}

            <fieldset className="grid gap-2">
              <legend className="text-xs font-semibold text-neutral-700">
                What did you verify in the supplier portal?
              </legend>
              <div className="grid gap-2 lg:grid-cols-3">
                {OUTCOMES.map((item) => (
                  <label
                    key={item.value}
                    className={`cursor-pointer rounded-lg border p-3 transition ${
                      supplierOutcome === item.value
                        ? 'border-brand-orange bg-red-50'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="supplier-outcome"
                        value={item.value}
                        checked={supplierOutcome === item.value}
                        onChange={() => {
                          setSupplierOutcome(item.value);
                          setMode('automatic');
                          setIssueNowCaseConfirmed(false);
                          setAutomaticErrorCode(null);
                        }}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-sm font-bold text-navy-950">{item.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-neutral-600">{item.description}</span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {supplierOutcome === 'still_valid' && (
              <label className="grid gap-1 text-xs font-semibold text-neutral-700 sm:max-w-sm">
                New effective Super Admin deadline{deadlineRequired ? '' : ' (optional)'}
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                  className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                />
                <span className="font-normal text-neutral-500">
                  Supplier deadline history remains readable and cannot overwrite this deadline.
                </span>
              </label>
            )}

            {needsRefundDecision && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                  Captured-payment decision
                  <select
                    value={refundDisposition}
                    onChange={(event) => setRefundDisposition(event.target.value as SuperAdminRefundDisposition)}
                    className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                  >
                    <option value="full_refund">Full Refund</option>
                    <option value="partial_refund">Partial Refund</option>
                    <option value="no_refund_due">No Refund Due</option>
                    <option value="externally_settled">Externally Settled</option>
                  </select>
                </label>
                {refundDisposition === 'partial_refund' ? (
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    Refund amount ({currency})
                    <input
                      value={partialAmount}
                      onChange={(event) => setPartialAmount(event.target.value)}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                    />
                  </label>
                ) : refundDisposition === 'externally_settled' ? (
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    External settlement reference
                    <input
                      value={externalReference}
                      onChange={(event) => setExternalReference(event.target.value)}
                      maxLength={255}
                      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                    />
                  </label>
                ) : <div />}
              </div>
            )}

            {manualAvailable && supplierOutcome && mode === 'automatic' && (
              <button
                type="button"
                onClick={() => {
                  setMode('manual');
                  setError(null);
                  setPreview(null);
                }}
                className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-left text-xs font-semibold text-amber-950"
              >
                Local accounting cannot complete this outcome. Open audited supplier-verified manual resolution.
              </button>
            )}

            {mode === 'manual' && supplierOutcome && (
              <div className="space-y-4 rounded-xl border-2 border-amber-300 bg-amber-50/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-amber-950">Manual Supplier-Verified Resolution</p>
                    <p className="mt-1 text-xs leading-5 text-amber-900">
                      This creates a distinct immutable adjustment; it never fabricates a historical Hold.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMode('automatic')}
                    className="shrink-0 text-xs font-semibold text-amber-900 underline"
                  >
                    Back to automatic
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    Supplier transaction/reference (optional)
                    <input
                      value={supplierReference}
                      onChange={(event) => setSupplierReference(event.target.value)}
                      maxLength={255}
                      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                    />
                  </label>
                  <div className="grid grid-cols-[1fr_100px] gap-2">
                    <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                      Supplier amount (optional)
                      <input
                        value={supplierAmount}
                        onChange={(event) => setSupplierAmount(event.target.value)}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                      Currency
                      <input
                        value={supplierCurrency}
                        onChange={(event) => setSupplierCurrency(event.target.value.toUpperCase())}
                        maxLength={3}
                        className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm uppercase text-navy-950"
                      />
                    </label>
                  </div>
                </div>

                <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-950">
                  Supplier amount is a separate fact. It never fills or determines the customer-wallet amount.
                </p>

                <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs leading-5 text-amber-950">
                  <input
                    type="checkbox"
                    checked={issueNowCaseConfirmed}
                    onChange={(event) => setIssueNowCaseConfirmed(event.target.checked)}
                    className="mt-1 h-3.5 w-3.5 rounded border-amber-500"
                  />
                  I confirm this is the stuck B2B/B2C Issue Now case I manually verified in the supplier portal/history.
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    Customer-wallet action
                    <select
                      value={manualAction}
                      onChange={(event) => setManualAction(event.target.value as SuperAdminManualWalletAction)}
                      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                    >
                      {allowedManualActions.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    Customer-wallet amount ({currency})
                    <input
                      value={manualAction === 'none' ? '0.00' : customerAmount}
                      onChange={(event) => setCustomerAmount(event.target.value)}
                      disabled={manualAction === 'none'}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950 disabled:bg-neutral-100"
                    />
                  </label>
                </div>
                {manualAction !== 'none' && (
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    How was the customer-wallet amount verified?
                    <textarea
                      value={customerAmountBasis}
                      onChange={(event) => setCustomerAmountBasis(event.target.value)}
                      maxLength={1000}
                      rows={2}
                      placeholder="Record the customer amount basis; do not copy the supplier amount automatically."
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-navy-950"
                    />
                  </label>
                )}
              </div>
            )}

            <label className="grid gap-1 text-xs font-semibold text-neutral-700">
              Super Admin note (optional)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={1000}
                rows={2}
                placeholder="Optional supplier-check or operational note"
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-navy-950"
              />
            </label>

            {previewBusy && (
              <p className="flex items-center gap-2 text-xs text-neutral-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking current wallet truth…
              </p>
            )}

            {automaticPreview && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <CircleDollarSign className="h-4 w-4" aria-hidden /> Automatic local-accounting result
                </p>
                <p className="mt-1 text-xs leading-5">{automaticEffectText(automaticPreview)}</p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {balance('Available before', automaticPreview.availableBefore, currency)}
                  {balance('Available after', automaticPreview.availableAfter, currency)}
                  {balance('Hold before', automaticPreview.holdBefore, currency)}
                  {balance('Hold after', automaticPreview.holdAfter, currency)}
                </div>
              </div>
            )}

            {manualPreview && (
              <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-amber-950">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <CircleDollarSign className="h-4 w-4" aria-hidden /> Exact manual customer-wallet effect
                </p>
                <p className="mt-1 text-xs leading-5">
                  {title(manualPreview.customerWalletAction)} · Booking becomes {title(manualPreview.toStatus)}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {balance('Available before', manualPreview.availableBefore, currency)}
                  {balance('Available after', manualPreview.availableAfter, currency)}
                  {balance('Hold before', manualPreview.holdBefore, currency)}
                  {balance('Hold after', manualPreview.holdAfter, currency)}
                </div>
                <p className="mt-3 text-xs font-semibold">
                  Customer wallet: {formatWalletMoney(manualPreview.customerWalletAmount ?? 0, currency)}. Supplier amount remains separate.
                </p>
                {(manualPreview.protectedHold ?? 0) > 0 && (
                  <p className="mt-1 text-xs leading-5">
                    Hold protected for other active reservations: {formatWalletMoney(manualPreview.protectedHold ?? 0, currency)}. Maximum resolvable Hold for this case: {formatWalletMoney(manualPreview.resolvableHold ?? 0, currency)}.
                  </p>
                )}
              </div>
            )}

            {preview?.ok && (mode === 'manual' || automaticMoneyMoves) && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                <input
                  type="checkbox"
                  checked={effectConfirmed}
                  onChange={(event) => setEffectConfirmed(event.target.checked)}
                  className="mt-1 h-3.5 w-3.5 rounded border-amber-500"
                />
                {mode === 'manual'
                  ? 'I confirm the displayed Available and Hold balances and this exact before/after customer-wallet effect.'
                  : `I confirm this exact wallet movement: ${
                      automaticPreview
                        ? automaticEffectText(automaticPreview)
                        : 'Refresh the preview.'
                    }`}
              </label>
            )}

            <button
              type="button"
              disabled={applyBusy || previewBusy || !canApply}
              onClick={() => void applyResolution()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-brand-orange px-4 text-sm font-semibold text-navy-950 transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit"
            >
              {applyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              )}
              {mode === 'manual' ? 'Apply Audited Manual Resolution' : 'Apply Resolution'}
            </button>
          </>
        )}

        {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        {message && <p className="text-xs font-medium text-emerald-700">{message}</p>}
      </div>
    </section>
  );
}
