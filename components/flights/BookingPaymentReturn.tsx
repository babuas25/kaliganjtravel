'use client';

import { ArrowDownLeft, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { useStatusFeedback } from '@/components/feedback/StatusFeedback';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export type BookingPaymentReturnContext = {
  canReturn: boolean;
  capturedAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  captureLedgerEntryId?: string;
  holdBalance?: number;
};

type FreshPaymentReturnContext = BookingPaymentReturnContext & {
  captureLedgerEntryId: string;
  holdBalance: number;
};

type ReturnIntent = {
  requestId: string;
  captureLedgerEntryId: string;
  expectedCapturedAmount: number;
  expectedRefundedAmount: number;
  expectedRefundableAmount: number;
  expectedAvailableBalance: number;
  expectedHoldBalance: number;
  reason: string;
  confirmation: true;
};

type ReturnAttempt = { bookingReference: string; currency: string; intent: ReturnIntent };
type ApiBody = {
  success?: boolean;
  data?: unknown;
  error?: { errorCode?: string; errorMessage?: string };
};

const DEFINITE_REJECTIONS = new Set([
  'SIGN_IN_REQUIRED', 'PAYMENT_RETURN_FORBIDDEN', 'BOOKING_NOT_FOUND',
  'INVALID_PAYMENT_RETURN_REQUEST', 'PAYMENT_RETURN_NOT_AVAILABLE',
  'PAYMENT_RETURN_STATE_CHANGED', 'PAYMENT_RETURN_REVIEW_REQUIRED', 'RATE_LIMITED',
]);

function cents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.00001 ? result : null;
}

function contextFrom(value: unknown): BookingPaymentReturnContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as BookingPaymentReturnContext;
  const amounts = [data.capturedAmount, data.refundedAmount, data.refundableAmount,
    data.availableBefore, data.availableAfter].map(cents);
  if (typeof data.canReturn !== 'boolean' || !/^[A-Z]{3}$/.test(data.currency) ||
      amounts.some(amount => amount === null)) return null;
  const [captured, refunded, refundable, before, after] = amounts as number[];
  if (captured! < refunded! || captured! - refunded! !== refundable! ||
      before! + refundable! !== after! || (data.canReturn && refundable! <= 0)) return null;
  return data;
}

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function validReason(value: string): boolean {
  return value.trim().length >= 3 && value.trim().length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}

