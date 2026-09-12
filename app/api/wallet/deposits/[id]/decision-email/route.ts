import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { findDepositRequest } from '@/lib/db/wallet';
import { sendDepositRequestDecisionEmail } from '@/lib/email/notifications';
import { checkActionLimit } from '@/lib/rate-limit';
import { canManageWallet } from '@/lib/wallet/permissions';
import { walletFail, walletOk } from '@/lib/wallet/http';

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

export async function POST(
  _request: Request,
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

  const deposit = await findDepositRequest(id);
  if (!deposit) {
    return walletFail(404, 'NOT_FOUND', 'Deposit request not found.');
  }
  if (deposit.status === 'pending') {
    return walletFail(
      409,
      'DECISION_PENDING',
      'A decision email can be sent only after the request is approved or rejected.'
    );
  }

  try {
    await sendDepositRequestDecisionEmail({
      requesterUserId: deposit.requested_by_user_id,
      requestReference: deposit.public_ref,
      amount: formatDepositAmount(deposit.amount, deposit.currency),
      paymentMethod: depositMethodLabel(deposit.method),
      transactionReference: deposit.reference_number,
      depositDate: deposit.deposit_date,
      decision: deposit.status,
      reviewRemarks: deposit.review_remarks,
    });
  } catch (error) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'wallet.deposit.decision_email_resent',
      targetType: 'wallet_deposit_request',
      targetId: id,
      outcome: 'failed',
      metadata: { error: error instanceof Error ? error.message : 'Unknown email error' },
    });
    console.error('[wallet] deposit decision email resend failed:', error);
    return walletFail(503, 'EMAIL_DELIVERY_FAILED', 'The decision email could not be delivered. Please try again.');
  }

  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.deposit.decision_email_resent',
    targetType: 'wallet_deposit_request',
    targetId: id,
    outcome: 'succeeded',
    metadata: { decision: deposit.status },
  });
  return walletOk({ delivered: true });
}
