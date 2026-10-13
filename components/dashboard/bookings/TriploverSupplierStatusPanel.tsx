'use client';

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { formatWalletMoney } from '@/lib/wallet/money';

type StatusCheck = {
  checkId: string;
  checkedAt: string;
  expiresAt: string;
  verified: boolean;
  verifiedStatus: 'issued' | 'held' | 'cancelled' | 'unknown';
  supplierStatus: string | null;
  pnr: string | null;
  airlinePnrs: string[];
  tickets: Array<{ passengerIndex: number; ticketNumbers: string[] }>;
  reason: string | null;
  source: string;
  localStatus: string;
  paymentState: string;
};

type ConfirmationPreview = {
  ok: boolean;
  eligible: boolean;
  code?: string;
  checkId: string;
  previewHash: string;
  walletEffect: 'capture_hold';
  amount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  holdBefore: number;
  holdAfter: number;
};

type ConfirmationIntent = {
  action: 'confirm';
  bookingReference: string;
  checkId: string;
  previewHash: string;
  requestId: string;
  confirmed: true;
};

type Envelope = {
  success?: boolean;
  data?: { check?: StatusCheck; preview?: ConfirmationPreview; result?: {
    ok?: boolean; replay?: boolean; bookingReference?: string; bookingStatus?: string;
    paymentState?: string; walletEffect?: string; amount?: number; currency?: string;
  } };
  error?: string | { errorCode?: string; errorMessage?: string };
};

class RequestError extends Error {
  constructor(message: string, readonly ambiguous = false) { super(message); }
}

async function post(path: string, body: unknown): Promise<Envelope> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new RequestError('The response could not be received.', true);
  }
  let envelope: Envelope;
  try {
    envelope = await response.json() as Envelope;
  } catch {
    throw new RequestError('The response could not be verified.', true);
  }
  if (!envelope || typeof envelope !== 'object') throw new RequestError('The response could not be verified.', true);
  if (!response.ok || envelope.success !== true) {
    const message = typeof envelope.error === 'string' ? envelope.error : envelope.error?.errorMessage;
    const code = typeof envelope.error === 'object' ? envelope.error?.errorCode : null;
    throw new RequestError(message || 'This action could not be completed.', response.status >= 500 || response.status < 400 ||
      code === 'ISSUE_OUTCOME_UNKNOWN' || code === 'CONFIRMATION_OUTCOME_UNKNOWN');
  }
  return envelope;
}

function label(value: string): string {
  return value.replace(/[_-]/g, ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
}

function dhakaTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Unavailable';
}

function validCheck(value: StatusCheck | undefined): value is StatusCheck {
  return Boolean(value && typeof value.checkId === 'string' && value.checkId &&
    Number.isFinite(Date.parse(value.checkedAt)) && Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.verified === 'boolean' && ['issued', 'held', 'cancelled', 'unknown'].includes(value.verifiedStatus) &&
    typeof value.localStatus === 'string' && typeof value.paymentState === 'string' &&
    (value.supplierStatus === null || typeof value.supplierStatus === 'string') &&
    (value.pnr === null || typeof value.pnr === 'string') && (value.reason === null || typeof value.reason === 'string') &&
    Array.isArray(value.airlinePnrs) && value.airlinePnrs.every(pnr => typeof pnr === 'string') &&
    Array.isArray(value.tickets) && value.tickets.every(ticket => Number.isSafeInteger(ticket.passengerIndex) &&
      ticket.passengerIndex >= 0 && Array.isArray(ticket.ticketNumbers) && ticket.ticketNumbers.every(number => typeof number === 'string')));
}

