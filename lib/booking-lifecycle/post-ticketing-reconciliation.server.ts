import 'server-only';

import {
  acquireSupplierEvidence,
  isSupplierEvidenceReadFacts,
  supplierEvidenceFactsHash,
  supplierEvidenceReadIdentity,
} from '@/lib/booking-lifecycle/supplier-evidence-read';
import {
  closeBookingTicketingRaceNoChange,
  readOpenTicketingRaceCase,
  readStoredEvidenceReadObservation,
  recordBookingReconciliationEvidenceRead,
} from '@/lib/db/booking-reconciliation-evidence';
import type { BookingRow } from '@/lib/db/flight-bookings';
import { acquireSecurityLock, releaseSecurityLock } from '@/lib/db/security';

export type PostTicketingReconciliationResult = {
  attempted: boolean;
  closed: boolean;
  replay?: boolean;
  code?: string;
};

/**
 * Acquires new case-bound evidence after NewTicket succeeds and closes only a
 * matching PNR-window race. Supplier failures leave the case open for the
 * existing watchdog/staff workflow and never fail the completed ticket sale.
 */
export async function reconcilePostTicketingRace(input: {
  booking: BookingRow;
  operationId: string;
}): Promise<PostTicketingReconciliationResult> {
  const reconciliationCase = await readOpenTicketingRaceCase(
    input.booking.id,
    input.operationId
  );
  if (!reconciliationCase) return { attempted: false, closed: false };

  const identity = supplierEvidenceReadIdentity({
    // One deterministic five-minute generation deduplicates concurrent/replayed
    // finalizers while allowing a later watchdog/manual run to acquire fresher
    // evidence after a transient supplier failure.
    clientRequestNonce: `${input.operationId}:${Math.floor(Date.now() / 300_000)}`,
    bookingId: input.booking.id,
    caseId: reconciliationCase.id,
    purpose: 'ticketed',
    airTicketingStatus: 'Confirmed',
  });
  const lock = await acquireSecurityLock(identity.lockName, 180);
  if (!lock) return { attempted: true, closed: false, code: 'EVIDENCE_READ_BUSY' };

  try {
    const currentCase = await readOpenTicketingRaceCase(
      input.booking.id,
      input.operationId
    );
    if (!currentCase || currentCase.id !== reconciliationCase.id) {
      return { attempted: true, closed: false, code: 'CASE_NO_LONGER_OPEN' };
    }

    const replay = await readStoredEvidenceReadObservation(
      currentCase.id,
      identity.observationKey
    );
    if (replay && isSupplierEvidenceReadFacts(replay.normalizedFacts)) {
      const closure = await closeBookingTicketingRaceNoChange({
        bookingId: input.booking.id,
        caseId: currentCase.id,
        observationId: replay.id,
      });
      return {
        attempted: true,
        closed: closure.ok && closure.closedNoChange === true,
        replay: true,
        code: closure.code,
      };
    }

    const facts = await acquireSupplierEvidence({
      booking: input.booking,
      caseId: currentCase.id,
      caseType: currentCase.case_type,
      purpose: 'ticketed',
    });
    const stored = await recordBookingReconciliationEvidenceRead({
      bookingId: input.booking.id,
      caseId: currentCase.id,
      actorUserId: 'system:post-ticketing-evidence',
      actorRole: 'system',
      observationKey: identity.observationKey,
      facts,
      factsHash: supplierEvidenceFactsHash(facts),
    });
    if (!stored.ok || !stored.observationId) {
      return {
        attempted: true,
        closed: false,
        code: stored.code ?? 'EVIDENCE_STORAGE_FAILED',
      };
    }
    if (
      !facts.validation.valid ||
      !facts.validation.complete ||
      !facts.validation.fresh ||
      !facts.validation.identityMatches ||
      facts.validation.authoritativeFor !== 'ticketed'
    ) {
      return { attempted: true, closed: false, code: 'EVIDENCE_NOT_AUTHORITATIVE' };
    }

    const closure = await closeBookingTicketingRaceNoChange({
      bookingId: input.booking.id,
      caseId: currentCase.id,
      observationId: stored.observationId,
    });
    return {
      attempted: true,
      closed: closure.ok && closure.closedNoChange === true,
      replay: stored.replay,
      code: closure.code,
    };
  } finally {
    await releaseSecurityLock(lock);
  }
}
