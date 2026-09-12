"use client";

import { useStatusFeedback } from '@/components/feedback/StatusFeedback';
import {
  Ban,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Loader2,
  Plane,
  RefreshCcw,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  formatMinor,
  formatTicketManagementRequestStatus,
  formatTicketManagementStatus,
  ticketManagementFetch,
  type TicketManagementAvailability,
  type TicketManagementDetail,
  type TicketManagementListItem,
} from "@/lib/ticket-management/client";
import type { TicketManagementAction } from "@/lib/ticket-management/types";
import {
  isTicketVoidRequestOpen,
  ticketVoidRequestDeadline,
} from "@/lib/ticket-management/void-window";

type PassengerOption = { index: number; label: string };

export type PostTicketRouteOption = {
  index: number;
  id: string;
  label: string;
  route: string;
  currentDate?: string;
};

const quickActionButtonClass =
  "flex w-full items-center justify-center gap-2 rounded-md bg-white px-3 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 focus-visible:ring-offset-navy-950";
const sectionCardClass = "rounded-md border border-navy-950/10 bg-white p-3";
const terminalStatuses = new Set(["rejected", "expired"]);

function hasFinalOutcome(detail: TicketManagementDetail): boolean {
  return Boolean(detail.terminalOutcome) || terminalStatuses.has(detail.status);
}

const ACTIONS = [
  {
    value: "refund",
    label: "Refund",
    description: "Choose the passengers and refund reason.",
    icon: CircleDollarSign,
  },
  {
    value: "reissue",
    label: "Reissue",
    description: "Choose the passengers and preferred new travel date.",
    icon: RefreshCcw,
  },
  {
    value: "void",
    label: "VOID",
    description: "Request a manual same-day VOID eligibility check.",
    icon: Ban,
  },
] as const;

function formatDate(value?: string | null, includeTime = false): string {
  if (!value) return "Not available";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Asia/Dhaka",
  }).format(date);
}

function latestQuote(detail: TicketManagementDetail) {
  return detail.quotes.find((quote) => quote.id === detail.activeQuoteId) ??
    detail.quotes.at(-1) ?? null;
}

function QuoteCountdown({ deadline }: { deadline: string }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, Date.parse(deadline) - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (remaining === null) return null;
  if (remaining === 0) return <span className="font-semibold text-brand-orange-dark">Confirmation expired</span>;
  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return <span className="font-semibold text-brand-orange-dark">{days > 0 ? `${days}d ` : ''}{String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(rest).padStart(2, '0')}</span>;
}

const TIMELINE_EVENT_LABELS: Record<string, string> = {
  requested: "Requested",
  accepted: "Accepted",
  "staff-rejected": "Rejected",
  "quotation-published": "Quotation ready",
  "customer-approved": "Approved",
  "customer-rejected": "Rejected",
  "confirmation-expired": "Expired",
  "requote-started": "Requote started",
};
const CUSTOMER_TIMELINE_EVENT_TYPES = new Set(Object.keys(TIMELINE_EVENT_LABELS));

function formatTimelineDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Dhaka",
  }).format(date);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dhaka",
  }).format(date);
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    timeZone: "Asia/Dhaka",
  }).format(date);
  return `${time} · ${day} · ${weekday}`;
}

function quoteAmountLabel(detail: TicketManagementDetail): string {
  if (detail.action === "reissue") return "Total Reissue Amount";
  return "Total VOID Amount";
}

