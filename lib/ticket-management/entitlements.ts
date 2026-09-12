import type { BookingTraveller } from '@/lib/flights/booking';
import type { FareBreakdown } from '@/lib/flights/types';

export type TicketEntitlementAllocation = {
  passengerIndex: number;
  passengerName: string;
  passengerType: BookingTraveller['passengerType'];
  ticketNumber: string;
  entitlementAmountMinor: bigint;
  userPayableSourceMinor: bigint;
  allocationSource:
    | 'authoritative-user-payable'
    | 'authoritative-single-passenger-user-payable';
};

export type TicketEntitlementAllocationResult =
  | { ok: true; allocations: TicketEntitlementAllocation[] }
  | {
      ok: false;
      code:
        | 'INVALID_CAPTURED_AMOUNT'
        | 'PASSENGER_TICKET_MISMATCH'
        | 'INVALID_TICKET_NUMBER'
        | 'DUPLICATE_TICKET_NUMBER'
        | 'FARE_ALLOCATION_UNAVAILABLE';
    };

function fareForPassenger(
  fares: readonly FareBreakdown[],
  travellers: readonly BookingTraveller[],
  passengerIndex: number
) {
  const traveller = travellers[passengerIndex];
  if (!traveller) return null;

  const typeOccurrence = travellers
    .slice(0, passengerIndex)
    .filter((candidate) => candidate.passengerType === traveller.passengerType)
    .length;
  let fareSlot = 0;

  for (const fare of fares) {
    if (fare.passengerType !== traveller.passengerType) continue;
    const count = Math.trunc(fare.count);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    if (typeOccurrence < fareSlot + count) {
      const perPassengerTotal = fare.totalPrice / count;
      if (!Number.isFinite(perPassengerTotal) || perPassengerTotal <= 0) {
        return null;
      }
      const sourceMinor = perPassengerTotal * 100;
      const roundedMinor = Math.round(sourceMinor);
      return Number.isSafeInteger(roundedMinor) && roundedMinor > 0 &&
        Math.abs(sourceMinor - roundedMinor) < 0.000001
        ? BigInt(roundedMinor)
        : null;
    }
    fareSlot += count;
  }

  return null;
}

/**
 * Allocates the booking's captured minor-unit amount across its issued tickets.
 *
 * Each passenger fare must already be an exact minor-unit User Payable amount,
 * and those amounts must sum exactly to the authoritative captured amount.
 * Gross-weighted proportional allocation is intentionally forbidden.
 */
export function allocateCapturedTicketEntitlements(input: {
  travellers: readonly BookingTraveller[];
  ticketNumbers: readonly string[];
  fares: readonly FareBreakdown[];
  capturedAmountMinor: bigint;
  authoritativeUserPayableAmountMinor?: bigint | null;
}): TicketEntitlementAllocationResult {
  if (input.capturedAmountMinor <= BigInt(0)) {
    return { ok: false, code: 'INVALID_CAPTURED_AMOUNT' };
  }
  if (
    input.travellers.length === 0 ||
    input.ticketNumbers.length !== input.travellers.length
  ) {
    return { ok: false, code: 'PASSENGER_TICKET_MISMATCH' };
  }

  const tickets = input.ticketNumbers.map((ticket) => ticket.trim().toUpperCase());
  if (tickets.some((ticket) => ticket.length === 0 || ticket.length > 80)) {
    return { ok: false, code: 'INVALID_TICKET_NUMBER' };
  }
  if (new Set(tickets).size !== tickets.length) {
    return { ok: false, code: 'DUPLICATE_TICKET_NUMBER' };
  }

  if (input.travellers.length === 1) {
    const authoritativeAmount =
      input.authoritativeUserPayableAmountMinor ?? input.capturedAmountMinor;
    if (
      authoritativeAmount <= BigInt(0) ||
      authoritativeAmount !== input.capturedAmountMinor
    ) {
      return { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' };
    }
    const traveller = input.travellers[0];
    return {
      ok: true,
      allocations: [
        {
          passengerIndex: 0,
          passengerName:
            `${traveller.title} ${traveller.firstName} ${traveller.lastName}`
              .replace(/\s+/g, ' ')
              .trim(),
          passengerType: traveller.passengerType,
          ticketNumber: tickets[0],
          entitlementAmountMinor: authoritativeAmount,
          userPayableSourceMinor: authoritativeAmount,
          allocationSource: 'authoritative-single-passenger-user-payable',
        },
      ],
    };
  }

  const sourceAmounts = input.travellers.map((_, index) =>
    fareForPassenger(input.fares, input.travellers, index)
  );
  if (sourceAmounts.some((amount) => amount === null)) {
    return { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' };
  }

  const authoritativeAmounts = sourceAmounts as bigint[];
  const sourceTotal = authoritativeAmounts.reduce(
    (sum, amount) => sum + amount,
    BigInt(0)
  );
  if (sourceTotal !== input.capturedAmountMinor) {
    return { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' };
  }

  return {
    ok: true,
    allocations: authoritativeAmounts.map((amount, passengerIndex) => {
      const traveller = input.travellers[passengerIndex];
      return {
        passengerIndex,
        passengerName: `${traveller.title} ${traveller.firstName} ${traveller.lastName}`
          .replace(/\s+/g, ' ')
          .trim(),
        passengerType: traveller.passengerType,
        ticketNumber: tickets[passengerIndex],
        entitlementAmountMinor: amount,
        userPayableSourceMinor: amount,
        allocationSource: 'authoritative-user-payable' as const,
      };
    }),
  };
}