export default function BookingPaymentReturn({ bookingReference, initialContext }: {
  bookingReference: string;
  initialContext: BookingPaymentReturnContext | null;
}) {
  const router = useRouter();
  const showFeedback = useStatusFeedback();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ bookingReference: string; context: FreshPaymentReturnContext } | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [completedReference, setCompletedReference] = useState<string | null>(null);
  const attempt = useRef<ReturnAttempt | null>(null);
  const submitting = useRef(false);
  const previewRequest = useRef(0);
  const currentReference = useRef(bookingReference);
  currentReference.current = bookingReference;
  const context = preview?.bookingReference === bookingReference ? preview.context : null;
  const initial = contextFrom(initialContext);
  const endpoint = `/api/admin/bookings/${encodeURIComponent(bookingReference)}/payment-return`;

  async function refreshPreview() {
    const reference = bookingReference;
    const request = ++previewRequest.current;
    setLoading(true);
    setPreview(null);
    try {
      const response = await fetch(endpoint, { method: 'GET', cache: 'no-store' });
      const body = await response.json() as ApiBody;
      const fresh = contextFrom(body.data);
      if (!response.ok || body.success !== true || !fresh || cents(fresh.holdBalance) === null ||
          typeof fresh.captureLedgerEntryId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fresh.captureLedgerEntryId)) {
        throw new Error(body.error?.errorMessage || 'The payment return could not be checked. Try again.');
      }
      if (currentReference.current === reference && previewRequest.current === request) {
        setPreview({ bookingReference: reference, context: fresh as FreshPaymentReturnContext });
      }
    } catch (caught) {
      if (currentReference.current === reference && previewRequest.current === request) {
        setError(caught instanceof Error ? caught.message : 'The payment return could not be checked.');
      }
    } finally {
      if (currentReference.current === reference && previewRequest.current === request) setLoading(false);
    }
  }

  function openDialog() {
    if (submitting.current) return;
    setOpen(true);
    if (attempt.current?.bookingReference === bookingReference) return;
    attempt.current = null;
    setUncertain(false);
    setReason('');
    setError(null);
    void refreshPreview();
  }

  async function returnPayment() {
    if (submitting.current || loading || currentReference.current !== bookingReference) return;
    const previous = attempt.current;
    if (previous && previous.bookingReference !== bookingReference) return;
    if (!previous && (!context?.canReturn || !validReason(reason))) return;
    const retained: ReturnAttempt = previous ?? { bookingReference, currency: context!.currency, intent: {
      requestId: crypto.randomUUID(), captureLedgerEntryId: context!.captureLedgerEntryId,
      expectedCapturedAmount: context!.capturedAmount,
      expectedRefundedAmount: context!.refundedAmount, expectedRefundableAmount: context!.refundableAmount,
      expectedAvailableBalance: context!.availableBefore, expectedHoldBalance: context!.holdBalance,
      reason: reason.trim(), confirmation: true,
    } };
    attempt.current = retained;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let definiteRejection = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 70_000);
    try {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(retained.intent),
        signal: controller.signal });
      const body = await response.json() as ApiBody;
      if (currentReference.current !== retained.bookingReference) return;
      const data = body.data as { returned?: boolean; currency?: string; amount?: number } | undefined;
      if (!response.ok || body.success !== true || data?.returned !== true || data.currency !== retained.currency ||
          (data.amount !== undefined && cents(data.amount) !== cents(retained.intent.expectedRefundableAmount))) {
        definiteRejection = response.status >= 400 && response.status < 500 &&
          DEFINITE_REJECTIONS.has(body.error?.errorCode ?? '');
        throw new Error(body.error?.errorMessage || 'The payment return result could not be verified.');
      }
      attempt.current = null;
      setUncertain(false);
      setOpen(false);
      setCompletedReference(retained.bookingReference);
      showFeedback({ title: 'Booking payment returned',
        description: `${money(retained.intent.expectedRefundableAmount, retained.currency)} returned to the booking owner’s wallet.`,
        reference: retained.bookingReference });
      router.refresh();
    } catch (caught) {
      if (currentReference.current !== retained.bookingReference) return;
      const message = caught instanceof Error ? caught.message : 'The payment return result could not be read.';
      if (definiteRejection) {
        attempt.current = null;
        setUncertain(false);
        setError(message);
        await refreshPreview();
      } else {
        setUncertain(true);
        setError(`The result is not yet verified. Retry this same payment return to check it safely. ${message}`);
      }
    } finally {
      window.clearTimeout(timeout);
      submitting.current = false;
      if (currentReference.current === retained.bookingReference) setBusy(false);
    }
  }

  const pendingHere = attempt.current?.bookingReference === bookingReference;
  if ((!initial?.canReturn && !pendingHere) || completedReference === bookingReference) return null;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
      <AlertDialog open={open} onOpenChange={next => {
        if (!next && (busy || uncertain)) return;
        setOpen(next);
      }}>
        <AlertDialogTrigger asChild>
          <button type="button" onClick={openDialog} disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-neutral-50 disabled:opacity-60">
            <ArrowDownLeft className="h-4 w-4 text-brand-orange" aria-hidden />
            Return Booking Payment
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Return booking payment?</AlertDialogTitle>
            <AlertDialogDescription>
              Return this booking’s remaining payment to the booking owner’s wallet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all text-sm font-semibold text-navy-950">{bookingReference}</p>
          {loading ? <p role="status" className="flex items-center gap-2 text-sm text-neutral-600">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />Checking payment…
          </p> : context ? <>
            <dl className="space-y-2 rounded-lg bg-neutral-50 p-3 text-sm">
              {[
                ['Paid', context.capturedAmount], ['Already returned', context.refundedAmount],
                ['Return amount', context.refundableAmount], ['Owner wallet before', context.availableBefore],
                ['Owner wallet after', context.availableAfter],
              ].map(([label, amount]) => <div key={label} className="flex justify-between gap-3">
                <dt className="text-neutral-600">{label}</dt>
                <dd className="text-right font-semibold tabular-nums text-navy-950">{money(Number(amount), context.currency)}</dd>
              </div>)}
            </dl>
            {context.canReturn ? <label className="grid gap-1.5 text-sm font-semibold text-navy-950">
              Reason
              <input type="text" value={reason} onChange={event => setReason(event.target.value)}
                disabled={busy || uncertain} required minLength={3} maxLength={500}
                placeholder="Why is this payment being returned?"
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal outline-hidden focus:border-brand-orange disabled:bg-neutral-50" />
            </label> : <p role="status" className="text-sm text-neutral-600">This booking has no payment available to return.</p>}
          </> : null}
          {error && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy || uncertain}>Not Now</AlertDialogCancel>
            {!context && !loading && !uncertain ? <button type="button" onClick={() => { setError(null); void refreshPreview(); }}
              className="rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-white">Check Again</button> :
              <AlertDialogAction disabled={busy || loading || (!uncertain && (!context?.canReturn || !validReason(reason)))}
                onClick={event => { event.preventDefault(); void returnPayment(); }}
                className="bg-brand-orange text-white hover:bg-brand-orange-dark">
                {busy ? 'Returning…' : uncertain ? 'Retry Same Payment Return' : 'Return Payment'}
              </AlertDialogAction>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
