import 'server-only';

import {
  claimBookingIssuedSmsDeliveries,
  failBookingIssuedSms,
  markBookingIssuedSmsSent,
  type BookingIssuedSmsClaim,
} from '@/lib/db/booking-issued-sms';
import { bookingIssuedSmsMessage } from '@/lib/sms/booking-issued-message';
import { sendBulkSmsBdText } from '@/lib/sms/bulksmsbd';

export type SmsDeliveryCounts = { attempted: number; sent: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'SMS delivery failed.';
}

async function processClaim(claim: BookingIssuedSmsClaim): Promise<boolean> {
  try {
    const message = bookingIssuedSmsMessage(claim.contentSnapshot);
    const result = await sendBulkSmsBdText({
      to: claim.recipientNumber,
      message,
    });
    if (!await markBookingIssuedSmsSent({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      providerMessageId: result.providerMessageId,
    })) {
      throw new Error('SMS send succeeded but completion was not recorded.');
    }
    return true;
  } catch (error) {
    console.error(
      '[sms] issued-ticket delivery failed:',
      claim.occurrenceId,
      claim.recipientNumberHash,
      error
    );
    try {
      await failBookingIssuedSms({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        error: errorMessage(error),
      });
    } catch (recordError) {
      console.error(
        '[sms] issued-ticket failure outcome could not be recorded:',
        claim.occurrenceId,
        recordError
      );
    }
    return false;
  }
}

/** Immediately delivers any due B2B partner issued-ticket SMS for one booking. */
export async function dispatchBookingIssuedSms(
  bookingId: string
): Promise<SmsDeliveryCounts> {
  const claims = await claimBookingIssuedSmsDeliveries(5, bookingId);
  let sent = 0;
  for (const claim of claims) {
    if (await processClaim(claim)) sent += 1;
  }
  return { attempted: claims.length, sent };
}

/** Bounded scheduler worker for confirmations not completed in the request. */
export async function dispatchPendingBookingIssuedSms(
  limit = 10
): Promise<SmsDeliveryCounts> {
  const claims = await claimBookingIssuedSmsDeliveries(limit);
  let sent = 0;
  for (const claim of claims) {
    if (await processClaim(claim)) sent += 1;
  }
  return { attempted: claims.length, sent };
}
