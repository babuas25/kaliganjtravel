import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { findDepositRequest, reviewDeposit } from '@/lib/db/wallet';
import { sendDepositRequestDecisionEmail } from '@/lib/email/notifications';
import { checkActionLimit } from '@/lib/rate-limit';
import { dispatchDepositApprovedSms } from '@/lib/sms/deposit-approved-delivery';
import { canManageWallet } from '@/lib/wallet/permissions';
import { walletFail, walletOperationResponse } from '@/lib/wallet/http';

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

function depositMethodLabel(method: 'cash' | 'bank' | 'bank_transfer' | 'mobile' | 'cheque') {
  switch (method) {
    case 'cash':
      return 'Cash deposit';
    case 'bank':
      return 'Bank deposit';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'mobile':
      return 'Mobile financial service';
    case 'cheque':
      return 'Cheque deposit';
  }
}

function formatDepositAmount(amountMinor: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const [session, { id }] = await Promise.all([getDashboardSession(), params]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canManageWallet(session.role)) {
    return walletFail(403, 'FORBIDDEN', 'Wallet mutation access is required.');
  }
  if (!z.string().uuid().safeParse(id).success) {
    return walletFail(400, 'INVALID_REQUEST', 'Invalid deposit request.');
  }
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
  const result = await reviewDeposit(
    id,
    parsed.data.decision,
    session,
    parsed.data.remarks
  );
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `wallet.deposit.${parsed.data.decision}`,
    targetType: 'wallet_deposit_request',
    targetId: id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: { code: result.code ?? null },
  });

  if (result.ok) {
    // The money movement is already committed. A delivery failure is recorded
    // for follow-up but can never reverse a completed maker-checker decision.
    const deposit = await findDepositRequest(id).catch((error) => {
      console.error('[wallet] reviewed deposit could not be loaded for notification:', id, error);
      return null;
    });
    if (!deposit) {
      console.error('[wallet] reviewed deposit could not be loaded for notification:', id);
    } else {
      try {
        await sendDepositRequestDecisionEmail({
          requesterUserId: deposit.requested_by_user_id,
          requestReference: deposit.public_ref,
          amount: formatDepositAmount(deposit.amount, deposit.currency),
          paymentMethod: depositMethodLabel(deposit.method),
          transactionReference: deposit.reference_number,
          depositDate: deposit.deposit_date,
          decision: parsed.data.decision,
          reviewRemarks: deposit.review_remarks,
        });
      } catch (error) {
        console.error('[wallet] deposit decision email delivery failed:', error);
      }
      if (parsed.data.decision === 'approved') {
        try {
          await dispatchDepositApprovedSms(deposit.id);
        } catch (error) {
          console.error('[wallet] deposit approval SMS delivery failed:', error);
        }
      }
    }
  }

  return walletOperationResponse(result);
}