function validPreview(value: ConfirmationPreview, checkId: string): boolean {
  return value.ok === true && value.eligible === true && value.checkId === checkId &&
    typeof value.previewHash === 'string' && value.previewHash.length > 0 && value.walletEffect === 'capture_hold' &&
    typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) &&
    [value.amount, value.availableBefore, value.availableAfter, value.holdBefore, value.holdAfter]
      .every(amount => Number.isSafeInteger(amount) && amount >= 0) && value.amount > 0 &&
    value.availableBefore === value.availableAfter && value.holdBefore - value.holdAfter === value.amount;
}

export default function TriploverSupplierStatusPanel({
  bookingReference, localStatus, paymentState, passengers,
}: {
  bookingReference: string;
  localStatus: string;
  paymentState: string;
  passengers: Array<{ firstName: string; lastName: string }>;
}) {
  const router = useRouter();
  const [check, setCheck] = useState<StatusCheck | null>(null);
  const [preview, setPreview] = useState<ConfirmationPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'preview' | 'confirm' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const intent = useRef<ConfirmationIntent | null>(null);
  const expectedConfirmation = useRef<{ amount: number; currency: string } | null>(null);
  const mounted = useRef(true);
  const activeBooking = useRef(bookingReference);
  activeBooking.current = bookingReference;
  const identity = `${bookingReference}|${localStatus}|${paymentState}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setPreview(null);
    setConsent(false);
    setError(null);
    setMessage(null);
    if (intent.current?.bookingReference === bookingReference) return;
    intent.current = null;
    expectedConfirmation.current = null;
    setCheck(null);
    setUncertain(false);
    setBusy(null);
    inFlight.current = false;
  }, [bookingReference, localStatus, paymentState]);

  useEffect(() => {
    if (!check) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [check]);

  const expired = Boolean(check && now >= Date.parse(check.expiresAt));
  useEffect(() => {
    if (!expired || intent.current) return;
    setPreview(null);
    setConsent(false);
  }, [expired]);

  async function refreshStatus() {
    if (inFlight.current || intent.current) return;
    inFlight.current = true;
    const requestedIdentity = identity;
    setBusy('refresh'); setError(null); setMessage(null); setCheck(null); setPreview(null); setConsent(false);
    try {
      const body = await post('/api/flights/booking/refresh-status', { bookingReference });
      if (!mounted.current || activeIdentity.current !== requestedIdentity) return;
      const receivedCheck = body.data?.check;
      if (!validCheck(receivedCheck)) throw new RequestError('Supplier status could not be verified. Refresh again.');
      setCheck(receivedCheck);
      setNow(Date.now());
    } catch (caught) {
      if (mounted.current && activeIdentity.current === requestedIdentity) setError(caught instanceof Error ? caught.message : 'Supplier status is unavailable.');
    } finally {
      inFlight.current = false;
      if (mounted.current && activeIdentity.current === requestedIdentity) setBusy(null);
    }
  }

  async function reviewConfirmation() {
    if (inFlight.current || intent.current || !check || expired || !check.verified || check.verifiedStatus !== 'issued' ||
      localStatus.toLowerCase() === 'confirmed' || check.localStatus.toLowerCase() === 'confirmed') return;
    inFlight.current = true;
    const requestedIdentity = identity;
    const checkId = check.checkId;
    setBusy('preview'); setError(null); setMessage(null); setPreview(null); setConsent(false);
    try {
      const body = await post('/api/flights/booking/confirm-supplier-ticket', { action: 'preview', bookingReference, checkId });
      if (!mounted.current || activeIdentity.current !== requestedIdentity) return;
      const result = body.data?.preview;
      if (!result || !validPreview(result, checkId)) {
        throw new RequestError(result?.code ? `Confirmation needs review: ${label(result.code)}.` : 'This booking has no eligible existing wallet hold to confirm.');
      }
      if (Date.now() >= Date.parse(check.expiresAt)) throw new RequestError('This supplier check expired. Refresh Status again.');
      setPreview(result);
    } catch (caught) {
      if (mounted.current && activeIdentity.current === requestedIdentity) setError(caught instanceof Error ? caught.message : 'Confirmation preview is unavailable.');
    } finally {
      inFlight.current = false;
      if (mounted.current && activeIdentity.current === requestedIdentity) setBusy(null);
    }
  }

  async function confirmTicket() {
    if (inFlight.current) return;
    const existing = intent.current;
    if (!existing && (!check || !preview || !consent || expired)) return;
    const request: ConfirmationIntent = existing ?? {
      action: 'confirm', bookingReference, checkId: check!.checkId, previewHash: preview!.previewHash,
      requestId: crypto.randomUUID(), confirmed: true,
    };
    if (!existing) expectedConfirmation.current = { amount: preview!.amount, currency: preview!.currency };
    intent.current = request;
    inFlight.current = true;
    const requestedBooking = bookingReference;
    setBusy('confirm'); setError(null); setMessage(null);
    try {
      const body = await post('/api/flights/booking/confirm-supplier-ticket', request);
      if (!mounted.current || activeBooking.current !== requestedBooking) return;
      const result = body.data?.result;
      const expected = expectedConfirmation.current;
      if (!result || result.ok !== true || result.bookingReference !== requestedBooking ||
          result.bookingStatus !== 'confirmed' || result.paymentState !== 'captured' ||
          result.walletEffect !== 'capture_hold' || !expected || result.amount !== expected.amount ||
          result.currency !== expected.currency || (result.replay !== undefined && typeof result.replay !== 'boolean')) {
        throw new RequestError('The confirmation response could not be verified.', true);
      }
      intent.current = null;
      expectedConfirmation.current = null;
      setUncertain(false); setPreview(null); setConsent(false); setCheck(null);
      setMessage('Ticket confirmed. The existing wallet hold was captured.');
      router.refresh();
    } catch (caught) {
      if (!mounted.current || activeBooking.current !== requestedBooking) return;
      const ambiguous = !(caught instanceof RequestError) || caught.ambiguous;
      if (ambiguous) {
        setUncertain(true);
        setError('The confirmation outcome could not be received. Retry this same confirmation to retrieve its saved result.');
      } else {
        intent.current = null;
        expectedConfirmation.current = null;
        setUncertain(false); setPreview(null); setConsent(false);
        setError(caught.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && activeBooking.current === requestedBooking) setBusy(null);
    }
  }

  const reviewAvailable = check?.verified && check.verifiedStatus === 'issued' &&
    localStatus.toLowerCase() !== 'confirmed' &&
    (check.localStatus || localStatus).toLowerCase() !== 'confirmed';
  const buttonClass = 'flex w-full items-center justify-center gap-2 rounded-lg border border-brand-orange/30 bg-brand-orange-light px-3 py-2.5 text-xs font-bold text-navy-950 transition hover:bg-brand-orange/20 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 bg-navy-50 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-navy-950"><ShieldCheck className="h-4 w-4 text-brand-orange" aria-hidden /> Supplier status</h2>
        <p className="mt-1 text-[11px] leading-5 text-neutral-600">Check the airline’s current status before reviewing confirmation.</p>
      </div>
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-neutral-50 p-3 text-xs">
          <div><p className="text-[10px] text-neutral-500">Saved booking</p><p className="mt-1 font-semibold text-navy-950">{label(check?.localStatus || localStatus)}</p></div>
          <div><p className="text-[10px] text-neutral-500">Saved payment</p><p className="mt-1 font-semibold text-navy-950">{label(check?.paymentState || paymentState)}</p></div>
        </div>
        <button type="button" onClick={() => void refreshStatus()} disabled={Boolean(busy) || uncertain} className={buttonClass}>
          {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden /> : <RefreshCw className="h-4 w-4 text-brand-orange" aria-hidden />}
          {busy === 'refresh' ? 'Checking…' : 'Refresh Status'}
        </button>
        <div aria-live="polite" className="space-y-3">
          {check && (
            <div className={`space-y-2 rounded-lg border p-3 text-xs ${check.verified ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-amber-200 bg-amber-50 text-amber-950'}`}>
              <p className="flex items-center gap-1.5 font-bold">{check.verified ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />}{check.verified ? 'Verified supplier status' : 'Supplier status needs review'}</p>
              <p className="font-semibold">{check.supplierStatus || label(check.verifiedStatus)}</p>
              <p className="text-[11px]">Checked {dhakaTime(check.checkedAt)} · Dhaka</p>
              {check.pnr && <p>Booking PNR: <span className="font-semibold">{check.pnr}</span></p>}
              {check.airlinePnrs.length > 0 && <p>Airline PNR: <span className="font-semibold">{check.airlinePnrs.join(', ')}</span></p>}
              {check.tickets.length > 0 && <div className="space-y-2 border-t border-current/15 pt-2">{check.tickets.map(ticket => (
                <div key={ticket.passengerIndex}><p className="font-semibold">{[passengers[ticket.passengerIndex]?.firstName, passengers[ticket.passengerIndex]?.lastName].filter(Boolean).join(' ') || `Passenger ${ticket.passengerIndex + 1}`}</p><p className="break-all">{ticket.ticketNumbers.join(', ') || 'Ticket identifier unavailable'}</p></div>
              ))}</div>}
              {(check.verifiedStatus === 'unknown' || !check.verified) && <p className="leading-5">Supplier evidence needs staff review before confirmation. {check.reason ? `${label(check.reason)}.` : ''}</p>}
              {check.verifiedStatus === 'cancelled' && <p className="leading-5">Supplier cancellation needs booking and wallet review before a financial action.</p>}
              {check.verified && check.verifiedStatus === 'held' && <p className="leading-5">The supplier reports this booking as held. Review the saved booking before using Issue Now.</p>}
              {expired && <p className="font-semibold">This check expired. Refresh Status for a current check.</p>}
            </div>
          )}
          {reviewAvailable && !uncertain && <button type="button" onClick={() => void reviewConfirmation()} disabled={Boolean(busy) || expired} className={buttonClass}>{busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden /> : <Wallet className="h-4 w-4 text-brand-orange" aria-hidden />} Review confirmation</button>}
          {preview && !uncertain && (
            <div className="space-y-3 rounded-lg border border-brand-orange/30 bg-brand-orange-light p-3 text-xs text-navy-950">
              <p className="font-bold">Capture existing hold: {formatWalletMoney(preview.amount, preview.currency)}</p>
              <p className="leading-5">Confirm this issued ticket using the booking’s existing wallet hold.</p>
              <dl className="space-y-2"><div className="flex flex-wrap justify-between gap-1"><dt>Available</dt><dd className="font-semibold">{formatWalletMoney(preview.availableBefore, preview.currency)} → {formatWalletMoney(preview.availableAfter, preview.currency)}</dd></div><div className="flex flex-wrap justify-between gap-1"><dt>Hold</dt><dd className="font-semibold">{formatWalletMoney(preview.holdBefore, preview.currency)} → {formatWalletMoney(preview.holdAfter, preview.currency)}</dd></div></dl>
              <label className="flex items-start gap-2 leading-5"><input type="checkbox" checked={consent} disabled={Boolean(busy) || expired} onChange={event => setConsent(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 rounded border-neutral-300 accent-brand-orange" />I confirm this exact amount and wallet balance change.</label>
              <button type="button" onClick={() => void confirmTicket()} disabled={Boolean(busy) || !consent || expired} className={buttonClass}>{busy === 'confirm' && <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />} Confirm issued ticket</button>
            </div>
          )}
          {uncertain && <button type="button" onClick={() => void confirmTicket()} disabled={Boolean(busy)} className={buttonClass}>{busy === 'confirm' && <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />} Retry same confirmation</button>}
          {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">{error}</p>}
          {message && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-950">{message}</p>}
        </div>
      </div>
    </section>
  );
}
