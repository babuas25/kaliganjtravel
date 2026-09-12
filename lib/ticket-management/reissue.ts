export type ReissueTicketLineageInput = {
  predecessorEntitlementId: string;
  newTicketNumber: string;
  fareDifferenceAmountMinor: number;
};

export type NormalizedReissueCompletion = {
  tickets: ReissueTicketLineageInput[];
  totalFareDifferenceAmountMinor: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeReissueCompletion(
  tickets: readonly ReissueTicketLineageInput[],
): NormalizedReissueCompletion {
  if (tickets.length === 0) {
    throw new Error('At least one reissued ticket is required.');
  }

  const entitlementIds = new Set<string>();
  const ticketNumbers = new Set<string>();
  const normalizedTickets = tickets.map((ticket) => {
    const predecessorEntitlementId = ticket.predecessorEntitlementId.trim().toLowerCase();
    const newTicketNumber = ticket.newTicketNumber.trim().toUpperCase();
    if (!UUID_PATTERN.test(predecessorEntitlementId)) {
      throw new Error('Each predecessor entitlement ID must be a UUID.');
    }
    if (newTicketNumber.length === 0 || newTicketNumber.length > 80) {
      throw new Error('Each new ticket number must contain 1 to 80 characters.');
    }
    if (
      !Number.isSafeInteger(ticket.fareDifferenceAmountMinor) ||
      ticket.fareDifferenceAmountMinor < 0
    ) {
      throw new Error('Each fare-difference allocation must be a non-negative minor-unit integer.');
    }
    if (entitlementIds.has(predecessorEntitlementId)) {
      throw new Error('A predecessor entitlement can appear only once.');
    }
    if (ticketNumbers.has(newTicketNumber)) {
      throw new Error('A new ticket number can appear only once.');
    }
    entitlementIds.add(predecessorEntitlementId);
    ticketNumbers.add(newTicketNumber);
    return {
      predecessorEntitlementId,
      newTicketNumber,
      fareDifferenceAmountMinor: ticket.fareDifferenceAmountMinor,
    };
  });

  normalizedTickets.sort((left, right) =>
    left.predecessorEntitlementId.localeCompare(right.predecessorEntitlementId),
  );
  const totalFareDifferenceAmountMinor = normalizedTickets.reduce(
    (total, ticket) => total + ticket.fareDifferenceAmountMinor,
    0,
  );
  if (!Number.isSafeInteger(totalFareDifferenceAmountMinor)) {
    throw new Error('The allocated fare difference exceeds the supported minor-unit range.');
  }
  return { tickets: normalizedTickets, totalFareDifferenceAmountMinor };
}
