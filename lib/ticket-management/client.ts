import type {
  TicketManagementAction,
  TicketManagementRequestType,
  TicketManagementStatus,
} from './types';

type TicketManagementRequestSummary = {
  id: string;
  publicRef: string;
  bookingReference: string | null;
  action: TicketManagementAction;
  requestType: TicketManagementRequestType;
  status: TicketManagementStatus;
  terminalOutcome: string | null;
  version: number;
  currency: string;
  activeQuoteId: string | null;
  approvedQuoteId: string | null;
  assigneeUserId?: string | null;
  assigneeRole?: string | null;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketManagementListItem = TicketManagementRequestSummary & {
  agencyName: string | null;
  agencyId: string | null;
  airline: string | null;
  airlineCode: string | null;
  flightDate: string | null;
  issuedAt: string | null;
  passengerDetails: Array<{
    passengerName: string;
    passengerType: string;
    ticketNumber: string | null;
  }>;
  grossFare: number | null;
  userPayable: number | null;
  updatedBy: string;
  updatedByRole: string | null;
};

export type TicketManagementPassenger = {
  passengerIndex: number;
  passengerName: string;
  passengerType: string;
  ticketNumber: string | null;
  entitlementId?: string;
  entitlementAmount?: number;
};

export type TicketManagementRoute = {
  routeIndex: number;
  label: string;
  origin: string;
  destination: string;
  departureAt: string | null;
};

export type TicketManagementPassengerAvailability = {
  passengerIndex: number;
  available: boolean;
  reasonCode:
    | 'ACTIVE_REQUEST'
    | 'REFUNDED'
    | 'VOIDED'
    | 'REISSUED'
    | 'UNAVAILABLE'
    | null;
  message: string | null;
};

export type TicketManagementAvailability = {
  passengers: TicketManagementPassengerAvailability[];
};

export type TicketManagementQuote = {
  id: string;
  quoteVersion: number;
  currency: string;
  direction: 'credit' | 'debit' | 'none';
  userPayableEntitlementAmount: number;
  supplierGrossAmount?: number;
  supplierPayableAmount?: number;
  fareDifference: number;
  airlineFee: number;
  voidFee: number;
  serviceFee: number;
  customerAmount: number;
  details: string | null;
  confirmationDeadlineAt: string;
  publishedAt: string;
  publishedByUserId?: string;
  publishedByRole?: string;
  fareDifferenceAllocations?: Array<{
    entitlementId: string;
    passengerIndex: number;
    fareDifferenceAmount: number;
  }>;
};

export type TicketManagementDetail = TicketManagementRequestSummary & {
  requestNote: string | null;
  passengers: TicketManagementPassenger[];
  routes: TicketManagementRoute[];
  quotes: TicketManagementQuote[];
  decisions: Array<{
    decision: 'approved' | 'rejected';
    quoteId: string;
    decidedAt: string;
    decidedByUserId?: string;
    decidedByRole?: string;
  }>;
  events: Array<{
    eventType: string;
    fromStatus: string | null;
    toStatus: string;
    effectiveAt: string;
    actorUserId?: string;
    actorRole?: string;
    note?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  walletResults?: Record<string, string | null>;
  assignments?: Array<Record<string, unknown>>;
};

type Envelope<T> = {
  success?: boolean;
  data?: T;
  error?: { errorCode?: string; errorMessage?: string };
};

export async function ticketManagementFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, { cache: 'no-store', ...init });
  let body: Envelope<T> = {};
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error('The Ticket Management response was malformed.');
  }
  if (!response.ok || !body.success || body.data === undefined) {
    throw new Error(
      body.error?.errorMessage ?? 'The Ticket Management request was not accepted.',
    );
  }
  return body.data;
}

export function moneyToMinor(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const major = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const result = major * 100 + fraction;
  return Number.isSafeInteger(result) ? result : null;
}

export function minorToInput(value: number): string {
  return (value / 100).toFixed(2);
}

export function formatMinor(value: number, currency: string): string {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

export function formatTicketManagementStatus(status: string): string {
  return status
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Request stages use clearer operational language than individual history
 * events. A settlement remains in the Approved stage; its terminal outcome
 * records whether the approved refund, reissue, or void was settled.
 */
export function formatTicketManagementRequestStatus(status: string): string {
  if (status === 'awaiting-confirmation') return 'Quotation';
  if (status === 'approved') return 'Approved';
  return formatTicketManagementStatus(status);
}

/** History can include financial audit events without adding a workflow tab. */
export function formatTicketManagementEvent(event: string): string {
  if (event === 'completed') return 'Approved — settlement recorded';
  return formatTicketManagementStatus(event);
}
