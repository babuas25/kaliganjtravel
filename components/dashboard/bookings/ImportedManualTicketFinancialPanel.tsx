'use client';

import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type FinancialDisposition =
  | 'full_refund'
  | 'partial_refund'
  | 'no_refund_due'
  | 'externally_settled'
  | 'manual_adjustment_required';

type FinancialContext = {
  caseId: string;
  state: string;
  version: number;
  reasonCode: string;
  reasonDetail: string | null;
  assignedTeam: string | null;
  severity: string;
  dueAt: string | null;
  evidenceLatestAt: string | null;
  evidenceIsFresh: boolean;
  proposedByUserId: string | null;
  proposedAt: string | null;
  proposalHash: string | null;
  supplierOutcome: 'cancelled' | 'expired' | 'unconfirmed' | null;
  financialDisposition: 'none' | FinancialDisposition;
  financialAmount: number | null;
  financialCurrency: string | null;
  externalSettlementReference: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  resolutionOutcome: string | null;
  resolvedAt: string | null;
};

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
  }).format(amount / 100);
}

export default function ImportedManualTicketFinancialPanel({
  bookingReference,
  context,
  capturedAmount,
  refundedAmount,
  currency,
  canPropose,
  canApprove,
  canExecute,
  isProposalMaker,
}: {
  bookingReference: string;
  context: FinancialContext;
  capturedAmount: number;
  refundedAmount: number;
  currency: string;
  canPropose: boolean;
  canApprove: boolean;
  canExecute: boolean;
  isProposalMaker: boolean;
}) {
  const router = useRouter();
  const [disposition, setDisposition] =
    useState<FinancialDisposition>('full_refund');
  const [partialAmount, setPartialAmount] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [reason, setReason] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const outstanding = Math.max(0, capturedAmount - refundedAmount);
  const hasProposal =
    context.financialDisposition !== 'none' &&
    Boolean(context.proposalHash) &&
    !context.rejectedAt;
  const resolved = context.state === 'resolved' || Boolean(context.resolvedAt);

  async function act(
    action: 'propose' | 'approve' | 'reject' | 'execute'
  ) {
    const retryIdentity = requestId ?? crypto.randomUUID();
    if (action === 'propose' || action === 'execute') {
      setRequestId(retryIdentity);
    }
    setBusy(action);
    setMessage(null);
    try {
      const financialAmount =
        disposition === 'partial_refund'
          ? Math.round(Number(partialAmount) * 100)
          : null;
      const response = await fetch('/api/impexp/financial-disposition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'propose'
            ? {
                action,
                bookingReference,
                caseId: context.caseId,
                expectedCaseVersion: context.version,
                requestId: retryIdentity,
                financialDisposition: disposition,
                financialAmount,
                financialCurrency:
                  disposition === 'partial_refund' ? currency : null,
                externalSettlementReference:
                  disposition === 'externally_settled'
                    ? externalReference.trim()
                    : null,
                reason: reason.trim(),
                confirmed,
              }
            : action === 'reject'
              ? {
                  action,
                  bookingReference,
                  caseId: context.caseId,
                  expectedCaseVersion: context.version,
                  proposalHash: context.proposalHash,
                  rejectionReason: rejectionReason.trim(),
                }
              : {
                  action,
                  bookingReference,
                  caseId: context.caseId,
                  expectedCaseVersion: context.version,
                  proposalHash: context.proposalHash,
                  ...(action === 'execute' ? { requestId: retryIdentity } : {}),
                }
        ),
      });
      const body = (await response.json()) as {
        success?: boolean;
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.errorMessage ?? 'The financial action was not accepted.'
        );
      }
      setRequestId(null);
      setMessage(
        action === 'propose'
          ? 'Financial disposition proposed. A different Admin or Super Admin must approve it.'
          : action === 'approve'
            ? 'Proposal approved. It is ready for explicit execution.'
            : action === 'reject'
              ? 'Proposal rejected without changing booking or wallet truth.'
              : 'Approved disposition executed atomically.'
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The financial action failed.'
      );
    } finally {
      setBusy(null);
    }
  }

  const proposalReady =
    canPropose &&
    context.evidenceIsFresh &&
    Boolean(context.supplierOutcome) &&
    reason.trim().length > 0 &&
    confirmed &&
    (disposition !== 'partial_refund' ||
      (Number(partialAmount) > 0 && Number(partialAmount) * 100 < outstanding)) &&
    (disposition !== 'externally_settled' || externalReference.trim().length > 0);

  return (
    <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 sm:px-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-navy-950">
          <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden />
          Captured manual-ticket financial disposition
        </h2>
        <p className="mt-1 text-xs leading-5 text-amber-900">
          Supplier outcome: {humanize(context.supplierOutcome ?? 'not verified')}.
          Captured funds cannot be hidden or closed without an explicit,
          independently approved disposition.
        </p>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-md bg-navy-50 p-3">
            <dt className="text-neutral-500">Captured</dt>
            <dd className="mt-1 font-bold text-navy-950">
              {money(capturedAmount, currency)}
            </dd>
          </div>
          <div className="rounded-md bg-navy-50 p-3">
            <dt className="text-neutral-500">Outstanding</dt>
            <dd className="mt-1 font-bold text-navy-950">
              {money(outstanding, currency)}
            </dd>
          </div>
          <div className="rounded-md bg-navy-50 p-3">
            <dt className="text-neutral-500">Case state</dt>
            <dd className="mt-1 font-bold text-navy-950">
              {humanize(context.state)} · v{context.version}
            </dd>
          </div>
        </dl>

        {!resolved && !hasProposal && (
          <>
            {!context.evidenceIsFresh && (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                Supplier evidence is older than five minutes. Support must Sync
                again before Accounts can bind a proposal to current truth.
              </p>
            )}
            {canPropose && (
              <div className="grid gap-3">
                <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                  Disposition
                  <select
                    value={disposition}
                    onChange={(event) =>
                      setDisposition(event.target.value as FinancialDisposition)
                    }
                    disabled={Boolean(busy)}
                    className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-navy-950"
                  >
                    <option value="full_refund">Full wallet refund</option>
                    <option value="partial_refund">Partial wallet refund / retained fee</option>
                    <option value="no_refund_due">No refund due</option>
                    <option value="externally_settled">Settled outside wallet</option>
                    <option value="manual_adjustment_required">Manual adjustment required</option>
                  </select>
                </label>
                {disposition === 'partial_refund' && (
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    Refund amount ({currency})
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={partialAmount}
                      onChange={(event) => setPartialAmount(event.target.value)}
                      className="h-10 rounded-md border border-neutral-300 px-3 text-sm"
                    />
                  </label>
                )}
                {disposition === 'externally_settled' && (
                  <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                    External settlement reference
                    <input
                      value={externalReference}
                      onChange={(event) => setExternalReference(event.target.value)}
                      maxLength={255}
                      className="h-10 rounded-md border border-neutral-300 px-3 text-sm"
                    />
                  </label>
                )}
                <label className="grid gap-1 text-xs font-semibold text-neutral-700">
                  Financial basis
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="flex items-start gap-2 text-xs leading-5 text-neutral-700">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  I confirm this disposition applies to the protected captured
                  User Payable and requires independent approval before execution.
                </label>
                <button
                  type="button"
                  onClick={() => void act('propose')}
                  disabled={!proposalReady || Boolean(busy)}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-brand-orange px-4 text-sm font-semibold text-black disabled:opacity-50"
                >
                  {busy === 'propose' && <Loader2 className="h-4 w-4 animate-spin" />}
                  Propose disposition
                </button>
              </div>
            )}
          </>
        )}

        {hasProposal && !resolved && (
          <div className="space-y-3 rounded-md border border-neutral-200 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-navy-950">
              <ShieldCheck className="h-4 w-4 text-brand-orange" aria-hidden />
              {humanize(context.financialDisposition)} ·{' '}
              {context.approvedAt ? 'independently approved' : 'awaiting approval'}
            </p>
            {context.financialAmount !== null && (
              <p className="text-xs text-neutral-600">
                Refund: {money(context.financialAmount, context.financialCurrency ?? currency)}
              </p>
            )}
            {context.externalSettlementReference && (
              <p className="break-all text-xs text-neutral-600">
                Settlement reference: {context.externalSettlementReference}
              </p>
            )}
            {!context.approvedAt && canApprove && (
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void act('approve')}
                  disabled={Boolean(busy) || isProposalMaker}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" />}
                  Approve independently
                </button>
                <div className="flex gap-2">
                  <input
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                    placeholder="Rejection reason"
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void act('reject')}
                    disabled={Boolean(busy) || !rejectionReason.trim()}
                    className="rounded-md border border-red-300 px-3 text-xs font-semibold text-red-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
                {isProposalMaker && (
                  <p className="text-xs text-amber-800 sm:col-span-2">
                    You created this proposal; a different Admin or Super Admin must approve it.
                  </p>
                )}
              </div>
            )}
            {context.approvedAt &&
              context.financialDisposition === 'manual_adjustment_required' && (
                <p className="rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  Manual adjustment is the approved disposition. The case stays
                  explicit and cannot be auto-closed or mutate the wallet.
                </p>
              )}
            {context.approvedAt &&
              context.financialDisposition !== 'manual_adjustment_required' &&
              canExecute && (
                <button
                  type="button"
                  onClick={() => void act('execute')}
                  disabled={Boolean(busy)}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-brand-orange px-4 text-sm font-semibold text-navy-950 disabled:opacity-50"
                >
                  {busy === 'execute' && <Loader2 className="h-4 w-4 animate-spin" />}
                  Execute approved disposition
                </button>
              )}
          </div>
        )}

        {resolved && (
          <p className="flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Resolved: {humanize(context.resolutionOutcome ?? 'financial disposition recorded')}
          </p>
        )}
        {context.rejectedAt && !hasProposal && (
          <p className="rounded-md bg-red-50 p-3 text-xs text-red-800">
            Previous proposal rejected: {context.rejectionReason ?? 'No reason available'}.
            A new fresh-evidence proposal is required.
          </p>
        )}
        {message && (
          <p aria-live="polite" className="text-xs font-medium text-navy-800">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
