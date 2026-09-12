import 'server-only';

import { readAirTicketingDetails, type AirTicketingDetails } from '@/lib/triplover/air-ticketing-details';
import type { TriploverSupplier } from '@/lib/triplover/config';
import type { TicketIssueOutcome } from '@/lib/triplover/ticket';

/** Supplement a successful issue before its immutable notification snapshot. */
export async function enrichIssuedTicket(
  outcome: TicketIssueOutcome,
  uniqueTransId: string,
  supplier: TriploverSupplier
): Promise<{
  outcome: TicketIssueOutcome & { airlinesPnr: string[] };
  ticketDetails: AirTicketingDetails | null;
}> {
  const fallback = { outcome: { ...outcome, airlinesPnr: [] }, ticketDetails: null };
  try {
    const report = await readAirTicketingDetails(uniqueTransId, 'Confirmed', supplier, 5000);
    const identity = report.reconciliationEvidenceV2?.bookingIdentity;
    const expectedTickets = [...outcome.ticketNumbers].sort();
    const reportTickets = [...report.ticketNumbers].sort();
    if (!['confirmed', 'issued', 'ticketed'].includes(report.supplierStatus?.trim().toLowerCase() ?? '') ||
        (identity?.transactionId && identity.transactionId !== uniqueTransId) ||
        (identity?.identityConflicts.length ?? 0) > 0 ||
        report.ticketCodeRef !== outcome.ticketCodeRef ||
        expectedTickets.length === 0 ||
        expectedTickets.length !== reportTickets.length ||
        !expectedTickets.every((ticket, index) => ticket === reportTickets[index])) {
      return fallback;
    }
    return {
      outcome: { ...outcome, airlinesPnr: report.airlinesPnr },
      ticketDetails: report,
    };
  } catch {
    // The ticket is already issued. A missing/delayed report must not prevent
    // wallet capture. Empty enrichment preserves the previously known locator.
    return fallback;
  }
}
