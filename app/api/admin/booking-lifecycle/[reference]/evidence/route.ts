import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  acquireSupplierEvidence,
  airStatusForEvidencePurpose,
  isSupplierEvidenceReadFacts,
  staffSupplierEvidenceReadResult,
  supplierEvidenceFactsHash,
  supplierEvidenceReadIdentity,
  type SupplierEvidenceReadFacts,
} from '@/lib/booking-lifecycle/supplier-evidence-read';
import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canAcquireBookingLifecycleEvidence } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  closeBookingReconciliationNoChange,
  closeBookingTicketingRaceNoChange,
  isOpenBookingReconciliationCaseState,
  readBookingReconciliationCase,
  readStoredEvidenceReadObservation,
  recordBookingReconciliationEvidenceRead,
} from '@/lib/db/booking-reconciliation-evidence';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import {
  acquireSecurityLock,
  recordSecurityAuditEvent,
  releaseSecurityLock,
} from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z
  .object({
    caseId: z.string().uuid(),
    requestId: z.string().uuid(),
    purpose: z.enum(['held', 'ticketed', 'cancelled']),
    cancellationReportStatus: z.enum(['Cancelled', 'Refunded']).optional(),
  })
  .superRefine((value, context) => {
    if (value.purpose !== 'cancelled' && value.cancellationReportStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationReportStatus'],
        message: 'A cancellation report applies only to cancelled evidence.',
      });
    }
  });

function auditMetadata(input: {
  caseId: string;
  purpose: string;
  replay?: boolean;
  recordedSources?: string[];
  issueCodes?: string[];
}) {
  return {
    caseId: input.caseId,
    purpose: input.purpose,
    replay: input.replay ?? false,
    recordedSources: input.recordedSources ?? [],
    validationIssueCodes: input.issueCodes ?? [],
    statusMutation: false,
    walletMutation: false,
    destructiveSupplierCall: false,
  };
}