function RequestTimeline({
  detail,
  quote,
  allowOwnerActions,
  submitting,
  onDecision,
}: {
  detail: TicketManagementDetail;
  quote: ReturnType<typeof latestQuote>;
  allowOwnerActions: boolean;
  submitting: boolean;
  onDecision: (decision: "approved" | "rejected") => void;
}) {
  // Staff can see a fuller operational audit in Ticket Management, but this
  // ticket-page timeline intentionally follows the same customer lifecycle:
  // Requested → In Progress → Quotation → Approved/Rejected/Expired.
  const timelineEvents = detail.events.filter((event) =>
    CUSTOMER_TIMELINE_EVENT_TYPES.has(event.eventType),
  );
  const hasQuotationEvent = timelineEvents.some(
    (event) => event.eventType === "quotation-published",
  );
  const hasDecisionEvent = timelineEvents.some((event) =>
    ["customer-approved", "customer-rejected", "staff-rejected", "confirmation-expired"]
      .includes(event.eventType),
  );
  const awaitingCustomerConfirmation = detail.status === "awaiting-confirmation";
  const quotationEventIndexes = timelineEvents
    .map((event, index) => event.eventType === "quotation-published" ? index : -1)
    .filter((index) => index >= 0);
  const activeQuotationEventIndex = quotationEventIndexes.at(-1) ?? -1;
  const entries = timelineEvents.map((event, index) => ({
    key: `${event.eventType}-${event.effectiveAt}-${index}`,
    title: event.eventType === "requested"
      ? `Requested (${detail.publicRef})`
      : TIMELINE_EVENT_LABELS[event.eventType] ?? formatTicketManagementStatus(event.eventType),
    at: event.effectiveAt,
    pending: false,
    showQuote: index === activeQuotationEventIndex && Boolean(quote),
  }));

  if (!hasQuotationEvent && !hasFinalOutcome(detail)) {
    entries.push({
      key: "quotation-pending",
      title: "Quotation pending",
      at: "",
      pending: true,
      showQuote: false,
    });
  }
  if (!hasDecisionEvent && !hasFinalOutcome(detail)) {
    entries.push({
      key: "decision-pending",
      title: "Approved / Rejected / Expired",
      at: "",
      pending: true,
      showQuote: false,
    });
  }

  return (
    <section className="rounded-md bg-white p-3">
      {detail.routes.length > 0 && (
        <div className="mb-3 border-b border-navy-950/10 pb-3">
          <p className="text-[9px] font-bold uppercase tracking-wide text-neutral-500">Selected routes</p>
          <div className="mt-1.5 space-y-1">
            {detail.routes.map((route) => (
              <p key={route.routeIndex} className="text-[10px] font-semibold text-navy-950">
                {route.label}: {route.origin} → {route.destination}
                {route.departureAt && <span className="font-normal text-neutral-500"> · {formatDate(route.departureAt)}</span>}
              </p>
            ))}
          </div>
        </div>
      )}
      <ol aria-label={`${formatTicketManagementStatus(detail.action)} request status timeline`}>
        {entries.map((entry, index) => {
          const last = index === entries.length - 1;
          return (
            <li key={entry.key} className="flex gap-2.5">
              <span className="flex w-3 shrink-0 flex-col items-center" aria-hidden>
                <span className={`mt-0.5 h-2.5 w-2.5 rounded-full border-2 ${entry.pending ? "border-neutral-300 bg-white" : "border-brand-orange bg-brand-orange"}`} />
                {!last && <span className={`min-h-5 w-px flex-1 ${entry.pending ? "bg-neutral-200" : "bg-brand-orange/35"}`} />}
              </span>
              <div className={`min-w-0 flex-1 ${last ? "pb-0" : "pb-3"}`}>
                <p className={`text-[10px] font-bold leading-4 ${entry.pending ? "text-neutral-400" : "text-navy-950"}`}>
                  {entry.title}
                </p>
                {entry.at && (
                  <p className="mt-0.5 text-[9px] leading-3.5 text-neutral-500">
                    {formatTimelineDate(entry.at)}
                  </p>
                )}
                {entry.showQuote && quote && (
                  <div className="mt-2 rounded-md bg-navy-50 p-2.5">
                    <p className="text-[9px] text-neutral-500">
                      Customer confirmation deadline: {formatTimelineDate(quote.confirmationDeadlineAt)}
                    </p>
                    {detail.action === "refund" ? (
                      <dl className="mt-2 space-y-1 text-[9px]">
                        <div className="flex items-center justify-between gap-2 text-neutral-600">
                          <dt>User Payable entitlement</dt>
                          <dd className="font-semibold text-navy-950">{formatMinor(quote.userPayableEntitlementAmount, quote.currency)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-neutral-600">
                          <dt>Airline Refund Fee</dt>
                          <dd className="font-semibold text-navy-950">{formatMinor(quote.airlineFee, quote.currency)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-neutral-600">
                          <dt>Kaliganj Travels Service Fee</dt>
                          <dd className="font-semibold text-navy-950">{formatMinor(quote.serviceFee, quote.currency)}</dd>
                        </div>
                        <div className="flex items-end justify-between gap-2 border-t border-navy-950/10 pt-1.5">
                          <dt className="font-semibold text-neutral-600">Final Refund Amount</dt>
                          <dd className="text-xs font-bold text-navy-950">{formatMinor(quote.customerAmount, quote.currency)}</dd>
                        </div>
                      </dl>
                    ) : (
                      <div className="mt-2 flex items-end justify-between gap-2">
                        <span className="text-[9px] font-semibold text-neutral-600">
                          {quoteAmountLabel(detail)}
                        </span>
                        <strong className="text-xs text-navy-950">
                          {formatMinor(quote.customerAmount, quote.currency)}
                        </strong>
                      </div>
                    )}
                    {awaitingCustomerConfirmation ? (
                      <p className="mt-1 text-right text-[9px] text-neutral-500">
                        <QuoteCountdown deadline={quote.confirmationDeadlineAt} />
                      </p>
                    ) : (
                      <p className="mt-1 text-right text-[9px] text-neutral-500">
                        Customer confirmation has been recorded.
                      </p>
                    )}
                    {quote.details && (
                      <p className="mt-2 text-[9px] leading-3.5 text-neutral-600">
                        {quote.details}
                      </p>
                    )}
                    {allowOwnerActions && detail.status === "awaiting-confirmation" && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button type="button" disabled={submitting} onClick={() => onDecision("rejected")} className="rounded-md border border-navy-950/10 bg-white px-2 py-2 text-[10px] font-semibold text-navy-950 disabled:opacity-50">Reject</button>
                        <button type="button" disabled={submitting} onClick={() => onDecision("approved")} className="rounded-md bg-brand-orange px-2 py-2 text-[10px] font-semibold text-navy-950 disabled:opacity-50">Accept</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function PostTicketActionsPreview({
  bookingReference,
  passengers,
  routes,
  issuedAt,
  allowOwnerActions,
  allowedActions,
}: {
  bookingReference: string;
  passengers: PassengerOption[];
  routes: PostTicketRouteOption[];
  issuedAt?: string | null;
  allowOwnerActions: boolean;
  allowedActions: readonly TicketManagementAction[];
}) {
  const passengerOptions = useMemo(
    () => passengers.length > 0 ? passengers : [{ index: 0, label: "All passengers" }],
    [passengers],
  );
  const [openAction, setOpenAction] = useState<TicketManagementAction | null>(null);
  const [requestType, setRequestType] = useState<"voluntary" | "involuntary">("voluntary");
  const [selectedPassengers, setSelectedPassengers] = useState<number[]>(
    passengerOptions.map((passenger) => passenger.index),
  );
  const [selectedRoutes, setSelectedRoutes] = useState<number[]>(
    routes.map((route) => route.index),
  );
  const [requestedDates, setRequestedDates] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [voidAcknowledged, setVoidAcknowledged] = useState(false);
  const [detail, setDetail] = useState<TicketManagementDetail | null>(null);
  const [actionsWithRequests, setActionsWithRequests] = useState<Set<TicketManagementAction>>(
    () => new Set(),
  );
  const [creatingAnother, setCreatingAnother] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const showFeedback = useStatusFeedback();
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [decisionKey, setDecisionKey] = useState<string | null>(null);
  const [passengerAvailability, setPassengerAvailability] = useState<
    TicketManagementAvailability["passengers"]
  >([]);
  const [voidWindowOpen, setVoidWindowOpen] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    const syncVoidWindow = () => {
      if (cancelled) return;
      const now = new Date();
      setVoidWindowOpen(isTicketVoidRequestOpen(issuedAt, now));

      const issuedTime = issuedAt ? Date.parse(issuedAt) : Number.NaN;
      const deadlineTime = ticketVoidRequestDeadline(issuedAt)?.getTime();
      const nextTransition = [issuedTime, deadlineTime]
        .filter((value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > now.getTime()
        )
        .sort((left, right) => left - right)[0];

      if (nextTransition !== undefined) {
        timer = window.setTimeout(syncVoidWindow, nextTransition - now.getTime() + 50);
      }
    };

    syncVoidWindow();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [issuedAt]);

  useEffect(() => {
    if (voidWindowOpen || openAction !== "void") return;
    setOpenAction(null);
    setDetail(null);
    setCreatingAnother(false);
    setVoidAcknowledged(false);
    setMessage(null);
  }, [openAction, voidWindowOpen]);

  const availabilityByPassenger = useMemo(
    () => new Map(passengerAvailability.map((item) => [item.passengerIndex, item])),
    [passengerAvailability],
  );
  const availablePassengerOptions = useMemo(
    () => passengerOptions.filter((passenger) =>
      availabilityByPassenger.get(passenger.index)?.available !== false
    ),
    [availabilityByPassenger, passengerOptions],
  );

  const allSelected = availablePassengerOptions.length > 0 &&
    selectedPassengers.length === availablePassengerOptions.length &&
    availablePassengerOptions.every((passenger) =>
      selectedPassengers.includes(passenger.index)
    );
  const allRoutesSelected = routes.length > 0 &&
    selectedRoutes.length === routes.length &&
    routes.every((route) => selectedRoutes.includes(route.index));
  const formReady = selectedPassengers.length > 0 && selectedRoutes.length > 0 &&
    (openAction !== "reissue" ||
      routes
        .filter((route) => selectedRoutes.includes(route.index))
        .every((route) => Boolean(requestedDates[route.id]))) &&
    (openAction !== "void" || voidAcknowledged);
  const showCreateForm = allowOwnerActions &&
    (!detail || (hasFinalOutcome(detail) && creatingAnother));

  const loadAvailability = useCallback(async (resetSelection = false) => {
    try {
      const result = await ticketManagementFetch<TicketManagementAvailability>(
        `/api/ticket-management/availability?bookingReference=${encodeURIComponent(bookingReference)}`,
      );
      setPassengerAvailability(result.passengers);
      const unavailable = new Set(
        result.passengers
          .filter((item) => !item.available)
          .map((item) => item.passengerIndex),
      );
      const availableIndexes = passengerOptions
        .map((passenger) => passenger.index)
        .filter((passengerIndex) => !unavailable.has(passengerIndex));
      setSelectedPassengers((current) => resetSelection
        ? availableIndexes
        : current.filter((passengerIndex) => !unavailable.has(passengerIndex))
      );
    } catch {
      // The create RPC remains the final authority if this read-only hint is
      // temporarily unavailable.
    }
  }, [bookingReference, passengerOptions]);

  useEffect(() => {
    let cancelled = false;
    void ticketManagementFetch<TicketManagementListItem[]>(
      `/api/ticket-management?bookingReference=${encodeURIComponent(bookingReference)}&limit=100`,
    )
      .then((list) => {
        if (cancelled) return;
        setActionsWithRequests(new Set(
          list
            .filter((item) => item.bookingReference === bookingReference)
            .map((item) => item.action),
        ));
      })
      .catch(() => {
        // The action remains usable as a first-time request even when the
        // lightweight existing-request indicator cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [bookingReference]);

  useEffect(() => {
    void loadAvailability(true);
  }, [loadAvailability]);

  async function loadLatest(action: TicketManagementAction) {
    setLoading(true);
    setMessage(null);
    try {
      const list = await ticketManagementFetch<TicketManagementListItem[]>(
        `/api/ticket-management?bookingReference=${encodeURIComponent(bookingReference)}&action=${action}&limit=100`,
      );
      const match = list.find((item) => item.bookingReference === bookingReference);
      if (!match) {
        setActionsWithRequests((current) => {
          const next = new Set(current);
          next.delete(action);
          return next;
        });
        setDetail(null);
        setCreatingAnother(false);
        return;
      }
      setActionsWithRequests((current) => new Set(current).add(action));
      setDetail(await ticketManagementFetch<TicketManagementDetail>(
        `/api/ticket-management/${encodeURIComponent(match.id)}`,
      ));
      setCreatingAnother(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Requests could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  function toggleAction(action: TicketManagementAction) {
    const next = openAction === action ? null : action;
    setOpenAction(next);
    setMessage(null);
    setSelectedPassengers(availablePassengerOptions.map((passenger) => passenger.index));
    setSelectedRoutes(routes.map((route) => route.index));
    if (next) {
      void loadLatest(next);
      void loadAvailability(true);
    }
  }

  function resetSubmissionIdentity() {
    setSubmissionKey(null);
    setMessage(null);
  }

  function togglePassenger(index: number, checked: boolean) {
    setSelectedPassengers((current) => checked
      ? Array.from(new Set([...current, index])).sort((a, b) => a - b)
      : current.filter((item) => item !== index));
    resetSubmissionIdentity();
  }

  function toggleRoute(index: number, checked: boolean) {
    setSelectedRoutes((current) => checked
      ? Array.from(new Set([...current, index])).sort((a, b) => a - b)
      : current.filter((item) => item !== index));
    resetSubmissionIdentity();
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openAction || !formReady || submitting) return;
    const key = submissionKey ?? crypto.randomUUID();
    setSubmissionKey(key);
    setSubmitting(true);
    setMessage(null);
    const lines = [`Request type: ${requestType}`];
    if (openAction === "reissue") {
      for (const route of routes.filter((candidate) => selectedRoutes.includes(candidate.index))) {
        lines.push(`${route.label} ${route.route}: preferred ${requestedDates[route.id]}`);
      }
    }
    if (note.trim()) lines.push(note.trim());
    try {
      const created = await ticketManagementFetch<{ requestId: string }>(
        "/api/ticket-management",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingReference,
            action: openAction,
            requestType,
            requestId: key,
            passengerIndexes: selectedPassengers,
            routeIndexes: selectedRoutes,
            note: lines.join("\n") || null,
          }),
        },
      );
      setSubmissionKey(null);
      showFeedback({ title: `${openAction === 'refund' ? 'Refund' : openAction === 'reissue' ? 'Reissue' : 'Void'} Requested`, description: 'Your request has been received. Track its progress in Manage Bookings.', tone: 'progress', reference: bookingReference });
      setDetail(await ticketManagementFetch<TicketManagementDetail>(
        `/api/ticket-management/${encodeURIComponent(created.requestId)}`,
      ));
      setActionsWithRequests((current) => new Set(current).add(openAction));
      setCreatingAnother(false);
      setMessage(`${ACTIONS.find((item) => item.value === openAction)?.label} request submitted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function decide(decision: "approved" | "rejected") {
    if (!detail || submitting) return;
    const quote = latestQuote(detail);
    if (!quote) return;
    const key = decisionKey ?? crypto.randomUUID();
    setDecisionKey(key);
    setSubmitting(true);
    setMessage(null);
    try {
      await ticketManagementFetch(
        `/api/ticket-management/${encodeURIComponent(detail.id)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "customer-decision",
            quoteId: quote.id,
            decision,
            expectedVersion: detail.version,
            requestKey: key,
            note: null,
          }),
        },
      );
      setDecisionKey(null);
      showFeedback({ title: decision === 'approved' ? 'Quotation Approved' : 'Quotation Rejected', description: decision === 'approved' ? 'Your approval has been saved. The request is ready for further processing.' : 'Your decision has been saved.', tone: decision === 'approved' ? 'progress' : 'neutral', reference: bookingReference });
      setDetail(await ticketManagementFetch<TicketManagementDetail>(
        `/api/ticket-management/${encodeURIComponent(detail.id)}`,
      ));
      await loadAvailability(true);
      setMessage(decision === "approved" ? "Quotation approved." : "Quotation rejected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The decision could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {ACTIONS.filter((item) =>
        allowedActions.includes(item.value) &&
        (item.value !== "void" || voidWindowOpen)
      ).map((item) => {
        const Icon = item.icon;
        const expanded = openAction === item.value;
        const hasExistingRequest = actionsWithRequests.has(item.value);
        const panelId = `post-ticket-${item.value}-panel`;
        const quote = detail ? latestQuote(detail) : null;
        return (
          <div key={item.value} className="px-4 pb-2">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => toggleAction(item.value)}
              className={quickActionButtonClass}
            >
              <Icon className="h-4 w-4 text-brand-orange" aria-hidden />
              {item.label}
              {hasExistingRequest && (
                expanded
                  ? <ChevronUp className="h-3.5 w-3.5 text-neutral-500" aria-hidden />
                  : <ChevronDown className="h-3.5 w-3.5 text-neutral-500" aria-hidden />
              )}
            </button>

            {expanded && (
              <div id={panelId} className="mt-2 space-y-2.5 rounded-md border border-white/15 bg-white/10 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white">{item.label} request</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-white/65">{item.description}</p>
                  </div>
                  {detail && !showCreateForm && (
                    <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white">
                      {formatTicketManagementRequestStatus(detail.status)}
                    </span>
                  )}
                </div>

                {loading ? (
                  <p className="flex items-center gap-2 rounded-md bg-white p-3 text-xs text-navy-950">
                    <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden /> Loading request…
                  </p>
                ) : detail && !showCreateForm ? (
                  <div className="space-y-2">
                    <RequestTimeline
                      detail={detail}
                      quote={quote}
                      allowOwnerActions={allowOwnerActions}
                      submitting={submitting}
                      onDecision={(decision) => void decide(decision)}
                    />
                    {allowOwnerActions && hasFinalOutcome(detail) && (
                      <button type="button" onClick={() => setCreatingAnother(true)} className="w-full rounded-md bg-white px-3 py-2 text-xs font-semibold text-navy-950">Start another {item.label} request</button>
                    )}
                  </div>
                ) : showCreateForm ? (
                  <form onSubmit={submitRequest} className="space-y-2.5">
                    <section className={sectionCardClass}>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-navy-950">{item.value === "refund" ? "Refund type" : item.value === "reissue" ? "Reissue type" : "VOID type"}</p>
                        <RadioGroup value={requestType} onValueChange={(value) => { setRequestType(value as typeof requestType); resetSubmissionIdentity(); }} className="mt-1.5 grid grid-cols-2 gap-1.5">
                          {(["voluntary", "involuntary"] as const).map((value) => (
                            <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md border border-navy-950/10 bg-navy-50/60 px-2 py-2">
                              <RadioGroupItem value={value} className="border-brand-orange text-brand-orange" />
                              <span className="text-[11px] font-semibold capitalize text-navy-950">{value}</span>
                            </label>
                          ))}
                        </RadioGroup>
                    </section>
                    <section className={sectionCardClass}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-navy-950"><Users className="h-3.5 w-3.5 text-brand-orange" aria-hidden />Passengers</p>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] font-semibold text-navy-700">
                          <Checkbox checked={allSelected} disabled={availablePassengerOptions.length === 0} onCheckedChange={(checked) => { setSelectedPassengers(checked === true ? availablePassengerOptions.map((passenger) => passenger.index) : []); resetSubmissionIdentity(); }} className="h-3.5 w-3.5 border-brand-orange data-[state=checked]:bg-brand-orange data-[state=checked]:text-black" /> Select all
                        </label>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {passengerOptions.map((passenger) => {
                          const availability = availabilityByPassenger.get(passenger.index);
                          const unavailable = availability?.available === false;
                          return (
                            <label key={passenger.index} className={`flex items-start gap-2 rounded-md border border-navy-950/10 px-2 py-2 text-xs font-medium text-navy-950 ${unavailable ? "cursor-not-allowed bg-neutral-100 opacity-75" : "cursor-pointer bg-navy-50/60"}`}>
                              <Checkbox disabled={unavailable} checked={!unavailable && selectedPassengers.includes(passenger.index)} onCheckedChange={(checked) => togglePassenger(passenger.index, checked === true)} className="mt-0.5 h-3.5 w-3.5 border-brand-orange data-[state=checked]:bg-brand-orange data-[state=checked]:text-black" />
                              <span className="min-w-0"><span className="block truncate">{passenger.label}</span>{unavailable && availability.message && <span className="mt-0.5 block text-[9px] font-normal leading-3.5 text-brand-orange-dark">{availability.message}</span>}</span>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                    <section className={sectionCardClass}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-navy-950"><Plane className="h-3.5 w-3.5 text-brand-orange" aria-hidden />Routes</p>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] font-semibold text-navy-700">
                          <Checkbox checked={allRoutesSelected} disabled={routes.length === 0} onCheckedChange={(checked) => { setSelectedRoutes(checked === true ? routes.map((route) => route.index) : []); resetSubmissionIdentity(); }} className="h-3.5 w-3.5 border-brand-orange data-[state=checked]:bg-brand-orange data-[state=checked]:text-black" /> Select all
                        </label>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {routes.map((route) => {
                          const selected = selectedRoutes.includes(route.index);
                          return (
                            <div key={route.id} className="rounded-md border border-navy-950/10 bg-navy-50/60 p-2">
                              <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-navy-950">
                                <Checkbox checked={selected} onCheckedChange={(checked) => toggleRoute(route.index, checked === true)} className="mt-0.5 h-3.5 w-3.5 border-brand-orange data-[state=checked]:bg-brand-orange data-[state=checked]:text-black" />
                                <span><span className="block">{route.label}: {route.route}</span><span className="mt-0.5 block text-[9px] font-normal text-neutral-500">Current: {formatDate(route.currentDate)}</span></span>
                              </label>
                              {item.value === "reissue" && selected && (
                                <label className="mt-2 block text-[9px] font-semibold uppercase tracking-wide text-neutral-500">
                                  Preferred new date
                                  <input type="date" required value={requestedDates[route.id] ?? ""} onChange={(event) => { setRequestedDates((current) => ({ ...current, [route.id]: event.target.value })); resetSubmissionIdentity(); }} className="mt-1 h-9 w-full rounded-md border border-navy-950/15 bg-white px-2 text-xs font-medium text-navy-950 outline-none focus:border-brand-orange" />
                                </label>
                              )}
                            </div>
                          );
                        })}
                        {routes.length === 0 && <p className="text-[10px] text-brand-orange-dark">Route information is unavailable for this booking.</p>}
                      </div>
                    </section>
                    {item.value === "void" && (
                      <section className={sectionCardClass}>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-navy-950">VOID eligibility</p>
                        <p className="mt-1 text-[10px] text-neutral-600">Ticket issued: {formatDate(issuedAt, true)}</p>
                        <p className="mt-1 text-[10px] text-neutral-600">Available until 23:30 Bangladesh time on the issue date.</p>
                        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md bg-navy-50 p-2">
                          <Checkbox checked={voidAcknowledged} onCheckedChange={(checked) => { setVoidAcknowledged(checked === true); resetSubmissionIdentity(); }} className="mt-0.5 h-3.5 w-3.5 border-brand-orange data-[state=checked]:bg-brand-orange data-[state=checked]:text-black" />
                          <span className="text-[9px] leading-3.5 text-neutral-600">I understand that staff must manually confirm airline/supplier VOID eligibility.</span>
                        </label>
                      </section>
                    )}
                    <label className={sectionCardClass + " block"}>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-navy-950">Note <span className="font-medium text-neutral-400">(optional)</span></span>
                      <textarea value={note} onChange={(event) => { setNote(event.target.value); resetSubmissionIdentity(); }} maxLength={500} rows={2} placeholder="Add information for the support team." className="mt-1.5 w-full resize-none rounded-md border border-navy-950/15 bg-navy-50/40 px-2 py-2 text-xs text-navy-950 outline-none focus:border-brand-orange" />
                    </label>
                    <button type="submit" disabled={!formReady || submitting} className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-orange px-3 py-2.5 text-xs font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-50">
                      {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Submit {item.label} Request
                    </button>
                  </form>
                ) : (
                  <section className={sectionCardClass}>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-navy-950">
                      No customer request
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-neutral-600">
                      The booking owner must submit this request. Staff can review,
                      quote, assign, and settle it from the Manage tab after it arrives.
                    </p>
                  </section>
                )}
                {message && <p role="status" className="rounded-md border border-white/15 bg-white/10 p-2 text-[10px] leading-4 text-white/85">{message}</p>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
