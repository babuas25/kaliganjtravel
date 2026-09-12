import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canAcquireBookingLifecycleEvidence } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordBookingNonissuanceAttestation } from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  caseId: z.string().uuid(),
  relatedSupplierObservationId: z.string().uuid(),
  requestId: z.string().uuid(),
  basis: z.enum([
    'held_plus_no_ticket_record',
    'supplier_confirmed_unissued',
  ]),
  portalEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

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
      'NONISSUANCE_ATTESTATION_FORBIDDEN',
      'Supplier evidence access is required.'
    );
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(
      503,
      'RECONCILIATION_ACTIONS_DISABLED',
      'Non-issuance attestations are not enabled for this rollout stage.'
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
      'INVALID_NONISSUANCE_ATTESTATION',
      parsed.error.issues[0]?.message ?? 'Check the non-issuance attestation.'
    );
  }
  const limit = await checkActionLimit(
    'bookingReconciliationWrite',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'RECONCILIATION_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.reconciliation.nonissuance_attestation_request',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      relatedSupplierObservationId: parsed.data.relatedSupplierObservationId,
      basis: parsed.data.basis,
      portalEvidenceHash: parsed.data.portalEvidenceHash,
      rawPortalEvidenceStored: false,
      statusMutation: false,
      walletMutation: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'RECONCILIATION_AUDIT_UNAVAILABLE',
      'The attestation could not be audited and was not recorded.'
    );
  }
  const result = await recordBookingNonissuanceAttestation({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    relatedSupplierObservationId: parsed.data.relatedSupplierObservationId,
    actorUserId: session.clerkId,
    requestKey: `nonissuance-attestation:v1:${parsed.data.requestId}`,
    basis: parsed.data.basis,
    portalEvidenceHash: parsed.data.portalEvidenceHash,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: {
        ...audit.metadata,
        failureCode: result.code ?? 'ATTESTATION_FAILED',
      },
    });
    return walletFail(
      result.code === 'ATTESTATION_FORBIDDEN' ? 403 : 409,
      result.code ?? 'NONISSUANCE_ATTESTATION_FAILED',
      'The non-issuance attestation was not accepted.'
    );
  }
  return walletOk(result);
}