async function automaticNoChangeClosure(input: {
  bookingId: string;
  bookingStatus: string;
  caseId: string;
  observationId: string;
  facts: SupplierEvidenceReadFacts;
}) {
  const applicable =
    input.facts.validation.valid &&
    ((input.bookingStatus === 'confirmed' &&
      input.facts.validation.authoritativeFor === 'ticketed') ||
      (input.bookingStatus === 'cancelled' &&
        input.facts.validation.authoritativeFor === 'cancelled'));
  let closure = applicable
    ? await closeBookingReconciliationNoChange({
        bookingId: input.bookingId,
        caseId: input.caseId,
        observationId: input.observationId,
      })
    : { ok: false, code: 'NO_CHANGE_CLOSURE_NOT_APPLICABLE' };
  if (applicable && closure.code === 'NO_CHANGE_CLOSURE_NOT_ELIGIBLE') {
    closure = await closeBookingTicketingRaceNoChange({
      bookingId: input.bookingId,
      caseId: input.caseId,
      observationId: input.observationId,
    });
  }
  return {
    attempted: applicable,
    closed: closure.closedNoChange === true,
    replay: closure.replay === true,
    code: closure.code ?? null,
    statusMutation: false as const,
    walletMutation: false as const,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canAcquireBookingLifecycleEvidence(session.role)) {
    return walletFail(
      403,
      'EVIDENCE_READ_FORBIDDEN',
      'Supplier evidence access is required.'
    );
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(
      503,
      'RECONCILIATION_ACTIONS_DISABLED',
      'Supplier evidence actions are not enabled for this rollout stage.'
    );
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_EVIDENCE_REQUEST',
      parsed.error.issues[0]?.message ?? 'Check the evidence request.'
    );
  }

  const limit = await checkActionLimit(
    'bookingEvidenceRead',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'EVIDENCE_READ_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }

  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.supplier !== 'triplover') {
    return walletFail(
      409,
      'EVIDENCE_SOURCE_UNSUPPORTED',
      'This evidence action supports Triplover bookings only.'
    );
  }
  const reconciliationCase = await readBookingReconciliationCase(
    booking.id,
    parsed.data.caseId
  );
  if (!reconciliationCase) {
    return walletFail(
      409,
      'RECONCILIATION_CASE_NOT_OPEN',
      'Select an open reconciliation case before requesting evidence.'
    );
  }

  const airTicketingStatus = airStatusForEvidencePurpose(parsed.data);
  const identity = supplierEvidenceReadIdentity({
    clientRequestNonce: parsed.data.requestId,
    bookingId: booking.id,
    caseId: reconciliationCase.id,
    purpose: parsed.data.purpose,
    airTicketingStatus,
  });

  const replay = await readStoredEvidenceReadObservation(
    reconciliationCase.id,
    identity.observationKey
  );
  if (replay) {
    if (
      !isSupplierEvidenceReadFacts(replay.normalizedFacts) ||
      replay.normalizedFacts.bookingId !== booking.id ||
      replay.normalizedFacts.caseId !== reconciliationCase.id
    ) {
      return walletFail(
        409,
        'EVIDENCE_REPLAY_INVALID',
        'The existing evidence request does not match this case.'
      );
    }
    const result = staffSupplierEvidenceReadResult(replay.normalizedFacts);
    const replayAudited = await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.reconciliation.evidence_read_replay',
      targetType: 'flight_booking',
      targetId: booking.id,
      metadata: auditMetadata({
        caseId: reconciliationCase.id,
        purpose: parsed.data.purpose,
        replay: true,
        recordedSources: result.recordedSources,
        issueCodes: result.validation.issueCodes,
      }),
    });
    if (!replayAudited) {
      return walletFail(
        503,
        'EVIDENCE_AUDIT_UNAVAILABLE',
        'The evidence replay could not be audited. No resolution action was taken.'
      );
    }
    const noChangeClosure = await automaticNoChangeClosure({
      bookingId: booking.id,
      bookingStatus: booking.status,
      caseId: reconciliationCase.id,
      observationId: replay.id,
      facts: replay.normalizedFacts,
    });
    return walletOk({
      caseId: reconciliationCase.id,
      observationId: replay.id,
      replay: true,
      automaticNoChangeClosure: noChangeClosure,
      ...result,
    });
  }
  if (!isOpenBookingReconciliationCaseState(reconciliationCase.state)) {
    return walletFail(
      409,
      'RECONCILIATION_CASE_NOT_OPEN',
      'Select an open reconciliation case before requesting new evidence.'
    );
  }

  const lock = await acquireSecurityLock(identity.lockName, 180);
  if (!lock) {
    return walletFail(
      409,
      'EVIDENCE_READ_IN_PROGRESS',
      'This evidence request is already in progress. Retry the same request shortly.'
    );
  }

  try {
    const lockedReplay = await readStoredEvidenceReadObservation(
      reconciliationCase.id,
      identity.observationKey
    );
    if (lockedReplay && isSupplierEvidenceReadFacts(lockedReplay.normalizedFacts)) {
      const replayResult = staffSupplierEvidenceReadResult(
        lockedReplay.normalizedFacts
      );
      const replayAudited = await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'booking.reconciliation.evidence_read_replay',
        targetType: 'flight_booking',
        targetId: booking.id,
        metadata: auditMetadata({
          caseId: reconciliationCase.id,
          purpose: parsed.data.purpose,
          replay: true,
          recordedSources: replayResult.recordedSources,
          issueCodes: replayResult.validation.issueCodes,
        }),
      });
      if (!replayAudited) {
        return walletFail(
          503,
          'EVIDENCE_AUDIT_UNAVAILABLE',
          'The evidence replay could not be audited. No resolution action was taken.'
        );
      }
      const noChangeClosure = await automaticNoChangeClosure({
        bookingId: booking.id,
        bookingStatus: booking.status,
        caseId: reconciliationCase.id,
        observationId: lockedReplay.id,
        facts: lockedReplay.normalizedFacts,
      });
      return walletOk({
        caseId: reconciliationCase.id,
        observationId: lockedReplay.id,
        replay: true,
        automaticNoChangeClosure: noChangeClosure,
        ...replayResult,
      });
    }

    const attemptedAudit = await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.reconciliation.evidence_read',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'attempted',
      metadata: auditMetadata({
        caseId: reconciliationCase.id,
        purpose: parsed.data.purpose,
      }),
    });
    if (!attemptedAudit) {
      return walletFail(
        503,
        'EVIDENCE_AUDIT_UNAVAILABLE',
        'The evidence read could not be audited. No supplier request was made.'
      );
    }

    const facts = await acquireSupplierEvidence({
      booking,
      caseId: reconciliationCase.id,
      caseType: reconciliationCase.case_type,
      purpose: parsed.data.purpose,
      cancellationReportStatus: parsed.data.cancellationReportStatus,
    });
    const stored = await recordBookingReconciliationEvidenceRead({
      bookingId: booking.id,
      caseId: reconciliationCase.id,
      actorUserId: session.clerkId,
      actorRole: session.role,
      observationKey: identity.observationKey,
      facts,
      factsHash: supplierEvidenceFactsHash(facts),
    });
    if (!stored.ok || !stored.observationId) {
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'booking.reconciliation.evidence_read',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'failed',
        metadata: {
          ...auditMetadata({
            caseId: reconciliationCase.id,
            purpose: parsed.data.purpose,
          }),
          failureCode: stored.code ?? 'EVIDENCE_STORAGE_FAILED',
        },
      });
      return walletFail(
        503,
        stored.code ?? 'EVIDENCE_STORAGE_FAILED',
        'Supplier evidence could not be recorded. Retry the same request.'
      );
    }

    const result = staffSupplierEvidenceReadResult(facts);
    const noChangeClosure = await automaticNoChangeClosure({
      bookingId: booking.id,
      bookingStatus: booking.status,
      caseId: reconciliationCase.id,
      observationId: stored.observationId,
      facts,
    });
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.reconciliation.evidence_read',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'succeeded',
      metadata: auditMetadata({
        caseId: reconciliationCase.id,
        purpose: parsed.data.purpose,
        replay: stored.replay,
        recordedSources: result.recordedSources,
        issueCodes: result.validation.issueCodes,
      }),
    });
    return walletOk({
      caseId: reconciliationCase.id,
      caseVersion: stored.caseVersion,
      observationId: stored.observationId,
      replay: stored.replay === true,
      automaticNoChangeClosure: noChangeClosure,
      ...result,
    });
  } catch (error) {
    console.error('[booking-evidence] staff read failed:', error);
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'booking.reconciliation.evidence_read',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: {
        ...auditMetadata({
          caseId: reconciliationCase.id,
          purpose: parsed.data.purpose,
        }),
        failureCode: 'UNEXPECTED_EVIDENCE_READ_FAILURE',
      },
    });
    return walletFail(
      502,
      'EVIDENCE_READ_FAILED',
      'Supplier evidence could not be acquired. Retry the same request.'
    );
  } finally {
    await releaseSecurityLock(lock);
  }
}
