import 'server-only';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import type { BookingLifecycleTimelineItem } from '@/lib/dashboard/booking-lifecycle-timeline';
import { bookingReviewResponsibility } from '@/lib/dashboard/booking-review-responsibility';
import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

type StatusEventRow = {
  id: number;
  operation_id: string | null;
  from_lifecycle_status: string | null;
  to_lifecycle_status: string;
  effective_at: string | null;
  observed_at: string | null;
};

type OperationRow = {
  id: string;
  kind: string;
  state: string;
  claimed_at: string;
  supplier_response_received_at: string | null;
  external_action_due_at: string | null;
  reconciliation_required_at: string | null;
  completed_at: string | null;
};

type CaseRow = {
  id: string;
  case_type: string;
  state: string;
  opened_at: string;
  assigned_team: string | null;
  severity: string;
  due_at: string | null;
  resolution_outcome: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  superseded_at?: string | null;
  financial_disposition?: string;
  financial_amount?: number | null;
  financial_currency?: string | null;
};

function humanize(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fact(
  label: string,
  value: string | number | null | undefined
): { label: string; value: string } | null {
  if (value === null || value === undefined || value === '') return null;
  return { label, value: String(value) };
}

function facts(
  ...values: Array<{ label: string; value: string } | null>
): Array<{ label: string; value: string }> {
  return values.filter(
    (value): value is { label: string; value: string } => value !== null
  );
}

function minorMoney(
  amount: number | null | undefined,
  currency: string | null | undefined
): string | null {
  if (amount === null || amount === undefined || !currency) return null;
  return `${(Number(amount) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function bookingStatusPresentation(
  status: string,
  previousStatus: string | null
): Pick<
  BookingLifecycleTimelineItem,
  'title' | 'description' | 'tone'
> {
  const isFirstUpdate = !previousStatus;

  switch (status) {
    case 'confirmed':
      return {
        title: 'Ticket issued',
        description:
          'Ticketing is complete. This booking is confirmed and ready for travel.',
        tone: 'success',
      };
    case 'in-progress':
      return {
        title: 'Ticketing started',
        description:
          'The booking is being processed. Please wait for the ticketing result before taking another action.',
        tone: 'progress',
      };
    case 'on-hold':
      return {
        title: isFirstUpdate ? 'Booking created' : 'Booking placed on hold',
        description:
          'The booking is reserved and waiting for ticketing or a further booking update.',
        tone: 'neutral',
      };
    case 'pending':
      return {
        title: 'Booking is pending',
        description:
          'The booking is waiting for confirmation. No further action is needed until there is an update.',
        tone: 'progress',
      };
    case 'cancelled':
      return {
        title: 'Booking cancelled',
        description:
          'This booking has been cancelled. Check the payment section for any applicable refund information.',
        tone: 'attention',
      };
    case 'expired':
      return {
        title: 'Ticketing time expired',
        description:
          'The ticketing time limit has passed, so this booking can no longer be ticketed.',
        tone: 'attention',
      };
    case 'unconfirmed':
      return {
        title: 'Booking needs confirmation',
        description:
          'Confirmation from the airline or supplier is still needed before this booking can continue.',
        tone: 'attention',
      };
    default:
      return {
        title: `Booking status updated to ${humanize(status)}`,
        description:
          'The booking status was updated. Review the booking details above for the latest information.',
        tone: 'neutral',
      };
  }
}

function operationName(kind: string): string {
  switch (kind) {
    case 'ticketing':
      return 'Ticketing';
    case 'cancellation':
      return 'Cancellation';
    case 'imported_manual_ticketing':
      return 'Manual ticketing';
    default:
      return humanize(kind);
  }
}

function operationPresentation(
  kind: string,
  state: string
): Pick<BookingLifecycleTimelineItem, 'title' | 'description' | 'tone'> {
  const name = operationName(kind);
  const isCancellation = kind === 'cancellation';

  switch (state) {
    case 'succeeded':
      return {
        title: `${name} completed`,
        description: isCancellation
          ? 'The cancellation was completed successfully.'
          : 'The request was completed successfully.',
        tone: 'success',
      };
    case 'failed':
      return {
        title: `${name} was unsuccessful`,
        description:
          'The request could not be completed. Review the booking status before trying again.',
        tone: 'attention',
      };
    case 'awaiting_external_action':
      return {
        title: `${name} is required`,
        description:
          'This booking needs a staff action outside the system before the request can be finalised.',
        tone: 'attention',
      };
    case 'needs_reconciliation':
      return {
        title: `${name} needs review`,
        description:
          'The booking details need to be checked before the request can be completed safely.',
        tone: 'attention',
      };
    case 'supplier_call_started':
      return {
        title: `${name} in progress`,
        description:
          'The request has been sent for processing. Please wait for the result before taking another action.',
        tone: 'progress',
      };
    case 'claimed':
      return {
        title: `${name} requested`,
        description:
          'The request has been received and is waiting to be processed.',
        tone: 'progress',
      };
    default:
      return {
        title: `${name} update`,
        description:
          'There is a new update for this booking request. Review the booking status for the latest information.',
        tone: 'neutral',
      };
  }
}

function caseSubject(caseType: string): string {
  switch (caseType) {
    case 'ticketing_uncertainty':
    case 'imported_manual_ticketing':
      return 'Ticketing';
    case 'cancellation_uncertainty':
      return 'Cancellation';
    case 'direct_ticket_payment_failure':
    case 'imported_payment_conflict':
      return 'Payment';
    default:
      return 'Booking';
  }
}

function casePresentation(
  caseType: string,
  state: string
): Pick<BookingLifecycleTimelineItem, 'title' | 'description' | 'tone'> {
  const subject = caseSubject(caseType);

  switch (state) {
    case 'superseded':
      return {
        title: `${subject} proposal superseded`,
        description:
          'The approved proposal expired before execution and was preserved as historical review. A separate successor review requires new evidence and approval.',
        tone: 'neutral',
      };
    case 'resolved':
    case 'closed_no_change':
      return {
        title: `${subject} review completed`,
        description:
          'The review is complete. The booking details above show the final outcome.',
        tone: 'success',
      };
    case 'awaiting_supplier':
      return {
        title: `${subject} review in progress`,
        description:
          'We are waiting for the airline or supplier to verify the booking details.',
        tone: 'attention',
      };
    case 'awaiting_finance':
      return {
        title: 'Payment review in progress',
        description:
          'The finance team is checking the payment details before the booking can be updated.',
        tone: 'attention',
      };
    case 'awaiting_approval':
      return {
        title: `${subject} review awaiting approval`,
        description:
          'A proposed outcome is waiting for approval before it can be applied to this booking.',
        tone: 'attention',
      };
    case 'assigned':
      return {
        title: `${subject} review routed`,
        description:
          'The responsible staff team needs to review this booking and provide the next update.',
        tone: 'attention',
      };
    default:
      return {
        title: `${subject} review opened`,
        description:
          'This booking needs a review before it can move forward safely.',
        tone: 'attention',
      };
  }
}

export async function readStaffBookingLifecycleTimeline(
  role: Role,
  publicRef: string
): Promise<BookingLifecycleTimelineItem[]> {
  const access = bookingLifecycleAccessForRole(role);
  if (!access) throw new Error('Booking lifecycle staff access is required.');
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking lifecycle storage is unavailable.');

  const { data: booking, error: bookingError } = await supabase
    .from('booking_lifecycle_staff_v')
    .select('booking_id')
    .eq('public_ref', publicRef)
    .maybeSingle();
  if (bookingError) {
    console.error('[db] lifecycle timeline booking lookup failed:', bookingError.message);
    throw new Error('Booking lifecycle timeline could not be loaded.');
  }
  if (!booking?.booking_id) return [];

  const financialDetail = access === 'accounts' || access === 'admin';
  const eventSelect = [
    'id',
    'operation_id',
    'from_lifecycle_status',
    'to_lifecycle_status',
    'effective_at',
    'observed_at',
  ].join(',');
  const operationSelect = [
    'id',
    'kind',
    'state',
    'claimed_at',
    'supplier_response_received_at',
    'external_action_due_at',
    'reconciliation_required_at',
    'completed_at',
  ].join(',');
  const caseSelect = [
    'id',
    'case_type',
    'state',
    'opened_at',
    'assigned_team',
    'severity',
    'due_at',
    'resolution_outcome',
    'resolved_at',
    'closed_at',
    'superseded_at',
    ...(financialDetail
      ? ['financial_disposition', 'financial_amount', 'financial_currency']
      : []),
  ].join(',');

  const [eventResult, operationResult, caseResult] = await Promise.all([
    supabase
      .from('booking_status_events')
      .select(eventSelect)
      .eq('booking_id', booking.booking_id)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('booking_operations')
      .select(operationSelect)
      .eq('booking_id', booking.booking_id)
      .order('claimed_at', { ascending: false })
      .limit(100),
    supabase
      .from('booking_reconciliation_cases')
      .select(caseSelect)
      .eq('subject_booking_id', booking.booking_id)
      .order('opened_at', { ascending: false })
      .limit(100),
  ]);

  for (const [name, error] of [
    ['events', eventResult.error],
    ['operations', operationResult.error],
    ['cases', caseResult.error],
  ] as const) {
    if (error) {
      console.error(`[db] lifecycle timeline ${name} failed:`, error.message);
      throw new Error('Booking lifecycle timeline could not be loaded.');
    }
  }

  const statusEvents = (eventResult.data ?? []) as unknown as StatusEventRow[];
  const operations = (operationResult.data ?? []) as unknown as OperationRow[];
  const completedOperationEvents = new Map(
    statusEvents
      .filter(
        (event) =>
          event.operation_id &&
          ['confirmed', 'cancelled'].includes(event.to_lifecycle_status) &&
          operations.some(
            (operation) =>
              operation.id === event.operation_id && operation.state === 'succeeded'
          )
      )
      .map((event) => [event.operation_id!, event])
  );

  const eventItems = statusEvents
    .filter((event) => !completedOperationEvents.has(event.operation_id ?? ''))
    .map((row): BookingLifecycleTimelineItem => {
      const presentation = bookingStatusPresentation(
        row.to_lifecycle_status,
        row.from_lifecycle_status
      );
      return {
        id: `status:${row.id}`,
        kind: 'status',
        occurredAt: row.effective_at,
        observedAt: row.observed_at,
        ...presentation,
        state: row.to_lifecycle_status,
        warning: presentation.tone === 'attention',
        facts: facts(fact('Booking status', humanize(row.to_lifecycle_status))),
      };
    });

  const operationItems = operations.map((row): BookingLifecycleTimelineItem => {
    const completedEvent = completedOperationEvents.get(row.id);
    const presentation = completedEvent
      ? bookingStatusPresentation(
          completedEvent.to_lifecycle_status,
          completedEvent.from_lifecycle_status
        )
      : operationPresentation(row.kind, row.state);
    const needsAction = [
      'awaiting_external_action',
      'needs_reconciliation',
    ].includes(row.state);
    return {
      id: `operation:${row.id}`,
      kind: 'operation',
      occurredAt: completedEvent?.effective_at ?? row.claimed_at,
      observedAt: completedEvent?.observed_at ?? row.supplier_response_received_at,
      ...presentation,
      state: completedEvent?.to_lifecycle_status ?? row.state,
      warning: needsAction,
      facts: facts(
        needsAction ? fact('Action needed by', row.external_action_due_at) : null,
        row.state === 'needs_reconciliation'
          ? fact('Review started', row.reconciliation_required_at)
          : null,
        !completedEvent && row.state === 'succeeded'
          ? fact('Completed', row.completed_at)
          : null
      ),
    };
  });

  const caseItems = ((caseResult.data ?? []) as unknown as CaseRow[]).map(
    (row): BookingLifecycleTimelineItem => {
      const presentation = casePresentation(row.case_type, row.state);
      const reviewOpen = !['resolved', 'closed_no_change', 'superseded'].includes(
        row.state
      );
      return {
        id: `case:${row.id}`,
        kind: 'case',
        occurredAt: row.opened_at,
        observedAt: row.superseded_at ?? row.resolved_at ?? row.closed_at,
        ...presentation,
        state: row.state,
        warning: reviewOpen,
        facts: facts(
          fact('Responsibility', bookingReviewResponsibility(row.assigned_team)),
          reviewOpen ? fact('Due by', row.due_at) : null,
          reviewOpen ? fact('Priority', humanize(row.severity)) : null,
          !reviewOpen ? fact('Outcome', row.resolution_outcome) : null,
          row.state === 'superseded'
            ? fact('Superseded at', row.superseded_at)
            : null,
          financialDetail && row.financial_disposition !== 'none'
            ? fact('Payment outcome', row.financial_disposition && humanize(row.financial_disposition))
            : null,
          financialDetail
            ? fact(
                'Amount',
                minorMoney(row.financial_amount, row.financial_currency)
              )
            : null
        ),
      };
    }
  );

  return [...eventItems, ...operationItems, ...caseItems].sort(
    (left, right) => {
      const rightTime = right.occurredAt ?? right.observedAt;
      const leftTime = left.occurredAt ?? left.observedAt;
      if (!rightTime) return leftTime ? -1 : 0;
      if (!leftTime) return 1;
      return new Date(rightTime).getTime() - new Date(leftTime).getTime();
    }
  );
}
