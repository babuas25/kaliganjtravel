'use client';

import { useStatusFeedback } from '@/components/feedback/StatusFeedback';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  Loader2,
  Mail,
  MessageSquareText,
  RefreshCw,
  Send,
  Share2,
  Ticket,
  Wallet,
  XCircle,
  Zap,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { BookingStatus } from '@/lib/flights/booking-status';
import type { LocalTimeLimitContext } from '@/lib/booking-lifecycle/local-time-limit';
import type { TicketManagementAction } from '@/lib/ticket-management/types';
import PostTicketActionsPreview, {
  type PostTicketRouteOption,
} from '@/components/flights/PostTicketActionsPreview';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

const buttonClass =
  'flex w-full items-center justify-center gap-2 rounded-md bg-white px-3 py-2.5 text-sm font-semibold text-navy-950 transition disabled:cursor-not-allowed disabled:opacity-60';

const IMPORTED_MANUAL_TICKETING_MESSAGE =
  'User Payable is held; ticketing is being completed.';

type IssuePreview = {
  wallet: {
    availableBalance: number;
    holdBalance: number;
    currency: string;
    status: 'active' | 'frozen';
  };
  requiredAmount: number;
  paymentState: string;
};

type IssueActionStatus = {
  lifecycleStatus: BookingStatus;
  paymentState: string;
  operationState: string | null;
  openReconciliationCase?: boolean;
  reconciliationRequired: boolean;
  /** Only this explicit server signal may unlock a new Issue POST. */
  canSubmit: boolean;
  wallet: IssuePreview['wallet'] | null;
  requiredAmount: number;
};

type IssueResponseEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: {
    errorCode?: string;
    errorMessage?: string;
  };
};

type IssueRequestError = Error & { code?: string };

type SmsPreview = {
  message: string;
  recipientNumber: string;
  senderId: string;
  sentCount: number;
  maxSends: number;
  remainingSends: number;
  canSend: boolean;
};

const ISSUE_POST_TIMEOUT_MS = 130_000;
const ISSUE_STATUS_TIMEOUT_MS = 15_000;
// Supplier deadlines normally propagate within 5–15 seconds of Book. Check
// that early window first, retaining the slower fallback for delayed records.
// Requests run sequentially and stop as soon as a stored deadline is available.
const DEADLINE_AUTO_REFRESH_DELAYS_MS = [
  5_000,
  10_000,
  15_000,
  30_000,
  45_000,
  120_000,
  240_000,
  360_000,
] as const;
const CHECKING_TICKETING_RESULT_MESSAGE =
  'Checking ticketing result / Needs Reconciliation — do not submit again.';

