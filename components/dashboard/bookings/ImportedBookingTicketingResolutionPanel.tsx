'use client';

import { Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  ImportedTicketingResolutionAssessment,
  ImportedTicketingResolutionContext,
} from '@/lib/impexp/ticketing-resolution';

type Traveller = { firstName: string; lastName: string };
type Decision = 'confirm_ticketed' | 'cancel';
type RefundDisposition =
  | 'full_refund'
  | 'partial_refund'
  | 'no_refund_due'
  | 'externally_settled';

function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function money(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function ImportedBookingTicketingResolutionPanel({
  bookingReference,
  travellers,
  context,
}: {
  bookingReference: string;
  travellers: Traveller[];
  context: ImportedTicketingResolutionAssessment;
}) {
  if (!context.ok) return <BlockedResolution code={context.code} />;
  return (
    <ImportedBookingTicketingResolutionForm
      bookingReference={bookingReference}
      travellers={travellers}
      context={context}
    />
  );
}

function ImportedBookingTicketingResolutionForm({
  bookingReference,
  travellers,
  context,
}: {
  bookingReference: string;
  travellers: Traveller[];
  context: ImportedTicketingResolutionContext;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision>('confirm_ticketed');
  const [ticketNumbers, setTicketNumbers] = useState(() =>
    travellers.map(() => ''),
  );
  const [issuedAt, setIssuedAt] = useState('');
  const [cancellationAt, setCancellationAt] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [refundDisposition, setRefundDisposition] =
    useState<RefundDisposition>('full_refund');
  const [refundAmount, setRefundAmount] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [effectConfirmed, setEffectConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const effect = useMemo(() => {
    if (decision === 'confirm_ticketed') {
      return {
        label:
          context.accountingMode === 'active_hold'
            ? 'Capture existing Hold'
            : 'Already captured — no wallet movement',
        amount: context.confirmAmount,
        availableAfter: context.confirmAvailableAfter,
        holdAfter: context.confirmHoldAfter,
      };
    }
    if (context.accountingMode === 'active_hold') {
      return {
        label: 'Release existing Hold back to Available',
        amount: context.cancelAmount,
        availableAfter: context.cancelAvailableAfter ?? context.availableBefore,
        holdAfter: context.cancelHoldAfter,
      };
    }
    let amount = 0;
    if (refundDisposition === 'full_refund') amount = context.outstandingAmount;
    if (refundDisposition === 'partial_refund') {
      amount = Math.round((Number(refundAmount) || 0) * 100);
    }
    return {
      label:
        amount > 0
          ? refundDisposition === 'full_refund'
            ? 'Refund full outstanding capture'
            : 'Refund selected amount'
          : refundDisposition === 'externally_settled'
            ? 'Externally settled — no local wallet movement'
            : 'No refund — no local wallet movement',
      amount,
      availableAfter: context.availableBefore + amount,
      holdAfter: context.holdBefore,
    };
  }, [context, decision, refundAmount, refundDisposition]);

  async function submit() {
    if (busy || !effectConfirmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/impexp/bookings/${encodeURIComponent(bookingReference)}/ticketing-resolution`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            decision,
            moneyEffectConfirmed: true,
            ...(decision === 'confirm_ticketed'
              ? {
                  ticketing: {
                    ticketNumbers,
                    issuedAt: toIso(issuedAt) ?? '',
                  },
                }
              : {
                  cancellation: {
                    cancellationAt: toIso(cancellationAt) ?? '',
                    reason: cancellationReason,
                    ...(context.accountingMode === 'legacy_captured'
                      ? {
                          refundDisposition,
                          ...(refundDisposition === 'partial_refund'
                            ? { refundAmount: Number(refundAmount) }
                            : {}),
                          ...(refundDisposition === 'externally_settled'
                            ? {
                                externalSettlementReference: externalReference,
                              }
                            : {}),
                        }
                      : {}),
                  },
                }),
          }),
        },
      );
      const body = (await response.json()) as {
        success?: boolean;
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.errorMessage ?? 'Imported ticketing resolution failed.',
        );
      }
      setMessage(
        decision === 'confirm_ticketed'
          ? 'Ticket confirmed and wallet settlement completed.'
          : 'Booking cancelled and wallet settlement completed.',
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Imported ticketing resolution failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-violet-200 bg-violet-50 px-5 py-4">
        <span className="rounded-full bg-white p-2 text-violet-700 ring-1 ring-violet-200">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">
            Imported Booking Ticketing Resolution
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            {context.importSource === 'MANUAL' ? 'Manual Import' : 'IMP/EXP'} ·{' '}
            {context.accountingMode === 'active_hold'
              ? 'User Payable is protected in Hold.'
              : 'Legacy payment was captured before ticketing. It must never be charged again.'}
          </p>
        </div>
      </header>

      <div className="space-y-5 p-5">
        <div className="grid gap-3 sm:grid-cols-4">
          <Balance label="Available now" value={money(context.availableBefore, context.currency)} />
          <Balance label="Hold now" value={money(context.holdBefore, context.currency)} />
          <Balance label="User Payable" value={money(context.userPayableAmount, context.currency)} />
          <Balance
            label="Accounting"
            value={context.accountingMode === 'active_hold' ? 'Active Hold' : 'Legacy Captured'}
          />
        </div>

        <label className="block max-w-sm">
          <span className="mb-1 block text-sm font-semibold text-navy-950">
            Verified outcome
          </span>
          <Select
            value={decision}
            onValueChange={(value) => {
              setDecision(value as Decision);
              setEffectConfirmed(false);
            }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="confirm_ticketed">Ticket issued — Confirm</SelectItem>
              <SelectItem value="cancel">Ticket not issued — Cancel</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {decision === 'confirm_ticketed' ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="mb-3 text-sm text-amber-950">
              Enter one ticket number for every passenger and the actual Issued Date & Time.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {travellers.map((traveller, index) => (
                <label key={index}>
                  <span className="mb-1 block text-xs font-semibold">
                    Ticket number — {traveller.firstName} {traveller.lastName}
                  </span>
                  <Input
                    value={ticketNumbers[index] ?? ''}
                    onChange={(event) =>
                      setTicketNumbers((current) =>
                        current.map((number, itemIndex) =>
                          itemIndex === index ? event.target.value : number,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Issued Date & Time
                </span>
                <Input
                  type="datetime-local"
                  value={issuedAt}
                  onChange={(event) => setIssuedAt(event.target.value)}
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Cancellation Date & Time
                </span>
                <Input
                  type="datetime-local"
                  value={cancellationAt}
                  onChange={(event) => setCancellationAt(event.target.value)}
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Cancellation reason
                </span>
                <Input
                  value={cancellationReason}
                  onChange={(event) => setCancellationReason(event.target.value)}
                />
              </label>
            </div>
            {context.accountingMode === 'legacy_captured' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1 block text-xs font-semibold">
                    Captured-payment disposition
                  </span>
                  <Select
                    value={refundDisposition}
                    onValueChange={(value) => {
                      setRefundDisposition(value as RefundDisposition);
                      setEffectConfirmed(false);
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full_refund">Full Refund</SelectItem>
                      <SelectItem value="partial_refund">Partial Refund</SelectItem>
                      <SelectItem value="no_refund_due">No Refund</SelectItem>
                      <SelectItem value="externally_settled">Externally Settled</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {refundDisposition === 'partial_refund' && (
                  <label>
                    <span className="mb-1 block text-xs font-semibold">
                      Partial refund ({context.currency})
                    </span>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={refundAmount}
                      onChange={(event) => {
                        setRefundAmount(event.target.value);
                        setEffectConfirmed(false);
                      }}
                    />
                  </label>
                )}
                {refundDisposition === 'externally_settled' && (
                  <label>
                    <span className="mb-1 block text-xs font-semibold">
                      External settlement reference
                    </span>
                    <Input
                      value={externalReference}
                      onChange={(event) => setExternalReference(event.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 font-semibold text-emerald-950">
            <Wallet className="h-4 w-4" aria-hidden />
            Exact customer-wallet effect
          </div>
          <p className="mt-1 text-sm text-emerald-900">{effect.label}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Balance label="Available before" value={money(context.availableBefore, context.currency)} />
            <Balance label="Available after" value={money(effect.availableAfter, context.currency)} />
            <Balance label="Hold before" value={money(context.holdBefore, context.currency)} />
            <Balance label="Hold after" value={money(effect.holdAfter, context.currency)} />
          </div>
          {effect.amount > 0 && (
            <p className="mt-3 text-sm font-semibold text-emerald-950">
              Movement: {money(effect.amount, context.currency)}
            </p>
          )}
        </div>

        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={effectConfirmed}
            onChange={(event) => setEffectConfirmed(event.target.checked)}
            className="mt-1"
          />
          I confirm the verified supplier outcome and the exact Available/Hold effect shown above.
        </label>
        {message && (
          <p role="status" className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
            {message}
          </p>
        )}
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !effectConfirmed}
          className={decision === 'cancel' ? 'bg-brand-orange text-navy-950' : undefined}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {decision === 'confirm_ticketed' ? 'Confirm Ticketed' : 'Cancel and Settle Wallet'}
        </Button>
      </div>
    </section>
  );
}

const BLOCKED_MESSAGE: Record<string, string> = {
  IMPORTED_OPERATION_NOT_FOUND:
    'The imported ticketing operation record is incomplete.',
  IMPORTED_CASE_NOT_FOUND:
    'The imported ticketing audit case is incomplete.',
  IMPORTED_RESERVATION_NOT_FOUND:
    'No local wallet reservation was found. No wallet movement is allowed here.',
  IMPORTED_MULTIPLE_RESERVATIONS:
    'More than one wallet reservation matches this booking.',
  IMPORTED_RESERVATION_ACCOUNT_CONFLICT:
    'The reservation, wallet owner, amount, or currency does not agree.',
  IMPORTED_ACTIVE_HOLD_CONFLICT:
    'The reservation and actual Hold balance do not agree.',
  IMPORTED_LEGACY_CAPTURE_CONFLICT:
    'The legacy capture, reservation, and ledger do not agree.',
  IMPORTED_RESERVATION_STATE_CONFLICT:
    'The reservation is neither an active Hold nor a proven legacy capture.',
};

function BlockedResolution({ code }: { code: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-amber-300 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-amber-300 bg-amber-50 px-5 py-4">
        <span className="rounded-full bg-white p-2 text-amber-700 ring-1 ring-amber-300">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">
            Imported Booking Ticketing Resolution Blocked
          </h2>
          <p className="mt-1 text-sm text-amber-950">
            {BLOCKED_MESSAGE[code] ??
              'This booking is not safely resolvable through the imported ticketing workflow.'}
          </p>
          <p className="mt-2 text-xs text-amber-800">
            Reason: {code}. No booking or wallet change was made.
          </p>
        </div>
      </header>
    </section>
  );
}

function Balance({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-bold text-navy-950">{value}</p>
    </div>
  );
}
