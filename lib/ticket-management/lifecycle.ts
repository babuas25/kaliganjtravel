import type {
  TicketManagementStatus,
  TicketManagementTerminalOutcome,
} from './types';

const TRANSITIONS: Readonly<
  Record<TicketManagementStatus, readonly TicketManagementStatus[]>
> = {
  requested: ['in-progress', 'rejected'],
  'in-progress': ['awaiting-confirmation', 'rejected'],
  'awaiting-confirmation': ['approved', 'rejected', 'expired'],
  // Settlement records the financial result but does not create another
  // customer-facing stage. An approved request may only return to In Progress
  // for a documented requotation while it has not yet been settled.
  approved: ['in-progress'],
  completed: [],
  rejected: [],
  expired: [],
};

export function ticketManagementTransitionsFrom(
  status: TicketManagementStatus
): readonly TicketManagementStatus[] {
  return TRANSITIONS[status];
}

export function canTransitionTicketManagementStatus(
  from: TicketManagementStatus,
  to: TicketManagementStatus
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function terminalOutcomeMatchesStatus(
  status: TicketManagementStatus,
  outcome: TicketManagementTerminalOutcome | null
): boolean {
  if (status === 'approved') {
    return outcome === null || outcome === 'refunded' || outcome === 'reissued' || outcome === 'voided';
  }
  if (status === 'completed') {
    // Kept only to read and normalize records created before the lifecycle
    // simplification migration.
    return outcome === 'refunded' || outcome === 'reissued' || outcome === 'voided';
  }
  if (status === 'rejected') {
    return outcome === 'staff-rejected' || outcome === 'customer-rejected';
  }
  if (status === 'expired') return outcome === 'confirmation-expired';
  return outcome === null;
}