function clearCreatedBookingMarker(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get('created') !== '1') return;
  url.searchParams.delete('created');
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`
  );
}

// These responses mean that the supplier write may have happened, or another
// active operation already owns the booking. They must never leave the client
// able to submit another NewTicket request while the server catches up.
const ISSUE_RECONCILIATION_CODES = new Set([
  'ISSUE_OUTCOME_UNKNOWN',
  'SUPPLIER_BALANCE_RECONCILIATION_REQUIRED',
  'PAYMENT_RECONCILIATION_REQUIRED',
  'WALLET_RESERVATION_UNKNOWN',
  'RECONCILIATION_REQUIRED',
  'OPERATION_ALREADY_ACTIVE',
  'ISSUE_IN_PROGRESS',
  'OPERATION_IN_PROGRESS',
  'SUPPLIER_CALL_ALREADY_STARTED',
  'HOLD_RELEASE_FAILED',
]);

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) throw new Error('The ticketing response was empty.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('The ticketing response was malformed.');
  }
}

function issueRequestError(
  message: string,
  code?: string
): IssueRequestError {
  const error = new Error(message) as IssueRequestError;
  error.code = code;
  return error;
}

type ImportedTicketVerification = {
  caseId: string;
  observationId: string;
  replay: boolean;
  validation: {
    valid: boolean;
    complete: boolean;
    fresh: boolean;
    identityMatches: boolean;
    authoritativeFor: 'ticketed' | null;
    issueCodes: string[];
  };
  outcome: {
    classification:
      | 'ticketed'
      | 'held'
      | 'cancelled'
      | 'expired'
      | 'unconfirmed'
      | 'conflicting';
    authoritative: boolean;
    reasonCode: string;
    requiredAction:
      | 'complete_ticketing'
      | 'continue_supplier_follow_up'
      | 'financial_disposition_required'
      | 'admin_review_required';
    operationState: 'awaiting_external_action' | 'needs_reconciliation';
    caseState: 'assigned' | 'awaiting_supplier' | 'awaiting_finance';
    assignedTeam: 'support' | 'accounts' | 'admin';
    financialDisposition: string;
    financialDispositionRequired: boolean;
  };
  statusMutation: false;
  walletMutation: false;
};

function importedOutcomeMessage(
  verification: ImportedTicketVerification | null | undefined,
): string {
  if (!verification) {
    return 'Imported booking synced. No wallet charge was made.';
  }
  switch (verification.outcome.classification) {
    case 'ticketed':
      return 'Fresh matching ticket evidence verified. Complete the ticket below; no additional wallet debit will be made.';
    case 'held':
      return 'The supplier booking is still held. Support follow-up remains open; the captured payment was not changed.';
    case 'cancelled':
      return 'The supplier reports this booking as cancelled. Captured funds remain visible and the case is routed to Accounts for an explicit refund or settlement disposition.';
    case 'expired':
      return 'The supplier reports this booking as expired. Captured funds remain visible and the case is routed to Accounts for an explicit refund or settlement disposition.';
    case 'unconfirmed':
      return 'The supplier reports this booking as unconfirmed. Captured funds remain visible and the case is routed to Accounts for an explicit refund or settlement disposition.';
    case 'conflicting':
      return 'Supplier evidence conflicts with the booking identity or ticket details. The operation is in reconciliation and assigned to Admin; no wallet change was made.';
  }
}

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/** Wallet-backed quick actions for a held booking. */
export default function BookingActions({
  status,
  statusMessage,
  directTicketing,
  allowCancellation,
  bookingReference,
  passengerCopies,
  postTicketRoutes = [],
  ticketIssuedAt = null,
  showPostTicketActions = false,
  allowPostTicketOwnerActions = false,
  allowedPostTicketActions = [],
  allowSupplierRefresh = false,
  autoRefreshDeadline = false,
  allowTicketing = true,
  issuingForAssignedOwner = false,
  allowImportedConfirmation = false,
  allowImportedSync = false,
  importedBooking = false,
  manualBooking = false,
  paymentState,
  ticketingDeadlineAt = null,
  localTimeLimit = null,
  allowLocalTimeLimitRequest = false,
  allowSmsShare = false,
  children,
}: {
  status: BookingStatus;
  statusMessage?: string | null;
  directTicketing: boolean;
  allowCancellation: boolean;
  bookingReference: string;
  passengerCopies: Array<{
    index: number;
    label: string;
    fileName: string;
    hasFare: boolean;
  }>;
  postTicketRoutes?: PostTicketRouteOption[];
  ticketIssuedAt?: string | null;
  showPostTicketActions?: boolean;
  allowPostTicketOwnerActions?: boolean;
  allowedPostTicketActions?: readonly TicketManagementAction[];
  allowSupplierRefresh?: boolean;
  autoRefreshDeadline?: boolean;
  allowTicketing?: boolean;
  issuingForAssignedOwner?: boolean;
  allowImportedConfirmation?: boolean;
  allowImportedSync?: boolean;
  importedBooking?: boolean;
  manualBooking?: boolean;
  paymentState: string;
  ticketingDeadlineAt?: string | null;
  localTimeLimit?: LocalTimeLimitContext | null;
  allowLocalTimeLimitRequest?: boolean;
  allowSmsShare?: boolean;
  children?: ReactNode;
}) {
  const ticketed = status === 'confirmed';
  const cancelled = status === 'cancelled';
  const requestOnly = Boolean(
    !importedBooking &&
      localTimeLimit?.featureAvailable &&
      localTimeLimit.requestRequired
  );
  const importedConfirmEligible = allowImportedConfirmation && status === 'on-hold';
  const issueEligible = importedConfirmEligible ||
    (!requestOnly && allowTicketing && (status === 'on-hold' || status === 'pending'));
  const cancellable =
    allowCancellation && status === 'on-hold' && !directTicketing;
  const router = useRouter();
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [loading, setLoading] = useState(issueEligible);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [requestingTimeLimit, setRequestingTimeLimit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [completingImported, setCompletingImported] = useState(false);
  const [syncRequestId, setSyncRequestId] = useState<string | null>(null);
  const [completionRequestId, setCompletionRequestId] = useState<string | null>(null);
  const [importedVerification, setImportedVerification] =
    useState<ImportedTicketVerification | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const showFeedback = useStatusFeedback();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('created') !== '1') return;
    showFeedback({
      title: status === 'confirmed' ? 'Booking Confirmed' : 'Booking Successful',
      description: status === 'confirmed'
        ? 'Your ticket has been issued. Your booking details are ready to view.'
        : 'Your booking has been created. Check the booking status and ticketing deadline for the next step.',
      reference: bookingReference,
      onceKey: `created:${bookingReference}`,
    });
  }, [bookingReference, showFeedback, status]);

  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  const [printWithFare, setPrintWithFare] = useState<boolean | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [sharing, setSharing] = useState(false);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsPreview, setSmsPreview] = useState<SmsPreview | null>(null);
  const [smsRecipientNumber, setSmsRecipientNumber] = useState('');
  const [smsMessage, setSmsMessage] = useState('');
  const [smsLoading, setSmsLoading] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const smsRequestId = useRef<string | null>(null);
  const [issueActionStatus, setIssueActionStatus] =
    useState<IssueActionStatus | null>(null);
  const [checkingTicketingResult, setCheckingTicketingResult] =
    useState(false);
  const [refreshingIssueState, setRefreshingIssueState] = useState(false);
  const supplierRefreshInFlight = useRef(false);
  const completedDeadlineRefresh = useRef<string | null>(null);
  const useIssueStatus = !importedBooking && !manualBooking;

  const refreshIssueStatus = useCallback(async (signal?: AbortSignal) => {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ISSUE_STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(
        `/api/flights/booking/issue/status?reference=${encodeURIComponent(bookingReference)}`,
        { cache: 'no-store', signal: controller.signal }
      );
      const body = await responseJson<IssueResponseEnvelope<IssueActionStatus>>(
        response
      );
      if (!response.ok || !body.success || !body.data) {
        throw issueRequestError(
          body.error?.errorMessage || 'Ticketing status is unavailable.',
          body.error?.errorCode
        );
      }

      const nextStatus = body.data;
      const needsReconciliation =
        nextStatus.reconciliationRequired ||
        Boolean(nextStatus.operationState) ||
        nextStatus.openReconciliationCase === true;
      setIssueActionStatus(nextStatus);
      setPreview(
        nextStatus.wallet
          ? {
              wallet: nextStatus.wallet,
              requiredAmount: nextStatus.requiredAmount,
              paymentState: nextStatus.paymentState,
            }
          : null
      );
      setCheckingTicketingResult(needsReconciliation);
      if (needsReconciliation) {
        setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
      }
      return nextStatus;
    } catch (error) {
      if (timedOut) {
        throw issueRequestError(
          'Ticketing status timed out. Do not submit again until it refreshes.',
          'ISSUE_STATUS_TIMEOUT'
        );
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }, [bookingReference]);

  useEffect(() => {
    const controller = new AbortController();

    if (useIssueStatus) {
      setLoading(true);
      void refreshIssueStatus(controller.signal)
        .catch((error) => {
          if ((error as Error).name === 'AbortError') return;
          setIssueActionStatus(null);
          setPreview(null);
          setCheckingTicketingResult(true);
          setMessage(
            error instanceof Error && error.message
              ? `${CHECKING_TICKETING_RESULT_MESSAGE} ${error.message}`
              : CHECKING_TICKETING_RESULT_MESSAGE
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
      return () => controller.abort();
    }

    if (!issueEligible) {
      setLoading(false);
      setPreview(null);
      return () => controller.abort();
    }

    fetch(
      `${importedConfirmEligible ? '/api/impexp/confirm-booking' : '/api/flights/booking/issue'}?reference=${encodeURIComponent(bookingReference)}`,
      { cache: 'no-store', signal: controller.signal }
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          success?: boolean;
          data?: IssuePreview;
          error?: { errorMessage?: string };
        };
        if (!response.ok || !body.success || !body.data) {
          throw new Error(
            body.error?.errorMessage || 'Wallet balance is unavailable.'
          );
        }
        setPreview(body.data);
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Wallet balance is unavailable.'
          );
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [
    bookingReference,
    importedConfirmEligible,
    issueEligible,
    refreshIssueStatus,
    useIssueStatus,
  ]);

  const insufficient =
    preview !== null &&
    preview.wallet.availableBalance < preview.requiredAmount;
  const frozen = preview?.wallet.status === 'frozen';
  // The SSR booking props can be one action behind a supplier write. For
  // normal Triplover ticketing, only a fresh read-only server response may
  // unlock another Issue POST.
  const serverCanSubmit = importedConfirmEligible ||
    issueActionStatus?.canSubmit === true;
  const reconciliationActive =
    checkingTicketingResult ||
    issueActionStatus?.reconciliationRequired === true ||
    Boolean(issueActionStatus?.operationState);
  const issueInteractionLocked =
    issuing ||
    cancelling ||
    refreshingIssueState ||
    reconciliationActive ||
    !serverCanSubmit;
  // Cancellation is independent from Issue Ticket's wallet preview and
  // available-balance gate. The API claim remains the authoritative race
  // guard when another booking operation is already active.
  const cancelInteractionLocked =
    issuing ||
    cancelling ||
    issueActionStatus?.reconciliationRequired === true ||
    Boolean(issueActionStatus?.operationState);

  async function issue() {
    if (issuing || cancelling) return;
    if (!serverCanSubmit) {
      setCheckingTicketingResult(true);
      setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
      setRefreshingIssueState(true);
      setLoading(true);
      setPreview(null);
      router.refresh();
      try {
        await refreshIssueStatus();
      } catch {
        setCheckingTicketingResult(true);
        setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
      } finally {
        setRefreshingIssueState(false);
        setLoading(false);
      }
      return;
    }

    setIssuing(true);
    setMessage(null);
    setCheckingTicketingResult(false);
    let postError: IssueRequestError | null = null;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      ISSUE_POST_TIMEOUT_MS
    );
    try {
      const response = await fetch(
        importedConfirmEligible
          ? '/api/impexp/confirm-booking'
          : '/api/flights/booking/issue',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookingReference,
            requestId: crypto.randomUUID(),
          }),
          signal: controller.signal,
        }
      );
      const body = await responseJson<IssueResponseEnvelope<unknown>>(response);
      if (!response.ok || !body.success) {
        throw issueRequestError(
          body.error?.errorMessage ||
            (importedConfirmEligible
              ? 'Imported booking Issue Now failed.'
              : 'Ticket issuance failed.'),
          body.error?.errorCode
        );
      }
      setMessage(
        importedConfirmEligible
          ? IMPORTED_MANUAL_TICKETING_MESSAGE
          : 'Ticket issued and wallet payment confirmed.'
      );
      showFeedback({
        title: importedConfirmEligible ? 'Ticketing In Progress' : 'Booking Confirmed',
        description: importedConfirmEligible ? 'Your request has been received. Our team is completing ticket issuance.' : 'Your ticket has been issued and the wallet payment is confirmed.',
        tone: importedConfirmEligible ? 'progress' : 'success',
        reference: bookingReference,
      });
    } catch (error) {
      const typedError = error as IssueRequestError;
      postError = typedError;
      // A network abort, a malformed response, or an unknown error can happen
      // after the server accepted the non-retryable supplier write. Lock first,
      // then ask the read-only status endpoint what actually happened.
      if (
        !importedConfirmEligible &&
        (!typedError.code || ISSUE_RECONCILIATION_CODES.has(typedError.code))
      ) {
        setCheckingTicketingResult(true);
        setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
      } else {
        setMessage(
          error instanceof Error
            ? error.message
            : importedConfirmEligible
              ? 'Imported booking Issue Now failed.'
              : 'Ticket issuance failed.'
        );
      }
    } finally {
      window.clearTimeout(timeout);
      setIssuing(false);
      setRefreshingIssueState(true);
      setLoading(true);
      setPreview(null);
      // Refresh both the server-rendered booking and the independent wallet /
      // operation snapshot on every outcome, including errors and disconnects.
      router.refresh();
      try {
        if (useIssueStatus) {
          const refreshed = await refreshIssueStatus();
          if (refreshed.reconciliationRequired || refreshed.operationState) {
            setCheckingTicketingResult(true);
            setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
          } else if (postError && !refreshed.canSubmit) {
            // The POST gave a definite response, but the state is still not
            // ready. Keep the UI fail-closed until the server says otherwise.
            setCheckingTicketingResult(true);
          }
        }
      } catch {
        if (!importedConfirmEligible) {
          setCheckingTicketingResult(true);
          setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
        }
      } finally {
        setRefreshingIssueState(false);
        setLoading(false);
      }
    }
  }

  async function cancel() {
    if (cancelInteractionLocked) {
      setMessage(CHECKING_TICKETING_RESULT_MESSAGE);
      return;
    }
    setCancelling(true);
    setMessage(null);
    try {
      const response = await fetch('/api/flights/booking/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference,
          requestId: crypto.randomUUID(),
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(body.error?.errorMessage || 'Booking cancellation failed.');
      }
      setMessage('Booking cancelled. No wallet balance was required.');
      showFeedback({ title: 'Booking Cancelled', description: 'Your booking has been cancelled successfully.', tone: 'neutral', reference: bookingReference });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Booking cancellation failed.');
    } finally {
      setCancelling(false);
    }
  }

  function recharge() {
    const returnTo = `/dashboard/bookings/${bookingReference}`;
    window.location.assign(
      `/dashboard/deposits?returnTo=${encodeURIComponent(returnTo)}`
    );
  }

  const refreshSupplierDetails = useCallback(async (
    automatic = false
  ): Promise<boolean> => {
    if (supplierRefreshInFlight.current) return false;
    supplierRefreshInFlight.current = true;
    const retryIdentity = syncRequestId ?? crypto.randomUUID();
    if (allowImportedSync) setSyncRequestId(retryIdentity);
    setRefreshing(true);
    if (!automatic) setMessage(null);
    try {
      const response = await fetch(
        automatic
          ? '/api/flights/booking/refresh-deadline'
          : allowImportedSync
          ? '/api/impexp/sync-booking'
          : '/api/flights/booking/refresh-details',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookingReference,
            ...(allowImportedSync ? { requestId: retryIdentity } : {}),
          }),
        }
      );
      const body = (await response.json()) as {
        success?: boolean;
        data?: { ticketingDeadlineAt?: string | null; complete?: boolean };
        error?: string | { errorMessage?: string };
        verification?: ImportedTicketVerification | null;
      };
      if (!response.ok || !body.success) {
        throw new Error(
          (typeof body.error === 'string'
            ? body.error
            : body.error?.errorMessage) ||
            (allowImportedSync
              ? 'Imported booking Sync failed.'
              : 'Ticket details refresh failed.')
        );
      }
      if (allowImportedSync) {
        setSyncRequestId(null);
        setImportedVerification(body.verification ?? null);
      }
      if (!automatic) {
        setMessage(
          allowImportedSync
            ? importedOutcomeMessage(body.verification)
            : 'Ticket details refreshed from AirTicketingDetails.'
        );
      }
      // An automatic refresh owns a timed retry sequence. Refreshing the
      // Server Component here can clean up that effect after its first call,
      // silently cancelling the remaining attempts. The effect refreshes the
      // page once after it finds a deadline or exhausts the complete window.
      if (
        !automatic &&
        body.verification?.validation.authoritativeFor !== 'ticketed'
      ) {
        router.refresh();
      }
      return Boolean(body.data?.ticketingDeadlineAt) || body.data?.complete === true;
    } catch (error) {
      if (!automatic) {
        setMessage(
          error instanceof Error
            ? error.message
            : allowImportedSync
              ? 'Imported booking Sync failed.'
              : 'Ticket details refresh failed.'
        );
      }
      return false;
    } finally {
      supplierRefreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [allowImportedSync, bookingReference, router, syncRequestId]);

  useEffect(() => {
    if (
      !autoRefreshDeadline ||
      manualBooking ||
      allowImportedSync ||
      completedDeadlineRefresh.current === bookingReference
    ) return;

    const refreshableStatus =
      status === 'on-hold' || status === 'unconfirmed' || status === 'pending';
    if (!refreshableStatus || ticketingDeadlineAt) {
      clearCreatedBookingMarker();
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const waitUntil = (targetMs: number) =>
      new Promise<void>((resolve) => {
        const remaining = Math.max(0, targetMs - (Date.now() - startedAt));
        timer = window.setTimeout(resolve, remaining);
      });

    void (async () => {
      for (const delayMs of DEADLINE_AUTO_REFRESH_DELAYS_MS) {
        await waitUntil(delayMs);
        if (cancelled) return;
        const deadlineAvailable = await refreshSupplierDetails(true);
        if (cancelled) return;
        if (deadlineAvailable) {
          completedDeadlineRefresh.current = bookingReference;
          clearCreatedBookingMarker();
          router.refresh();
          return;
        }
      }
      completedDeadlineRefresh.current = bookingReference;
      clearCreatedBookingMarker();
      router.refresh();
    })();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    allowImportedSync,
    manualBooking,
    autoRefreshDeadline,
    bookingReference,
    refreshSupplierDetails,
    router,
    status,
    ticketingDeadlineAt,
  ]);

  async function requestTimeLimit() {
    if (!allowLocalTimeLimitRequest || requestingTimeLimit) return;
    setRequestingTimeLimit(true);
    setMessage(null);
    try {
      const response = await fetch('/api/flights/booking/time-limit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference,
          requestId: crypto.randomUUID(),
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(body.error?.errorMessage ?? 'The time-limit request failed.');
      }
      setMessage('Time-limit request sent for staff verification.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The time-limit request failed.');
    } finally {
      setRequestingTimeLimit(false);
    }
  }

  async function shareConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sharing || !shareEmail.trim()) return;
    setSharing(true);
    setMessage(null);
    try {
      const response = await fetch('/api/flights/booking/share-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference,
          email: shareEmail.trim(),
        }),
      });
      const body = await responseJson<IssueResponseEnvelope<{ delivered: boolean }>>(
        response
      );
      if (!response.ok || !body.success || !body.data?.delivered) {
        throw new Error(
          body.error?.errorMessage || 'The confirmation email could not be delivered.'
        );
      }
      setMessage(`Confirmation email sent to ${shareEmail.trim().toLowerCase()}.`);
      setShareEmail('');
      setShareOpen(false);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The confirmation email could not be delivered.'
      );
    } finally {
      setSharing(false);
    }
  }

  async function loadSmsPreview(): Promise<void> {
    if (smsLoading || smsSending) return;
    setSmsLoading(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/flights/booking/share-sms?bookingReference=${encodeURIComponent(bookingReference)}`,
        { cache: 'no-store' }
      );
      const body = await responseJson<IssueResponseEnvelope<SmsPreview>>(response);
      if (!response.ok || !body.success || !body.data) {
        throw new Error(body.error?.errorMessage || 'The SMS preview is unavailable.');
      }
      setSmsPreview(body.data);
      setSmsRecipientNumber(body.data.recipientNumber);
      setSmsMessage(body.data.message);
      setSmsOpen(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The SMS preview is unavailable.');
    } finally {
      setSmsLoading(false);
    }
  }

  async function toggleSmsPreview(): Promise<void> {
    if (smsOpen) {
      setSmsOpen(false);
      return;
    }
    await loadSmsPreview();
  }

  async function sendSmsConfirmation(): Promise<void> {
    if (
      smsSending ||
      !smsPreview?.canSend ||
      !smsRecipientNumber.trim() ||
      !smsMessage.trim() ||
      smsMessage.trim().length > 480
    ) return;
    const requestId = smsRequestId.current ?? crypto.randomUUID();
    smsRequestId.current = requestId;
    setSmsSending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/flights/booking/share-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference,
          requestId,
          recipientNumber: smsRecipientNumber.trim(),
          message: smsMessage.trim(),
        }),
      });
      const body = await responseJson<
        IssueResponseEnvelope<{
          delivered: boolean;
          sentCount: number;
          maxSends: number;
          remainingSends: number;
        }>
      >(response);
      if (!response.ok || !body.success || !body.data?.delivered) {
        throw new Error(body.error?.errorMessage || 'The confirmation SMS could not be delivered.');
      }
      smsRequestId.current = null;
      setSmsRecipientNumber('');
      setSmsPreview((current) => current ? {
        ...current,
        sentCount: body.data!.sentCount,
        maxSends: body.data!.maxSends,
        remainingSends: body.data!.remainingSends,
        canSend: body.data!.remainingSends > 0,
      } : current);
      setMessage(
        `Confirmation SMS sent. ${body.data.remainingSends} of ${body.data.maxSends} sends remaining.`
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The confirmation SMS could not be delivered.'
      );
    } finally {
      setSmsSending(false);
    }
  }

  async function completeImportedTicketing() {
    if (!importedVerification) return;
    const retryIdentity = completionRequestId ?? crypto.randomUUID();
    setCompletionRequestId(retryIdentity);
    setCompletingImported(true);
    setMessage(null);
    try {
      const response = await fetch('/api/impexp/complete-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference,
          caseId: importedVerification.caseId,
          evidenceObservationId: importedVerification.observationId,
          requestId: retryIdentity,
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.errorMessage ??
            'The verified imported ticket could not be completed.',
        );
      }
      showFeedback({ title: 'Booking Confirmed', description: 'Verified ticketing is complete. Your original payment was used without an additional wallet charge.', reference: bookingReference });
      setCompletionRequestId(null);
      setImportedVerification(null);
      setMessage(
        'Imported ticketing completed as Confirmed. The original payment was reused and no additional wallet debit was made.',
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The verified imported ticket could not be completed.',
      );
    } finally {
      setCompletingImported(false);
    }
  }

  function printTicket(
    withFare: boolean,
    passengerCopy?: { index: number; fileName: string; hasFare: boolean }
  ) {
    const hideFareClass = 'print-ticket-without-fare';
    const passengerRows = document.querySelectorAll<HTMLElement>(
      '[data-print-passenger-index]'
    );
    const bookingFareRows = document.querySelectorAll<HTMLElement>(
      '[data-print-booking-fare-row]'
    );
    const bookingFareTotals = document.querySelectorAll<HTMLElement>(
      '.booking-fare-total'
    );
    const individualFareRows = document.querySelectorAll<HTMLElement>(
      '[data-print-individual-fare-index]'
    );
    const originalTitle = document.title;

    if (!withFare) document.documentElement.classList.add(hideFareClass);
    if (passengerCopy) {
      passengerRows.forEach((row) => {
        row.classList.toggle(
          'print-passenger-hidden',
          row.dataset.printPassengerIndex !== String(passengerCopy.index)
        );
      });
    }
    if (withFare && passengerCopy?.hasFare) {
      bookingFareRows.forEach((row) => row.classList.add('print-fare-hidden'));
      bookingFareTotals.forEach((row) => row.classList.add('print-fare-hidden'));
      individualFareRows.forEach((row) => {
        row.classList.toggle(
          'print-individual-fare-visible',
          row.dataset.printIndividualFareIndex === String(passengerCopy.index)
        );
      });
    }
    document.title = passengerCopy?.fileName ?? bookingReference;

    try {
      window.print();
    } finally {
      document.title = originalTitle;
      document.documentElement.classList.remove(hideFareClass);
      passengerRows.forEach((row) => row.classList.remove('print-passenger-hidden'));
      bookingFareRows.forEach((row) => row.classList.remove('print-fare-hidden'));
      bookingFareTotals.forEach((row) => row.classList.remove('print-fare-hidden'));
      individualFareRows.forEach((row) =>
        row.classList.remove('print-individual-fare-visible')
      );
    }
  }

  function chooseFareForPrint(event: Event, withFare: boolean) {
    // Keep this menu open while the user chooses the copy type. Nested
    // flyouts hide labels and are especially difficult to use on touch.
    event.preventDefault();
    setPrintWithFare(withFare);
  }

  function resetPrintMenu(event: Event) {
    event.preventDefault();
    setPrintWithFare(null);
  }

  const cancellationAction = (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          disabled={!cancellable || cancelInteractionLocked}
          title={
            cancelInteractionLocked
              ? CHECKING_TICKETING_RESULT_MESSAGE
              : cancellable
                ? 'Release this held booking with the airline'
                : 'Only a held, unissued booking can be cancelled'
          }
          className={buttonClass}
        >
          {cancelling ? (
            <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
          ) : (
            <XCircle className="h-4 w-4 text-brand-orange" aria-hidden />
          )}
          {cancelling ? 'Cancelling…' : 'Cancel Booking'}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md overflow-hidden border-0 p-0 shadow-2xl">
        <div className="border-b border-brand-orange/15 bg-brand-orange-light px-6 py-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-brand-orange shadow-sm ring-1 ring-brand-orange/15">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <AlertDialogHeader className="mt-4 text-left">
            <AlertDialogTitle className="text-xl font-bold text-navy-950">
              Cancel this booking?
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-6 text-neutral-600">
              This will ask the airline to release the held PNR. The action
              cannot be undone after the supplier confirms it.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        <div className="space-y-4 px-6 pb-6">
          <div className="rounded-md border border-neutral-200 bg-navy-50 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              Booking reference
            </p>
            <p className="mt-1 font-bold tracking-wide text-navy-950">
              {bookingReference}
            </p>
          </div>
          <p className="flex gap-2 text-xs leading-5 text-neutral-600">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
            No wallet balance is required to cancel an On Hold booking.
          </p>
          <AlertDialogFooter className="gap-2 sm:space-x-0">
            <AlertDialogCancel className="border-neutral-300 text-navy-950">
              Keep Booking
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelInteractionLocked}
              onClick={() => void cancel()}
              className="bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white"
            >
              Yes, Cancel Booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-[260px]">
      <div className="overflow-hidden rounded-lg border-t-4 border-brand-orange bg-brand-orange text-black">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/15">
            <Zap className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em]">
            Quick Actions
          </h2>
        </div>

        <div className="px-4 pb-2">
          <DropdownMenu
            open={printMenuOpen}
            onOpenChange={(open) => {
              setPrintMenuOpen(open);
              if (!open) setPrintWithFare(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <button type="button" className={buttonClass}>
                <Download className="h-4 w-4 text-brand-orange" aria-hidden />
                Print &amp; Download
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {printWithFare === null ? (
                <>
                  <DropdownMenuLabel className="text-xs font-medium text-neutral-500">
                    Choose fare display
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={(event) => chooseFareForPrint(event, true)}
                  >
                    With Fare
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(event) => chooseFareForPrint(event, false)}
                  >
                    Without Fare
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    onSelect={resetPrintMenu}
                    className="text-neutral-500"
                  >
                    ← Change fare display
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-medium text-neutral-500">
                    {printWithFare ? 'With fare' : 'Without fare'}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => printTicket(printWithFare)}>
                    All Passengers Copy
                  </DropdownMenuItem>
                  {passengerCopies.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs font-medium text-neutral-500">
                        Individual Passenger Copy
                      </DropdownMenuLabel>
                      {passengerCopies.map((passenger) => (
                        <DropdownMenuItem
                          key={`${passenger.index}-${printWithFare ? 'with' : 'without'}-fare`}
                          onSelect={() => printTicket(printWithFare, passenger)}
                        >
                          {passenger.label}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {ticketed && (
          <div className="px-4 pb-2">
            <button
              type="button"
              aria-expanded={shareOpen}
              aria-controls="booking-share-panel"
              onClick={() => setShareOpen((open) => !open)}
              className={buttonClass}
            >
              <Share2 className="h-4 w-4 text-brand-orange" aria-hidden />
              Share
              {shareOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-neutral-500" aria-hidden />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-neutral-500" aria-hidden />
              )}
            </button>
            {shareOpen && (
              <div
                id="booking-share-panel"
                className="mt-2 space-y-2 rounded-md border border-black/10 bg-white/20 p-2.5"
              >
                <form
                  onSubmit={(event) => void shareConfirmation(event)}
                  className="space-y-2"
                >
                  <label
                    htmlFor="booking-share-email"
                    className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-black"
                  >
                    <Mail className="h-3.5 w-3.5" aria-hidden />
                    Recipient email
                  </label>
                  <input
                    id="booking-share-email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={shareEmail}
                    onChange={(event) => setShareEmail(event.target.value)}
                    disabled={sharing}
                    placeholder="name@example.com"
                    className="w-full rounded-md border border-white/20 bg-white px-3 py-2.5 text-sm text-navy-950 outline-none transition placeholder:text-neutral-400 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                  <button
                    type="submit"
                    disabled={sharing || !shareEmail.trim()}
                    className={buttonClass}
                  >
                    {sharing ? (
                      <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
                    ) : (
                      <Send className="h-4 w-4 text-brand-orange" aria-hidden />
                    )}
                    {sharing ? 'Sending…' : 'Send Email'}
                  </button>
                </form>

                {allowSmsShare && (
                  <div className="space-y-2 border-t border-black/10 pt-2">
                    <button
                      type="button"
                      aria-expanded={smsOpen}
                      aria-controls="booking-share-sms-preview"
                      onClick={() => void toggleSmsPreview()}
                      disabled={smsLoading || smsSending}
                      className={buttonClass}
                    >
                      {smsLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
                      ) : (
                        <MessageSquareText className="h-4 w-4 text-brand-orange" aria-hidden />
                      )}
                      {smsLoading
                        ? 'Loading preview…'
                        : smsOpen
                          ? 'Hide SMS Preview'
                          : 'Preview SMS'}
                    </button>

                    {smsOpen && smsPreview && (
                      <div
                        id="booking-share-sms-preview"
                        className="space-y-2 rounded-md bg-white p-3 text-navy-950"
                      >
                        <p className="text-[11px]">
                          From: <strong>{smsPreview.senderId}</strong>
                        </p>
                        <label
                          htmlFor="booking-share-sms-mobile"
                          className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-600"
                        >
                          Recipient mobile
                        </label>
                        <input
                          id="booking-share-sms-mobile"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          maxLength={30}
                          value={smsRecipientNumber}
                          onChange={(event) => setSmsRecipientNumber(event.target.value)}
                          disabled={smsSending || !smsPreview.canSend}
                          placeholder="017XXXXXXXX or 88017XXXXXXXX"
                          className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-xs text-navy-950 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:cursor-not-allowed disabled:bg-neutral-100"
                        />
                        <label
                          htmlFor="booking-share-sms-message"
                          className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-600"
                        >
                          Message
                        </label>
                        <textarea
                          id="booking-share-sms-message"
                          rows={8}
                          maxLength={480}
                          value={smsMessage}
                          onChange={(event) => setSmsMessage(event.target.value)}
                          disabled={smsSending || !smsPreview.canSend}
                          className="w-full resize-y rounded-md border border-neutral-200 bg-neutral-100 p-2.5 font-sans text-xs leading-5 text-neutral-800 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:cursor-not-allowed"
                        />
                        <div className="flex items-center justify-between gap-2 text-[10px] text-neutral-500">
                          <span>Use a different number for each send.</span>
                          <span>{smsMessage.length}/480</span>
                        </div>
                        <p className="text-center text-[11px] font-medium text-neutral-600">
                          {smsPreview.remainingSends} of {smsPreview.maxSends} SMS sends remaining
                        </p>
                        <button
                          type="button"
                          onClick={() => void sendSmsConfirmation()}
                          disabled={
                            smsSending ||
                            !smsPreview.canSend ||
                            !smsRecipientNumber.trim() ||
                            !smsMessage.trim()
                          }
                          className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-orange px-3 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {smsSending ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : (
                            <Send className="h-4 w-4" aria-hidden />
                          )}
                          {smsSending
                            ? 'Sending…'
                            : smsPreview.canSend
                              ? 'Send SMS'
                              : 'SMS Limit Reached'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {ticketed && showPostTicketActions && allowedPostTicketActions.length > 0 && (
          <PostTicketActionsPreview
            bookingReference={bookingReference}
            passengers={passengerCopies.map(({ index, label }) => ({ index, label }))}
            routes={postTicketRoutes}
            issuedAt={ticketIssuedAt}
            allowOwnerActions={allowPostTicketOwnerActions}
            allowedActions={allowedPostTicketActions}
          />
        )}

        {(allowSupplierRefresh || allowImportedSync) && (
          <div className="space-y-2 px-4 pb-2">
            <button
              type="button"
              onClick={() => void refreshSupplierDetails()}
              disabled={refreshing || completingImported || issuing || cancelling}
              className={buttonClass}
            >
              <RefreshCw
                className={`h-4 w-4 text-brand-orange ${refreshing ? 'animate-spin' : ''}`}
                aria-hidden
              />
              {refreshing
                ? allowImportedSync ? 'Syncing…' : 'Refreshing…'
                : allowImportedSync ? 'Sync Imported Booking' : 'Refresh Ticket Details'}
            </button>
            {paymentState === 'captured' &&
              importedVerification?.validation.authoritativeFor === 'ticketed' && (
              <button
                type="button"
                onClick={() => void completeImportedTicketing()}
                disabled={refreshing || completingImported || issuing || cancelling}
                className={buttonClass}
              >
                {completingImported ? (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
                ) : (
                  <Ticket className="h-4 w-4 text-brand-orange" aria-hidden />
                )}
                {completingImported
                  ? 'Completing verified ticket…'
                  : 'Complete Verified Ticket'}
              </button>
            )}
          </div>
        )}

        {requestOnly ? (
          <div className="space-y-3 px-4 pb-4">
            {allowLocalTimeLimitRequest ? (
              <button
                type="button"
                onClick={() => void requestTimeLimit()}
                disabled={
                  requestingTimeLimit ||
                  localTimeLimit?.requestPending ||
                  !localTimeLimit?.requestEligible
                }
                className={buttonClass}
              >
                {requestingTimeLimit ? (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-orange" aria-hidden />
                ) : (
                  <Clock3 className="h-4 w-4 text-brand-orange" aria-hidden />
                )}
                {localTimeLimit?.requestPending
                  ? 'Time Limit Requested'
                  : requestingTimeLimit
                    ? 'Requesting…'
                    : 'Request Time Limit'}
              </button>
            ) : (
              <p className="rounded-md border border-black/10 px-3 py-2 text-center text-xs text-black">
                {localTimeLimit?.requestPending
                  ? 'Review and decide the pending request below.'
                  : 'The customer or agency user must submit a time-limit request before staff can decide it.'}
              </p>
            )}
            {cancellationAction}
          </div>
        ) : ticketed || cancelled || !issueEligible ? (
          <div className="px-4 pb-4">
            <p className="rounded-md bg-white/20 p-3 text-xs leading-relaxed text-black">
              {ticketed
                ? 'This booking is ticketed. Nothing further is payable.'
                : cancelled
                  ? 'This booking has been cancelled.'
                  : importedBooking && status === 'in-progress'
                    ? statusMessage ?? IMPORTED_MANUAL_TICKETING_MESSAGE
                    : importedBooking && status === 'on-hold'
                      ? 'This imported booking is waiting for the assigned customer or agency to use Issue Now.'
                    : importedBooking
                        ? manualBooking
                          ? 'This manual booking is managed by authorized operations staff. Supplier Sync is unavailable.'
                          : 'This imported booking is managed and verified through the external supplier system.'
                  : status === 'in-progress'
                    ? statusMessage ??
                      'We are verifying the latest booking details with the airline.'
                    : status === 'unconfirmed'
                      ? 'The airline PNR must be verified before ticketing or cancellation.'
                      : 'The ticketing deadline has passed.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2 px-4 pb-4">
            <div className="flex items-center justify-between gap-2 rounded-md bg-white/20 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-black">
                <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Available
              </span>
              <span className="text-sm font-semibold text-black">
                {loading
                  ? 'Loading…'
                  : preview
                    ? money(
                        preview.wallet.availableBalance,
                        preview.wallet.currency
                      )
                    : '--'}
              </span>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  disabled={
                    loading ||
                    issueInteractionLocked ||
                    !preview ||
                    insufficient ||
                    frozen
                  }
                  title={
                    reconciliationActive
                      ? CHECKING_TICKETING_RESULT_MESSAGE
                      : frozen
                      ? 'Wallet is frozen'
                      : insufficient
                        ? issuingForAssignedOwner
                          ? "The assigned user's wallet has insufficient balance"
                          : 'Recharge the wallet before confirming'
                        : importedConfirmEligible
                          ? 'Hold User Payable and request manual ticketing'
                          : 'Reserve wallet funds and issue the ticket'
                  }
                  className={buttonClass}
                >
                  {issuing ? (
                    <Loader2
                      className="h-4 w-4 animate-spin text-brand-orange"
                      aria-hidden
                    />
                  ) : (
                    <Ticket className="h-4 w-4 text-brand-orange" aria-hidden />
                  )}
                  {issuing
                    ? importedConfirmEligible ? 'Placing hold…' : 'Issuing…'
                    : importedConfirmEligible ? 'Issue Now' : 'Issue Ticket'}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent className="max-w-md overflow-hidden border-0 p-0 shadow-2xl">
                <div className="border-b border-brand-orange/15 bg-brand-orange-light px-6 py-5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-brand-orange shadow-sm ring-1 ring-brand-orange/15">
                    <Ticket className="h-5 w-5" aria-hidden />
                  </span>
                  <AlertDialogHeader className="mt-4 text-left">
                    <AlertDialogTitle className="text-xl font-bold text-navy-950">
                      {importedConfirmEligible
                        ? 'Issue this imported booking?'
                        : 'Issue this ticket?'}
                    </AlertDialogTitle>
                    <AlertDialogDescription className="leading-6 text-neutral-600">
                      {importedConfirmEligible
                        ? 'This moves the User Payable Amount from Available to Hold and moves the booking to In Progress for manual external ticketing. No supplier Issue Ticket API will be called.'
                        : issuingForAssignedOwner
                          ? "This will submit the held booking to the airline and debit the payable amount from the assigned user's wallet."
                          : 'This will submit the held booking to the airline for final ticket issuance and debit the payable amount from your wallet.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                </div>
                <div className="space-y-4 px-6 pb-6">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md border border-neutral-200 bg-navy-50 px-4 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        Booking reference
                      </p>
                      <p className="mt-1 font-bold tracking-wide text-navy-950">
                        {bookingReference}
                      </p>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-navy-50 px-4 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        Wallet hold
                      </p>
                      <p className="mt-1 font-bold text-brand-orange">
                        {preview && (preview.paymentState === 'captured'
                          ? 'Already paid'
                          : money(preview.requiredAmount, preview.wallet.currency))}
                      </p>
                    </div>
                  </div>
                  <p className="flex gap-2 text-xs leading-5 text-neutral-600">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange"
                      aria-hidden
                    />
                    {importedConfirmEligible
                      ? manualBooking
                        ? 'After the hold is placed, authorized operations staff must manually issue the ticket externally and record the required ticket details. Supplier Sync will not run.'
                        : 'After the hold is placed, authorized operations staff must manually process the ticket and verify the supplier result.'
                      : 'Confirm only when you are ready to issue. The airline may not allow the ticketing request to be reversed.'}
                  </p>
                  <AlertDialogFooter className="gap-2 sm:space-x-0">
                    <AlertDialogCancel className="border-neutral-300 text-navy-950">
                      Not Now
                    </AlertDialogCancel>
                    <AlertDialogAction
                      disabled={issueInteractionLocked}
                      onClick={() => void issue()}
                      className="bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white"
                    >
                      {importedConfirmEligible ? 'Yes, Issue Now' : 'Yes, Issue Ticket'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </div>
              </AlertDialogContent>
            </AlertDialog>

            {!issuingForAssignedOwner && (
              <button
                type="button"
                disabled={issuing || cancelling || frozen}
                onClick={recharge}
                title="Submit a wallet deposit request"
                className={buttonClass}
              >
                <Wallet className="h-4 w-4 text-brand-orange" aria-hidden />
                Recharge Wallet
              </button>
            )}

            {cancellationAction}

          </div>
        )}
        {message && (
          <p className="mx-4 mb-4 flex gap-1.5 rounded-md bg-white/20 p-2.5 text-[11px] leading-relaxed text-black">
            <AlertCircle
              className="mt-0.5 h-3 w-3 shrink-0"
              aria-hidden
            />
            {message}
          </p>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </aside>
  );
}
