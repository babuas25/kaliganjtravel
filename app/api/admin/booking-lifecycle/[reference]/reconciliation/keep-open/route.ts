import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canViewBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  readBookingReconciliationActionState,
  recordBookingReconciliationKeepOpen,
} from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  caseId: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  evidenceObservationId: z.string().uuid(),
  requestId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
  confirmation: z.literal(true),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([getDashboardSession(), params]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canViewBookingReconciliation(session.role)) return walletFail(403, 'KEEP_OPEN_FORBIDDEN', 'Reconciliation access is required.');
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) return walletFail(503, 'RECONCILIATION_ACTIONS_DISABLED', 'Reconciliation actions are not enabled for this rollout stage.');
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) return walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return walletFail(400, 'INVALID_KEEP_OPEN_NOTE', parsed.error.issues[0]?.message ?? 'Check the investigation note.');
  const limit = await checkActionLimit('bookingReconciliationWrite', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RECONCILIATION_RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds), { retryAfterSeconds: limit.retryAfterSeconds });
  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');

  const current = await readBookingReconciliationActionState(booking.id, parsed.data.caseId);
  if (!current || current.version !== parsed.data.expectedCaseVersion) {
    return walletFail(409, 'CASE_VERSION_CONFLICT', 'The case changed. Refresh it before adding an investigation note.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.reconciliation.keep_open',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: { caseId: parsed.data.caseId, evidenceObservationId: parsed.data.evidenceObservationId, reasonRecorded: true, statusMutation: false, walletMutation: false },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) return walletFail(503, 'RECONCILIATION_AUDIT_UNAVAILABLE', 'The note could not be audited and was not recorded.');
  const result = await recordBookingReconciliationKeepOpen({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    evidenceObservationId: parsed.data.evidenceObservationId,
    actorUserId: session.clerkId,
    requestKey: `reconciliation-keep-open:v1:${parsed.data.requestId}`,
    reason: parsed.data.reason,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: result.code ?? 'KEEP_OPEN_FAILED' } });
    return walletFail(409, result.code ?? 'KEEP_OPEN_FAILED', 'The case was not changed and the investigation note was not recorded.');
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded', metadata: { ...audit.metadata, replay: result.replay === true } });
  return walletOk(result);
}
