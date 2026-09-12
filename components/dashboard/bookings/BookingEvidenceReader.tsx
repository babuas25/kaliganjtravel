'use client';

import { AlertTriangle, CheckCircle2, Loader2, SearchCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type EvidencePurpose = 'held' | 'ticketed' | 'cancelled';
type CancellationReportStatus = 'Cancelled' | 'Refunded';

type EvidenceReadResponse = {
  success?: boolean;
  data?: {
    replay: boolean;
    automaticNoChangeClosure?: {
      attempted: boolean;
      closed: boolean;
      replay: boolean;
      code: string | null;
      statusMutation: false;
      walletMutation: false;
    };
    recordedSources: string[];
    sourceResults: Array<{
      source: string;
      state: 'recorded' | 'unavailable' | 'failed';
      reasonCode: string | null;
    }>;
    validation: {
      valid: boolean;
      complete: boolean;
      fresh: boolean;
      identityMatches: boolean;
      authoritativeFor: EvidencePurpose | null;
      issueCodes: string[];
    };
    supplierIdentifiers: null | {
      supplierUniqueTransId: string | null;
      supplierInternalBookingId: string | null;
    };
    ticketingDecision: {
      outcome: string;
      candidateOutcome: string | null;
      reasonCode: string;
      supplierTruthAuthoritative: boolean;
      explicitStaffConfirmationRequired: boolean;
      automaticResolutionAllowed: false;
    };
    cancellationDecision: null | {
      outcome: string;
      candidateOutcome: string | null;
      reasonCode: string;
      supplierTruthAuthoritative: boolean;
      explicitStaffConfirmationRequired: boolean;
      automaticResolutionAllowed: false;
    };
    legacyClassification: null | {
      classification: string;
      candidateOutcome: string | null;
      reviewPath: string;
      reasonCode: string;
      genericResolveAllowed: false;
      automaticResolutionAllowed: false;
    };
    confirmationBoundary: {
      explicitStaffConfirmationRequired: true;
      makerCheckerRequired: boolean;
      resolutionBlocked: boolean;
      nextStep: string;
      requirements: string[];
      identityException: boolean;
      incompleteEvidenceException: boolean;
      legacyUncertainty: boolean;
      terminalCorrection: boolean;
      heldNonissuanceUnproven: boolean;
      financialReviewRequired: boolean;
      financialDispositionConfirmationRequired: boolean;
      genericResolveAllowed: false;
      evidenceReadMayResolve: false;
      statusMutationAllowed: false;
      walletMutationAllowed: false;
    };
    statusMutation: false;
    walletMutation: false;
  };
  error?: { errorMessage?: string };
};

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function BookingEvidenceReader({
  bookingReference,
  caseId,
  caseType,
  initialPurpose,
}: {
  bookingReference: string;
  caseId: string;
  caseType: string;
  initialPurpose: EvidencePurpose;
}) {
  const router = useRouter();
  const [purpose, setPurpose] = useState<EvidencePurpose>(initialPurpose);
  const [cancellationReportStatus, setCancellationReportStatus] =
    useState<CancellationReportStatus>('Cancelled');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EvidenceReadResponse['data'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function changePurpose(value: EvidencePurpose) {
    setPurpose(value);
    setRequestId(null);
    setResult(null);
    setError(null);
  }

  async function requestEvidence() {
    const retryIdentity = requestId ?? crypto.randomUUID();
    setRequestId(retryIdentity);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(
        `/api/admin/booking-lifecycle/${encodeURIComponent(bookingReference)}/evidence`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caseId,
            requestId: retryIdentity,
            purpose,
            ...(purpose === 'cancelled' ? { cancellationReportStatus } : {}),
          }),
        }
      );
      const body = (await response.json()) as EvidenceReadResponse;
      if (!response.ok || !body.success || !body.data) {
        throw new Error(
          body.error?.errorMessage ?? 'Supplier evidence could not be acquired.'
        );
      }
      setResult(body.data);
      setRequestId(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Supplier evidence could not be acquired.'
      );
      // Keep the same request identity so a retry cannot duplicate the read.
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-200 px-4 py-3 sm:px-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-navy-950">
          <SearchCheck className="h-4 w-4 text-brand-orange" aria-hidden />
          Supplier evidence investigation
        </h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">
          Open case: {humanize(caseType)}. This performs safe PNR/report reads
          and records immutable evidence. It cannot change booking status or
          wallet money.
        </p>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end sm:px-5">
        <label className="grid gap-1 text-xs font-semibold text-neutral-700">
          Evidence to test
          <select
            value={purpose}
            onChange={(event) => changePurpose(event.target.value as EvidencePurpose)}
            disabled={loading}
            className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-navy-950 outline-none focus:border-brand-orange"
          >
            <option value="held">Held / unticketed</option>
            <option value="ticketed">Ticketed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>

        {purpose === 'cancelled' ? (
          <label className="grid gap-1 text-xs font-semibold text-neutral-700">
            Supplier report
            <select
              value={cancellationReportStatus}
              onChange={(event) => {
                setCancellationReportStatus(
                  event.target.value as CancellationReportStatus
                );
                setRequestId(null);
                setResult(null);
                setError(null);
              }}
              disabled={loading}
              className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-navy-950 outline-none focus:border-brand-orange"
            >
              <option value="Cancelled">Cancelled report</option>
              <option value="Refunded">Refunded report</option>
            </select>
          </label>
        ) : (
          <div className="hidden sm:block" />
        )}

        <button
          type="button"
          onClick={() => void requestEvidence()}
          disabled={loading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-brand-orange px-4 text-sm font-semibold text-black transition hover:bg-brand-orange/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <SearchCheck className="h-4 w-4" aria-hidden />
          )}
          {loading ? 'Reading supplier…' : 'Request fresh evidence'}
        </button>
      </div>

      {(result || error) && (
        <div className="border-t border-neutral-100 px-4 py-3 sm:px-5">
          {error ? (
            <p className="flex gap-2 text-xs leading-5 text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {error} Retrying uses the same request identity.
            </p>
          ) : result ? (
            (() => {
              const decision =
                result.cancellationDecision ?? result.ticketingDecision;
              const classification = result.legacyClassification
                ? {
                    outcome: result.legacyClassification.classification,
                    reasonCode: result.legacyClassification.reasonCode,
                  }
                : decision;
              return (
            <div
              className={`flex gap-2 text-xs leading-5 ${
                result.validation.valid ? 'text-emerald-700' : 'text-amber-800'
              }`}
            >
              {result.validation.valid ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <div>
                <p className="font-semibold">
                  {result.validation.valid
                    ? `Fresh matching evidence recorded for ${result.validation.authoritativeFor}.`
                    : 'Evidence recorded, but it is not authoritative for a resolution.'}
                  {result.replay ? ' Existing request result reused.' : ''}
                </p>
                <p>
                  Sources:{' '}
                  {result.recordedSources.length
                    ? result.recordedSources.map(humanize).join(', ')
                    : 'none'}
                  {result.validation.issueCodes.length
                    ? `. Review: ${result.validation.issueCodes
                        .slice(0, 6)
                        .map(humanize)
                        .join(', ')}`
                    : ''}
                </p>
                {result.supplierIdentifiers?.supplierUniqueTransId && (
                  <p>
                    Supplier transaction:{' '}
                    <span className="font-semibold">
                      {result.supplierIdentifiers.supplierUniqueTransId}
                    </span>
                    {result.supplierIdentifiers.supplierInternalBookingId !== null
                      ? ` · Supplier booking ID: ${result.supplierIdentifiers.supplierInternalBookingId}`
                      : ''}
                  </p>
                )}
                {result.automaticNoChangeClosure?.closed && (
                  <p>
                    The case and linked operation were closed with no lifecycle
                    or wallet change because the existing terminal truth and
                    financial position already matched.
                  </p>
                )}
                <p>
                  {result.legacyClassification
                    ? 'Legacy-case'
                    : result.cancellationDecision
                      ? 'Cancellation-case'
                      : 'Ticketing-case'}{' '}
                  classification: {humanize(classification.outcome)} —{' '}
                  {humanize(classification.reasonCode)}. No resolution
                  is authorized by this read.
                </p>
                {!result.automaticNoChangeClosure?.closed && (
                  <p className="mt-1 font-semibold">
                    Controlled next step:{' '}
                    {humanize(result.confirmationBoundary.nextStep)}. Required
                    confirmations:{' '}
                    {result.confirmationBoundary.requirements
                      .map(humanize)
                      .join(', ')}
                    .{' '}
                    {result.confirmationBoundary.resolutionBlocked
                      ? 'Resolution remains blocked until the evidence exception is addressed.'
                      : 'A later outcome-specific proposal must record these confirmations.'}{' '}
                    {result.confirmationBoundary.makerCheckerRequired
                      ? 'A different authorized approver is required.'
                      : ''}
                  </p>
                )}
              </div>
            </div>
              );
            })()
          ) : null}
        </div>
      )}
    </section>
  );
}
