import 'server-only';

import {
  claimDepositApprovedSmsDeliveries,
  failDepositApprovedSms,
  markDepositApprovedSmsSent,
  type DepositApprovedSmsClaim,
} from '@/lib/db/deposit-approved-sms';
import { sendBulkSmsBdText } from '@/lib/sms/bulksmsbd';
import { depositApprovedSmsMessage } from '@/lib/sms/deposit-approved-message';

export type DepositApprovedSmsDeliveryCounts = { attempted: number; sent: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'SMS delivery failed.';
}

async function processClaim(claim: DepositApprovedSmsClaim): Promise<boolean> {
  try {
    const result = await sendBulkSmsBdText({
      to: claim.recipientNumber,
      message: depositApprovedSmsMessage(claim.contentSnapshot),
    });
    if (!await markDepositApprovedSmsSent({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      providerMessageId: result.providerMessageId,
    })) {
      throw new Error('SMS send succeeded but completion was not recorded.');
    }
    return true;
  } catch (error) {
    console.error(
      '[sms] deposit approval delivery failed:',
      claim.depositRequestId,
      claim.recipientNumberHash,
      error
    );
    try {
      await failDepositApprovedSms({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        error: errorMessage(error),
      });
    } catch (recordError) {
      console.error(
        '[sms] deposit approval failure outcome could not be recorded:',
        claim.depositRequestId,
        recordError
      );
    }
    return false;
  }
}

/** Immediately sends a newly committed B2B deposit approval confirmation. */
export async function dispatchDepositApprovedSms(
  depositRequestId: string
): Promise<DepositApprovedSmsDeliveryCounts> {
  const claims = await claimDepositApprovedSmsDeliveries(1, depositRequestId);
  let sent = 0;
  for (const claim of claims) {
    if (await processClaim(claim)) sent += 1;
  }
  return { attempted: claims.length, sent };
}

/** Bounded scheduler worker for approval confirmations needing retry. */
export async function dispatchPendingDepositApprovedSms(
  limit = 10
): Promise<DepositApprovedSmsDeliveryCounts> {
  const claims = await claimDepositApprovedSmsDeliveries(limit);
  let sent = 0;
  for (const claim of claims) {
    if (await processClaim(claim)) sent += 1;
  }
  return { attempted: claims.length, sent };
}
