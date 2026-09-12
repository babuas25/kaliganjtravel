import type { BookingStatus } from '@/lib/flights/booking-status';

export type CustomerInProgressKind =
  | 'ticketing'
  | 'cancellation'
  | 'imported_manual_ticketing'
  | 'supplier_verification';

export const CUSTOMER_IN_PROGRESS_MESSAGES: Record<
  CustomerInProgressKind,
  string
> = {
  ticketing: 'Ticketing is in progress with the airline.',
  cancellation:
    'Your cancellation request is being processed with the airline.',
  imported_manual_ticketing:
    'User Payable is held; ticketing is being completed.',
  supplier_verification:
    'We are verifying the latest booking details with the airline.',
};

type CustomerProgressFacts = {
  status: BookingStatus;
  importSource: 'IMP_EXP' | 'MANUAL' | null;
  paymentState: string;
  operationKind: 'ticketing' | 'cancellation' | 'reconciliation' | null;
  operationReason: string | null;
};

/**
 * Converts private operation facts into a bounded customer-safe semantic.
 * Raw operation, case, supplier-error, and financial-reconciliation labels are
 * deliberately absent from the returned value.
 */
export function customerInProgressKind(
  facts: CustomerProgressFacts
): CustomerInProgressKind | null {
  if (facts.status !== 'in-progress') return null;
  if (facts.operationKind === 'cancellation') return 'cancellation';
  if (
    facts.operationKind === 'reconciliation' ||
    facts.operationReason?.includes('reconciliation')
  ) {
    return 'supplier_verification';
  }
  if (
    (facts.importSource === 'IMP_EXP' || facts.importSource === 'MANUAL') &&
    (facts.paymentState === 'held' || facts.paymentState === 'captured')
  ) {
    return 'imported_manual_ticketing';
  }
  if (facts.operationKind === 'ticketing') return 'ticketing';
  return 'supplier_verification';
}

export function customerStatusMessage(
  facts: CustomerProgressFacts
): string | null {
  const kind = customerInProgressKind(facts);
  return kind ? CUSTOMER_IN_PROGRESS_MESSAGES[kind] : null;
}
