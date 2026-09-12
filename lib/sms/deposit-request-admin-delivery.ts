import 'server-only';

import {
  claimDepositRequestAdminSmsDeliveries,
  failDepositRequestAdminSms,
  markDepositRequestAdminSmsSent,
  type DepositRequestAdminSmsClaim,
} from '@/lib/db/deposit-request-admin-sms';
import { sendBulkSmsBdText } from '@/lib/sms/bulksmsbd';
import { depositRequestAdminSmsMessage } from '@/lib/sms/deposit-request-admin-message';

export type DepositRequestAdminSmsDeliveryCounts = { attempted: number; sent: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'SMS delivery failed.';
}

async function processClaim(claim: DepositRequestAdminSmsClaim): Promise<boolean> {
  try {
    const result = await sendBulkSmsBdText({
      to: claim.recipientNumber,
      message: depositRequestAdminSmsMessage(claim.contentSnapshot),
    });
    if (!await markDepositRequestAdminSmsSent({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      providerMessageId: result.providerMessageId,
    })) {
      throw new Error('SMS send succeeded but completion was not recorded.');
    }
    return true;
  } catch (error) {
    console.error(
      '[sms] deposit request admin delivery failed:',
      claim.depositRequestId,
      claim.recipientNumberHash,
      error
    );
    try {
      await failDepositRequestAdminSms({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        error: errorMessage(error),
      });
    } catch (recordError) {
      console.error(
        '[sms] deposit request admin failure outcome could not be recorded:',
        claim.depositRequestId,
        recordError
      );
    }
    return false;
  }
}

/** Immediately alerts both fixed admin recipients for one new B2B request. */
export async function dispatchDepositRequestAdminSms(
  depositRequestId: string
): Promise<DepositRequestAdminSmsDeliveryCounts> {
  const claims = await claimDepositRequestAdminSmsDeliveries(2, depositRequestId);
  const outcomes = await Promise.all(claims.map(processClaim));
  return {
    attempted: claims.length,
    sent: outcomes.filter(Boolean).length,
  };
}

/** Bounded scheduler worker for admin alerts needing retry. */
export async function dispatchPendingDepositRequestAdminSms(
  limit = 10
): Promise<DepositRequestAdminSmsDeliveryCounts> {
  const claims = await claimDepositRequestAdminSmsDeliveries(limit);
  let sent = 0;
  for (const claim of claims) {
    if (await processClaim(claim)) sent += 1;
  }
  return { attempted: claims.length, sent };
}
