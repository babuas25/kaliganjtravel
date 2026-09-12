'use client';

import { useStatusFeedback } from '@/components/feedback/StatusFeedback';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  RefreshCw,
  UserRoundCheck,
  WalletCards,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ManageAction,
  ManageStatus,
} from '@/components/dashboard/bookings/BookingsTabs';
import type { Role } from '@/lib/roles';
import {
  formatMinor,
  formatTicketManagementEvent,
  formatTicketManagementRequestStatus,
  formatTicketManagementStatus,
  moneyToMinor,
  ticketManagementFetch,
  type TicketManagementDetail,
  type TicketManagementListItem,
  type TicketManagementQuote,
} from '@/lib/ticket-management/client';
import {
  canAssignTicketManagementSettlement,
  canDirectlyFinalizeTicketManagementSettlement,
  canFinalizeTicketManagementSettlement,
  canOperateTicketManagementRequest,
  canPublishTicketManagementQuote,
} from '@/lib/ticket-management/permissions';

type Assignee = { userId: string; name: string; email: string; role: string };
type MutationInput = Record<string, unknown> & { action: string; expectedVersion: number };

const fieldClass =
  'h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-xs text-navy-950 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10';
const primaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-brand-orange px-3 text-xs font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-semibold text-navy-950 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dhaka',
  }).format(date);
}

function parseTableDate(value: string | null): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return new Date(
      Date.UTC(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3])
      )
    );
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const tableWeekday = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  timeZone: 'Asia/Dhaka',
});
const tableDay = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: '2-digit',
  timeZone: 'Asia/Dhaka',
});
const tableTime = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Dhaka',
});

function TableDateCell({
  value,
  withTime = false,
}: {
  value: string | null;
  withTime?: boolean;
}) {
  const date = parseTableDate(value);
  if (!date) return <span className="text-neutral-400">—</span>;
  return (
    <span className="block text-[10px] leading-tight xl:text-[11px]">
      <span className="block font-medium text-navy-950">
        {tableWeekday.format(date)}
      </span>
      <span className="block text-navy-950">{tableDay.format(date)}</span>
      {withTime && (
        <span className="block text-neutral-500">at {tableTime.format(date)}</span>
      )}
    </span>
  );
}

function requestStatusClass(status: string): string {
  if (status === 'completed') return 'bg-emerald-600 text-white';
  if (status === 'approved') return 'bg-blue-600 text-white';
  if (status === 'awaiting-confirmation') return 'bg-amber-400 text-navy-950';
  if (status === 'in-progress') return 'bg-sky-600 text-white';
  if (status === 'rejected') return 'bg-red-600 text-white';
  if (status === 'expired') return 'bg-neutral-500 text-white';
  return 'bg-brand-orange text-navy-950';
}

function RequestStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${requestStatusClass(status)}`}
    >
      {formatTicketManagementRequestStatus(status)}
    </span>
  );
}

function currentQuote(detail: TicketManagementDetail): TicketManagementQuote | null {
  return detail.quotes.find((quote) => quote.id === detail.activeQuoteId) ??
    detail.quotes.at(-1) ?? null;
}

function QuoteSummary({ quote, staff }: { quote: TicketManagementQuote; staff: boolean }) {
  const lines = [
    ...(staff && quote.supplierGrossAmount !== undefined
      ? [['Supplier Gross Fare', quote.supplierGrossAmount] as const]
      : []),
    ...(staff && quote.supplierPayableAmount !== undefined
      ? [['Supplier Payable', quote.supplierPayableAmount] as const]
      : []),
    ...(quote.userPayableEntitlementAmount > 0
      ? [['User Payable entitlement', quote.userPayableEntitlementAmount] as const]
      : []),
    ...(quote.fareDifference > 0 ? [['Fare difference', quote.fareDifference] as const] : []),
    ...(quote.airlineFee > 0 ? [['Airline fee', quote.airlineFee] as const] : []),
    ...(quote.voidFee > 0 ? [['Airline VOID fee', quote.voidFee] as const] : []),
    ...(quote.serviceFee > 0 ? [['Service fee', quote.serviceFee] as const] : []),
  ];
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">
          Quotation v{quote.quoteVersion}
        </h4>
        <span className="rounded-full bg-navy-50 px-2 py-1 text-[10px] font-semibold uppercase text-navy-700">
          {quote.direction}
        </span>
      </div>
      <dl className="mt-3 space-y-1.5 text-xs text-neutral-600">
        {lines.map(([label, amount]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt>{label}</dt>
            <dd className="font-semibold text-navy-950">{formatMinor(amount, quote.currency)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-neutral-200 pt-2 text-navy-950">
          <dt className="font-semibold">
            {quote.direction === 'credit' ? 'Customer credit' :
              quote.direction === 'debit' ? 'Customer payment' : 'Wallet effect'}
          </dt>
          <dd className="font-bold">{formatMinor(quote.customerAmount, quote.currency)}</dd>
        </div>
      </dl>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-neutral-500">
        <Clock3 className="h-3.5 w-3.5 text-brand-orange" aria-hidden />
        Customer confirmation deadline: {formatDate(quote.confirmationDeadlineAt)}
      </p>
      {quote.details && <p className="mt-2 text-xs leading-5 text-neutral-600">{quote.details}</p>}
    </section>
  );
}

function QuoteForm({
  detail,
  busy,
  onPublish,
}: {
  detail: TicketManagementDetail;
  busy: boolean;
  onPublish: (input: MutationInput) => Promise<void>;
}) {
  const entitlement = detail.passengers.reduce(
    (total, passenger) => total + (passenger.entitlementAmount ?? 0),
    0,
  );
  const [airlineFee, setAirlineFee] = useState('0.00');
  const [voidFee, setVoidFee] = useState('0.00');
  const [serviceFee, setServiceFee] = useState('0.00');
  const [deadline, setDeadline] = useState('');
  const [details, setDetails] = useState('');
  const [allocations, setAllocations] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      detail.passengers
        .filter((passenger) => passenger.entitlementId)
        .map((passenger) => [passenger.entitlementId as string, '0.00']),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const airlineFeeMinor = moneyToMinor(airlineFee) ?? 0;
  const voidFeeMinor = moneyToMinor(voidFee) ?? 0;
  const serviceFeeMinor = moneyToMinor(serviceFee) ?? 0;
  const fareDifferenceMinor = detail.action === 'reissue'
    ? Object.values(allocations).reduce((total, value) => total + (moneyToMinor(value) ?? 0), 0)
    : 0;
  const charge = detail.action === 'refund'
    ? airlineFeeMinor + serviceFeeMinor
    : detail.action === 'void'
      ? voidFeeMinor + serviceFeeMinor
      : fareDifferenceMinor + airlineFeeMinor + serviceFeeMinor;
  const direction = detail.action === 'reissue'
    ? (charge === 0 ? 'none' : 'debit')
    : entitlement > charge
      ? 'credit'
      : entitlement < charge
        ? 'debit'
        : 'none';
  const customerAmount = detail.action === 'reissue'
    ? charge
    : Math.abs(entitlement - charge);

  async function publish() {
    if (!deadline || Number.isNaN(new Date(deadline).getTime())) {
      setError('Provide the customer confirmation deadline.');
      return;
    }
    if (detail.action === 'refund' && charge > entitlement) {
      setError('Refund airline and service fees cannot exceed the selected User Payable entitlement.');
      return;
    }
    const reissueAllocations = detail.passengers.map((passenger) => ({
      entitlementId: passenger.entitlementId ?? '',
      fareDifferenceAmountMinor: moneyToMinor(
        allocations[passenger.entitlementId ?? ''] ?? '',
      ),
    }));
    if (
      detail.action === 'reissue' &&
      reissueAllocations.some((allocation) =>
        !allocation.entitlementId || allocation.fareDifferenceAmountMinor === null)
    ) {
      setError('Every passenger needs an exact fare-difference allocation.');
      return;
    }
    setError(null);
    await onPublish({
      action: 'publish-quote',
      expectedVersion: detail.version,
      direction,
      currency: detail.currency,
      userPayableEntitlementAmountMinor: detail.action === 'reissue' ? 0 : entitlement,
      fareDifferenceMinor,
      airlineFeeMinor: detail.action === 'void' ? 0 : airlineFeeMinor,
      voidFeeMinor: detail.action === 'void' ? voidFeeMinor : 0,
      serviceFeeMinor,
      customerAmountMinor: customerAmount,
      confirmationDeadlineAt: new Date(deadline).toISOString(),
      details: details.trim() || null,
      ...(detail.action === 'reissue'
        ? {
            reissueFareDifferenceAllocations: reissueAllocations.map((allocation) => ({
              entitlementId: allocation.entitlementId,
              fareDifferenceAmountMinor: allocation.fareDifferenceAmountMinor as number,
            })),
          }
        : {}),
    });
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Prepare quotation</h4>
      <p className="mt-1 text-[11px] text-neutral-500">
        Amounts are displayed in {detail.currency}; the API converts them to exact minor units.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {detail.action !== 'reissue' && (
          <label className="text-[11px] font-semibold text-neutral-600">User Payable entitlement<input readOnly value={(entitlement / 100).toFixed(2)} className={`${fieldClass} mt-1 bg-navy-50`} /></label>
        )}
        {detail.action !== 'void' && (
          <label className="text-[11px] font-semibold text-neutral-600">Airline {detail.action === 'refund' ? 'Refund' : 'Reissue'} Fee<input value={airlineFee} onChange={(event) => setAirlineFee(event.target.value)} inputMode="decimal" className={`${fieldClass} mt-1`} /></label>
        )}
        {detail.action === 'void' && (
          <label className="text-[11px] font-semibold text-neutral-600">Airline VOID fee<input value={voidFee} onChange={(event) => setVoidFee(event.target.value)} inputMode="decimal" className={`${fieldClass} mt-1`} /></label>
        )}
        <label className="text-[11px] font-semibold text-neutral-600">Kaliganj Travels Service Fee<input value={serviceFee} onChange={(event) => setServiceFee(event.target.value)} inputMode="decimal" className={`${fieldClass} mt-1`} /></label>
      </div>
      {detail.action === 'reissue' && (
        <div className="mt-3 rounded-md bg-navy-50 p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-navy-950">Fare difference by passenger</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {detail.passengers.map((passenger) => (
              <label key={passenger.entitlementId} className="text-[11px] font-semibold text-neutral-600">
                {passenger.passengerName}
                <input value={allocations[passenger.entitlementId ?? ''] ?? ''} onChange={(event) => setAllocations((current) => ({ ...current, [passenger.entitlementId ?? '']: event.target.value }))} inputMode="decimal" className={`${fieldClass} mt-1`} />
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-semibold text-neutral-600">Customer confirmation deadline<input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} className={`${fieldClass} mt-1`} /></label>
        <div className="rounded-md border border-brand-orange/15 bg-brand-orange-light/40 p-3 text-xs text-navy-950">
          <p className="font-semibold">{detail.action === 'refund' ? 'Final Refund Amount' : `Final customer ${direction === 'credit' ? 'credit' : direction === 'debit' ? 'payment' : 'wallet effect'}`}</p>
          <p className="mt-1 text-lg font-bold">{formatMinor(customerAmount, detail.currency)}</p>
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">{direction}</p>
        </div>
      </div>
      <label className="mt-3 block text-[11px] font-semibold text-neutral-600">Quotation notes<textarea value={details} onChange={(event) => setDetails(event.target.value)} rows={3} maxLength={4000} className="mt-1 w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-navy-950 outline-none focus:border-brand-orange" /></label>
      {error && <p role="alert" className="mt-3 text-xs font-medium text-red-700">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void publish()} className={`${primaryButton} mt-3`}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Publish quotation</button>
    </section>
  );
}

export default function TicketManagementWorkspace({
  action,
  status,
  role,
  currentUserId,
  openRequestPublicRef = null,
}: {
  action: ManageAction;
  status: ManageStatus;
  role: Role;
  currentUserId: string;
  /** Deep link from a booking page/list request reference. */
  openRequestPublicRef?: string | null;
}) {
  const [requests, setRequests] = useState<TicketManagementListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketManagementDetail | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [operationalNote, setOperationalNote] = useState('');
  const [releaseReason, setReleaseReason] = useState('Manual supplier operation was not performed.');
  const [newTickets, setNewTickets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const showFeedback = useStatusFeedback();
  const [pendingMutation, setPendingMutation] = useState<{ fingerprint: string; key: string } | null>(null);
  const staff = !['customer', 'b2b', 'b2b_sub'].includes(role);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ action, limit: '100' });
      if (status !== 'all') query.set('status', status);
      const data = await ticketManagementFetch<TicketManagementListItem[]>(
        `/api/ticket-management?${query}`,
      );
      setRequests(data);
      setSelectedId((current) =>
        current && data.some((item) => item.id === current) ? current : null
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Requests could not be loaded.');
      setRequests([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [action, status]);

  const loadDetail = useCallback(async (requestId: string) => {
    setError(null);
    try {
      const value = await ticketManagementFetch<TicketManagementDetail>(
        `/api/ticket-management/${encodeURIComponent(requestId)}`,
      );
      setDetail(value);
      setAssigneeUserId(value.assigneeUserId ?? '');
      const quote = currentQuote(value);
      setNewTickets(Object.fromEntries(value.passengers.map((passenger) => [
        passenger.entitlementId ?? String(passenger.passengerIndex),
        '',
      ])));
      if (quote?.direction !== 'debit') setReleaseReason('Manual supplier operation was not performed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request details could not be loaded.');
      setDetail(null);
    }
  }, []);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => {
    if (!openRequestPublicRef || loading) return;
    const matchingRequest = requests.find(
      (request) => request.publicRef === openRequestPublicRef
    );
    if (matchingRequest) setSelectedId(matchingRequest.id);
  }, [loading, openRequestPublicRef, requests]);
  useEffect(() => {
    setDetail(null);
    if (selectedId) void loadDetail(selectedId);
  }, [loadDetail, selectedId]);
  useEffect(() => {
    if (role !== 'staff_support') return;
    void ticketManagementFetch<Assignee[]>('/api/ticket-management/assignees')
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, [role]);

  async function mutate(input: MutationInput) {
    if (!detail || busy) return;
    const fingerprint = JSON.stringify(input);
    const key = pendingMutation?.fingerprint === fingerprint
      ? pendingMutation.key
      : crypto.randomUUID();
    setPendingMutation({ fingerprint, key });
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await ticketManagementFetch<{ outcome?: string }>(
        `/api/ticket-management/${encodeURIComponent(detail.id)}/actions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, requestKey: key }),
        },
      );
      setPendingMutation(null);
      const completion = {
        refunded: { title: 'Refunded', tone: 'refund' as const },
        reissued: { title: 'Ticket Reissued', tone: 'reissue' as const },
        voided: { title: 'Ticket Voided', tone: 'neutral' as const },
      };
      const completed = completion[result.outcome as keyof typeof completion];
      showFeedback({
        title: completed?.title ?? (input.action === 'review' ? input.decision === 'reject' ? 'Request Rejected' : 'Request In Progress' : input.action === 'publish-quote' ? 'Quotation Published' : 'Request Updated'),
        description: completed ? 'The settlement has been recorded successfully. The request details show the latest result.' : 'Your changes have been saved. The request details show the next step.',
        tone: completed?.tone ?? (input.action === 'review' && input.decision === 'accept' ? 'progress' : 'neutral'),
        reference: detail.publicRef,
      });
      setOperationalNote('');
      setMessage(
        input.action === 'review'
          ? input.decision === 'reject'
            ? 'Request rejected.'
            : 'Request accepted and ready for review.'
          : input.action === 'publish-quote'
            ? 'Quotation published.'
            : input.action === 'requote'
              ? 'Request returned for a new quotation.'
              : input.action === 'assign'
                ? 'Settlement assigned.'
                : input.action.startsWith('release-')
                  ? 'Wallet hold released and request reopened.'
                  : 'Settlement recorded. The request remains approved.'
      );
      await Promise.all([loadDetail(detail.id), loadRequests()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const quote = detail ? currentQuote(detail) : null;
  const canFinalizeCurrentRequest = Boolean(
    canDirectlyFinalizeTicketManagementSettlement(role) ||
    (detail && detail.assigneeUserId === currentUserId && canFinalizeTicketManagementSettlement(role)),
  );
  const reissueAllocations = useMemo(() => new Map(
    (quote?.fareDifferenceAllocations ?? []).map((allocation) => [
      allocation.entitlementId,
      allocation.fareDifferenceAmount,
    ]),
  ), [quote]);
  const reissueCompletionReady = Boolean(
    detail?.action !== 'reissue' ||
    (
      detail.passengers.every((passenger) =>
        Boolean(passenger.entitlementId) &&
        reissueAllocations.has(passenger.entitlementId as string) &&
        Boolean(newTickets[passenger.entitlementId as string]?.trim())
      )
    ),
  );

  function toggleRequest(requestId: string) {
    setSelectedId((current) => current === requestId ? null : requestId);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void loadRequests()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-xs font-semibold text-navy-950 transition hover:bg-navy-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>

      {error && <div role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />{error}</div>}
      {message && <div role="status" className="flex gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-800"><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />{message}</div>}

      <div className="hidden w-full overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm lg:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-[10px] xl:text-[11px]">
            <thead className="bg-navy-50">
              <tr>
                {[
                  'Ref',
                  'Agency',
                  'Status',
                  'Airline',
                  'Flight Date',
                  'Issued Date',
                  'Passenger Details',
                  'Gross Fare',
                  'User Payable',
                  'Updated By',
                  'Updated On',
                ].map((label) => (
                  <th
                    key={label}
                    className="border-b border-neutral-200 px-2 py-2 text-left align-top text-[10px] font-semibold uppercase tracking-[0.04em] text-neutral-500 xl:text-[11px]"
                  >
                    <span className="whitespace-pre-line leading-tight">
                      {label.replace(/ /g, '\n')}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-xs text-neutral-500">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
                      Loading requests…
                    </span>
                  </td>
                </tr>
              ) : requests.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-xs text-neutral-500">
                    No requests match this filter.
                  </td>
                </tr>
              ) : requests.map((request) => (
                <tr
                  key={request.id}
                  className={`border-b border-neutral-200 transition-colors ${selectedId === request.id ? 'bg-brand-orange-light/35' : 'hover:bg-navy-50/60'}`}
                >
                  <td className="px-2 py-2 align-top">
                    <button
                      type="button"
                      onClick={() => toggleRequest(request.id)}
                      aria-expanded={selectedId === request.id}
                      className="group flex max-w-[10rem] items-start gap-1.5 text-left"
                    >
                      {selectedId === request.id
                        ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden />
                        : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400 group-hover:text-brand-orange" aria-hidden />}
                      <span>
                        <span className="block font-bold text-navy-950 group-hover:text-brand-orange-dark">
                          {request.bookingReference ?? request.publicRef}
                        </span>
                        {request.bookingReference && (
                          <span className="mt-0.5 block text-[9px] text-neutral-500">
                            {request.publicRef}
                          </span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="max-w-[10rem] px-2 py-2 align-top leading-tight text-navy-950">
                    {request.agencyId ? (
                      <>
                        <span className="block font-semibold">
                          {request.agencyName ?? 'Unnamed agency'}
                        </span>
                        <span className="mt-0.5 block font-mono text-[9px] text-neutral-500">
                          {request.agencyId}
                        </span>
                      </>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top"><RequestStatusBadge status={request.status} /></td>
                  <td className="max-w-[8rem] px-2 py-2 align-top leading-tight text-navy-950">
                    <span className="block font-medium">{request.airline ?? '—'}</span>
                    {request.airlineCode && request.airlineCode !== request.airline && (
                      <span className="block text-neutral-500">{request.airlineCode}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top"><TableDateCell value={request.flightDate} /></td>
                  <td className="px-2 py-2 align-top"><TableDateCell value={request.issuedAt} withTime /></td>
                  <td className="max-w-[11rem] px-2 py-2 align-top leading-tight text-navy-950">
                    {request.passengerDetails.length === 0 ? '—' : request.passengerDetails.map((passenger, index) => (
                      <span key={`${passenger.passengerName}-${index}`} className="block [&+&]:mt-1">
                        <span className="block font-medium">{passenger.passengerName}</span>
                        <span className="block text-[9px] text-neutral-500">
                          {passenger.passengerType}{passenger.ticketNumber ? ` · ${passenger.ticketNumber}` : ''}
                        </span>
                      </span>
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 align-top font-semibold tabular-nums text-navy-950">
                    {request.grossFare === null ? '—' : formatMinor(request.grossFare, request.currency)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 align-top font-semibold tabular-nums text-navy-950">
                    {request.userPayable === null ? '—' : formatMinor(request.userPayable, request.currency)}
                  </td>
                  <td className="max-w-[9rem] px-2 py-2 align-top leading-tight text-navy-950">
                    <span className="block font-medium">{request.updatedBy}</span>
                    {request.updatedByRole && request.updatedByRole !== request.updatedBy && (
                      <span className="block text-neutral-500">{request.updatedByRole}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top"><TableDateCell value={request.updatedAt} withTime /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3 lg:hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white p-8 text-xs text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />Loading requests…
          </div>
        ) : requests.length === 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
            No requests match this filter.
          </div>
        ) : requests.map((request) => (
          <div key={request.id} className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <button
              type="button"
              onClick={() => toggleRequest(request.id)}
              aria-expanded={selectedId === request.id}
              className={`flex w-full items-center justify-between gap-3 px-3 py-3 text-left ${selectedId === request.id ? 'bg-brand-orange-light/35' : 'bg-navy-50'}`}
            >
              <span>
                <span className="block text-xs font-bold text-navy-950">{request.bookingReference ?? request.publicRef}</span>
                {request.bookingReference && <span className="block text-[10px] text-neutral-500">{request.publicRef}</span>}
              </span>
              <span className="flex items-center gap-2">
                <RequestStatusBadge status={request.status} />
                {selectedId === request.id ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
              </span>
            </button>
            <table className="w-full table-fixed text-xs">
              <tbody>
                {[
                  ['Agency', request.agencyId
                    ? `${request.agencyName ?? 'Unnamed agency'} · ${request.agencyId}`
                    : '—'],
                  ['Airline', request.airline ?? '—'],
                  ['Flight Date', <TableDateCell key="flight" value={request.flightDate} />],
                  ['Issued Date', <TableDateCell key="issued" value={request.issuedAt} withTime />],
                  ['Passenger Details', request.passengerDetails.length === 0 ? '—' : request.passengerDetails.map((passenger) => passenger.passengerName).join(', ')],
                  ['Gross Fare', request.grossFare === null ? '—' : formatMinor(request.grossFare, request.currency)],
                  ['User Payable', request.userPayable === null ? '—' : formatMinor(request.userPayable, request.currency)],
                  ['Updated By', request.updatedBy],
                  ['Updated On', <TableDateCell key="updated" value={request.updatedAt} withTime />],
                ].map(([label, value]) => (
                  <tr key={label as string} className="border-t border-neutral-100">
                    <th className="w-[38%] bg-neutral-50 px-3 py-2 text-left align-top font-semibold text-neutral-500">{label}</th>
                    <td className="px-3 py-2 align-top text-navy-950">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <section className="space-y-4">
        {selectedId && !detail && !error && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white p-6 text-xs text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
            Loading request details…
          </div>
        )}
        {detail && (
          <>
            <header className="rounded-xl bg-brand-orange p-4 text-black">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-[10px] font-semibold uppercase tracking-wide text-black">{detail.publicRef}</p><h3 className="mt-1 text-lg font-bold">{detail.bookingReference} · {detail.action === 'void' ? 'VOID' : formatTicketManagementStatus(detail.action)}</h3></div>
                <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wide">{formatTicketManagementRequestStatus(detail.status)}</span>
              </div>
              {detail.requestNote && <p className="mt-3 whitespace-pre-line text-xs leading-5 text-black">{detail.requestNote}</p>}
            </header>

            <section className="rounded-xl border border-neutral-200 bg-white p-4">
              <h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Passengers and tickets</h4>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {detail.passengers.map((passenger) => (
                  <div key={passenger.passengerIndex} className="rounded-md bg-navy-50 px-3 py-2 text-xs text-navy-950"><p className="font-semibold">{passenger.passengerName}</p><p className="mt-0.5 text-[10px] text-neutral-500">{passenger.passengerType} · {passenger.ticketNumber ?? 'Ticket unavailable'}{staff && passenger.entitlementAmount !== undefined ? ` · ${formatMinor(passenger.entitlementAmount, detail.currency)} entitlement` : ''}</p></div>
                ))}
              </div>
            </section>

            {detail.routes.length > 0 && (
              <section className="rounded-xl border border-neutral-200 bg-white p-4">
                <h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Selected routes</h4>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {detail.routes.map((route) => (
                    <div key={route.routeIndex} className="rounded-md bg-navy-50 px-3 py-2 text-xs text-navy-950">
                      <p className="font-semibold">{route.label}: {route.origin} → {route.destination}</p>
                      <p className="mt-0.5 text-[10px] text-neutral-500">Current departure: {route.departureAt ? formatDate(route.departureAt) : 'Not available'}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {quote && <QuoteSummary quote={quote} staff={staff} />}

            {detail.status === 'requested' && canOperateTicketManagementRequest(role) && (
              <section className="rounded-xl border border-neutral-200 bg-white p-4"><h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Review incoming request</h4><textarea value={operationalNote} onChange={(event) => setOperationalNote(event.target.value)} rows={2} placeholder="Optional review note" className="mt-3 w-full rounded-md border border-neutral-200 px-3 py-2 text-xs" /><div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => void mutate({ action: 'review', decision: 'reject', expectedVersion: detail.version, note: operationalNote.trim() || null })} className={secondaryButton}>Reject</button><button type="button" disabled={busy} onClick={() => void mutate({ action: 'review', decision: 'accept', expectedVersion: detail.version, note: operationalNote.trim() || null })} className={primaryButton}>Accept and start review</button></div></section>
            )}

            {detail.status === 'in-progress' && canPublishTicketManagementQuote(role) && <QuoteForm detail={detail} busy={busy} onPublish={mutate} />}

            {detail.status === 'awaiting-confirmation' && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900"><p className="font-semibold">Waiting for customer confirmation</p><p className="mt-1">The approved amount cannot be changed. A revised amount requires requotation and a new deadline.</p></div>}

            {['in-progress', 'awaiting-confirmation'].includes(detail.status) && canOperateTicketManagementRequest(role) && (
              <section className="rounded-xl border border-red-200 bg-red-50 p-4"><h4 className="text-xs font-bold uppercase tracking-wide text-red-900">Reject request</h4><p className="mt-1 text-xs text-red-800">Available until the customer approves the quotation. Rejection closes this request and releases its selected tickets.</p><textarea value={operationalNote} onChange={(event) => setOperationalNote(event.target.value)} rows={2} placeholder="Optional rejection reason" className="mt-3 w-full rounded-md border border-red-200 bg-white px-3 py-2 text-xs" /><button type="button" disabled={busy} onClick={() => void mutate({ action: 'review', decision: 'reject', expectedVersion: detail.version, note: operationalNote.trim() || null })} className={`${secondaryButton} mt-2 border-red-300 text-red-800 hover:bg-red-100`}>Reject request</button></section>
            )}

            {detail.status === 'approved' && !detail.terminalOutcome && role === 'staff_support' && canAssignTicketManagementSettlement(role) && (
              <section className="rounded-xl border border-neutral-200 bg-white p-4"><h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-navy-950"><UserRoundCheck className="h-4 w-4 text-brand-orange" aria-hidden />Financial assignment</h4><div className="mt-3 flex flex-col gap-2 sm:flex-row"><select value={assigneeUserId} onChange={(event) => setAssigneeUserId(event.target.value)} className={fieldClass}><option value="">Select Accounts/Admin/Superadmin</option>{assignees.map((assignee) => <option key={assignee.userId} value={assignee.userId}>{assignee.name} · {formatTicketManagementStatus(assignee.role)}</option>)}</select><button type="button" disabled={busy || !assigneeUserId} onClick={() => void mutate({ action: 'assign', assigneeUserId, expectedVersion: detail.version, reason: 'Assigned for approved final settlement.' })} className={primaryButton}>Assign settlement</button></div></section>
            )}

            {detail.status === 'approved' && !detail.terminalOutcome && quote?.direction !== 'debit' && canOperateTicketManagementRequest(role) && (
              <section className="rounded-xl border border-neutral-200 bg-white p-4"><h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Quotation changed?</h4><p className="mt-1 text-xs text-neutral-500">Return the request to In Progress and require a new quotation, deadline, and customer approval.</p><input value={operationalNote} onChange={(event) => setOperationalNote(event.target.value)} placeholder="Required reason for requotation" className={`${fieldClass} mt-3`} /><button type="button" disabled={busy || !operationalNote.trim()} onClick={() => void mutate({ action: 'requote', expectedVersion: detail.version, reason: operationalNote.trim() })} className={`${secondaryButton} mt-2`}>Requote</button></section>
            )}

            {detail.status === 'approved' && !detail.terminalOutcome && canFinalizeCurrentRequest && quote && (
              <section className="rounded-xl border border-brand-orange/20 bg-white p-4"><h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-navy-950"><WalletCards className="h-4 w-4 text-brand-orange" aria-hidden />Record approved settlement</h4><p className="mt-1 text-xs text-neutral-500">The amount is read-only and comes from quotation v{quote.quoteVersion}: <strong className="text-navy-950">{formatMinor(quote.customerAmount, quote.currency)}</strong>.</p>
                {detail.action === 'reissue' && <div className="mt-3 grid gap-2 sm:grid-cols-2">{detail.passengers.map((passenger) => <label key={passenger.entitlementId} className="text-[11px] font-semibold text-neutral-600">New ticket for {passenger.passengerName}<input value={newTickets[passenger.entitlementId ?? String(passenger.passengerIndex)] ?? ''} onChange={(event) => setNewTickets((current) => ({ ...current, [passenger.entitlementId ?? String(passenger.passengerIndex)]: event.target.value }))} placeholder="New ticket number" className={`${fieldClass} mt-1`} /><span className="mt-1 block text-[10px] font-normal">Fare difference: {formatMinor(reissueAllocations.get(passenger.entitlementId ?? '') ?? 0, quote.currency)}</span></label>)}</div>}
                <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy || !reissueCompletionReady} onClick={() => void mutate(detail.action === 'refund' ? { action: 'complete-refund', expectedVersion: detail.version, note: operationalNote.trim() || null } : detail.action === 'void' ? { action: 'complete-void', expectedVersion: detail.version, note: operationalNote.trim() || null } : { action: 'complete-reissue', expectedVersion: detail.version, newTickets: detail.passengers.map((passenger) => ({ predecessorEntitlementId: passenger.entitlementId as string, newTicketNumber: newTickets[passenger.entitlementId as string]?.trim(), fareDifferenceAmountMinor: reissueAllocations.get(passenger.entitlementId as string) as number })), note: operationalNote.trim() || null })} className={primaryButton}>Record settlement</button></div>
                {quote.direction === 'debit' && (detail.action === 'reissue' || detail.action === 'void') && <div className="mt-4 border-t border-neutral-200 pt-4"><label className="text-[11px] font-semibold text-neutral-600">If the manual operation was not performed<input value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} className={`${fieldClass} mt-1`} /></label><button type="button" disabled={busy || !releaseReason.trim()} onClick={() => void mutate({ action: detail.action === 'reissue' ? 'release-reissue' : 'release-void', expectedVersion: detail.version, reason: releaseReason.trim() })} className={`${secondaryButton} mt-2`}>Release Hold and return to In Progress</button></div>}
              </section>
            )}

            {detail.status === 'approved' && !detail.terminalOutcome && !canFinalizeCurrentRequest && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-blue-900"><p className="font-semibold">Approved quotation requires financial settlement.</p><p className="mt-1">{role === 'staff_support' ? 'Assign an Accounts Staff, Admin, or Super Admin. Support cannot credit, capture, or release wallet funds.' : 'Accounts Staff can record the settlement after Support assigns this request to them.'}</p></div>
            )}

            <section className="rounded-xl border border-neutral-200 bg-white p-4"><h4 className="text-xs font-bold uppercase tracking-wide text-navy-950">Activity</h4><ol className="mt-3 space-y-2">{detail.events.slice().reverse().map((event, index) => <li key={`${event.eventType}-${event.effectiveAt}-${index}`} className="flex gap-3 text-xs"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-orange" /><span><strong className="text-navy-950">{formatTicketManagementEvent(event.eventType)}</strong><span className="ml-2 text-[10px] text-neutral-500">{formatDate(event.effectiveAt)}</span>{staff && event.actorRole && <span className="mt-0.5 block text-[10px] text-neutral-500">{formatTicketManagementStatus(event.actorRole)}</span>}</span></li>)}</ol></section>
          </>
        )}
      </section>
    </div>
  );
}
