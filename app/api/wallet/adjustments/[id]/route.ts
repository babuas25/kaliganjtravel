import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { reviewAdjustment } from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { walletFail, walletOperationResponse } from '@/lib/wallet/http';
import { canManageWallet } from '@/lib/wallet/permissions';

const schema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approved'),
    remarks: z.string().trim().max(1000).optional(),
  }),
  z.object({
    decision: z.literal('rejected'),
    remarks: z
      .string()
      .trim()
      .min(3, 'Enter a rejection cause.')
      .max(1000),
  }),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const [session, { id }] = await Promise.all([getDashboardSession(), params]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canManageWallet(session.role)) return walletFail(403, 'FORBIDDEN', 'Wallet mutation access is required.');
  if (!z.string().uuid().safeParse(id).success) return walletFail(400, 'INVALID_REQUEST', 'Invalid adjustment request.');
  const limit = await checkActionLimit('walletManage', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many wallet actions.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_DECISION',
      parsed.error.issues[0]?.message ?? 'Choose approve or reject.'
    );
  }
  const result = await reviewAdjustment(id, parsed.data.decision, session, parsed.data.remarks);
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `wallet.adjustment.${parsed.data.decision}`,
    targetType: 'wallet_adjustment_request',
    targetId: id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: { code: result.code ?? null },
  });
  return walletOperationResponse(result);
}
