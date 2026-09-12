export const TICKET_MANAGEMENT_ACTIONS = [
  'refund',
  'reissue',
  'void',
] as const;

export type TicketManagementAction =
  (typeof TICKET_MANAGEMENT_ACTIONS)[number];

/** A customer-safe request reference shown alongside its booking on screen. */
export type TicketManagementRequestReference = {
  action: TicketManagementAction;
  publicRef: string;
  status: TicketManagementStatus;
  terminalOutcome: TicketManagementTerminalOutcome | null;
};

export const TICKET_MANAGEMENT_REQUEST_TYPES = [
  'voluntary',
  'involuntary',
] as const;

export type TicketManagementRequestType =
  (typeof TICKET_MANAGEMENT_REQUEST_TYPES)[number];

export const TICKET_MANAGEMENT_STATUSES = [
  'requested',
  'in-progress',
  'awaiting-confirmation',
  'approved',
  'completed',
  'rejected',
  'expired',
] as const;

export type TicketManagementStatus =
  (typeof TICKET_MANAGEMENT_STATUSES)[number];

export const TICKET_MANAGEMENT_TERMINAL_OUTCOMES = [
  'staff-rejected',
  'customer-rejected',
  'confirmation-expired',
  'refunded',
  'reissued',
  'voided',
] as const;

export type TicketManagementTerminalOutcome =
  (typeof TICKET_MANAGEMENT_TERMINAL_OUTCOMES)[number];

export type TicketManagementQuoteDirection = 'credit' | 'debit' | 'none';

export type TicketManagementFinancialRole =
  | 'superadmin'
  | 'admin'
  | 'staff_account';

export type TicketManagementPassengerSelection = {
  passengerIndex: number;
  passengerName: string;
  passengerType: string | null;
  ticketNumber: string | null;
};

export type TicketManagementQuoteAmounts = {
  currency: string;
  supplierGrossAmountMinor: number;
  supplierPayableAmountMinor: number;
  userPayableEntitlementAmountMinor: number;
  fareDifferenceMinor: number;
  airlineFeeMinor: number;
  voidFeeMinor: number;
  serviceFeeMinor: number;
  customerAmountMinor: number;
  direction: TicketManagementQuoteDirection;
};
