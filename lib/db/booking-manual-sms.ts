import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export const BOOKING_MANUAL_SMS_MAX_SENDS = 3;

export type BookingManualSmsStatus = {
  recipientNumber: string;
  sentCount: number;
  reservedCount: number;
  remainingSends: number;
};

export type BookingManualSmsClaim = BookingManualSmsStatus & {
  deliveryId: string;
  claimToken: string;
  claimState: 'claimed' | 'sent' | 'processing';
  messageText: string;
};

type StatusRow = {
  recipient_number: string;
  sent_count: number | string;
  reserved_count: number | string;
  remaining_sends: number | string;
};

type ClaimRow = StatusRow & {
  delivery_id: string;
  claim_token: string;
  claim_state: BookingManualSmsClaim['claimState'];
  message_text: string;
};

export class BookingManualSmsError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'BookingManualSmsError';
  }
}

function databaseError(error: { message?: string } | null): BookingManualSmsError {
  const message = error?.message ?? 'SMS delivery storage is unavailable.';
  if (message.includes('BOOKING_SMS_LIMIT_REACHED')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_LIMIT_REACHED',
      'This booking has reached the maximum of three SMS sends.'
    );
  }
  if (message.includes('BOOKING_SMS_RECIPIENT_UNAVAILABLE')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_RECIPIENT_UNAVAILABLE',
      'The agency mobile number is missing or invalid.'
    );
  }
  if (message.includes('BOOKING_SMS_RECIPIENT_ALREADY_USED')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_RECIPIENT_ALREADY_USED',
      'This mobile number has already received the manual SMS for this booking. Enter a different number.'
    );
  }
  if (message.includes('BOOKING_SMS_MESSAGE_INVALID')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_MESSAGE_INVALID',
      'Enter an SMS message between 1 and 480 characters.'
    );
  }
  if (message.includes('BOOKING_SMS_NOT_CONFIRMED')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_NOT_CONFIRMED',
      'Only a confirmed booking can be sent by SMS.'
    );
  }
  if (message.includes('BOOKING_SMS_UNAVAILABLE')) {
    return new BookingManualSmsError(
      'BOOKING_SMS_UNAVAILABLE',
      'SMS is unavailable for this booking.'
    );
  }
  return new BookingManualSmsError(
    'BOOKING_SMS_STORAGE_UNAVAILABLE',
    'SMS delivery storage is unavailable. Please try again.'
  );
}

function statusFromRow(row: StatusRow): BookingManualSmsStatus {
  return {
    recipientNumber: row.recipient_number,
    sentCount: Number(row.sent_count) || 0,
    reservedCount: Number(row.reserved_count) || 0,
    remainingSends: Math.max(0, Number(row.remaining_sends) || 0),
  };
}

export async function readBookingManualSmsStatus(
  bookingId: string
): Promise<BookingManualSmsStatus> {
  const supabase = supabaseAdmin();
  if (!supabase) throw databaseError(null);
  const { data, error } = await supabase.rpc('read_booking_manual_sms_status_v2', {
    p_booking_id: bookingId,
  });
  if (error) throw databaseError(error);
  const row = (data as StatusRow[] | null)?.[0];
  if (!row) throw databaseError(null);
  return statusFromRow(row);
}

export async function claimBookingManualSmsSend(input: {
  bookingId: string;
  actorUserId: string;
  requestId: string;
  recipientNumber: string;
  messageText: string;
}): Promise<BookingManualSmsClaim> {
  const supabase = supabaseAdmin();
  if (!supabase) throw databaseError(null);
  const { data, error } = await supabase.rpc('claim_booking_manual_sms_send_v2', {
    p_booking_id: input.bookingId,
    p_actor_user_id: input.actorUserId,
    p_request_id: input.requestId,
    p_recipient_number: input.recipientNumber,
    p_message_text: input.messageText,
  });
  if (error) throw databaseError(error);
  const row = (data as ClaimRow[] | null)?.[0];
  if (!row || typeof row.message_text !== 'string' || !row.message_text) {
    throw databaseError(null);
  }
  return {
    ...statusFromRow(row),
    deliveryId: row.delivery_id,
    claimToken: row.claim_token,
    claimState: row.claim_state,
    messageText: row.message_text,
  };
}

export async function markBookingManualSmsSent(input: {
  deliveryId: string;
  claimToken: string;
  providerMessageId?: string | null;
}): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) throw databaseError(null);
  const { data, error } = await supabase.rpc('mark_booking_manual_sms_sent_v1', {
    p_delivery_id: input.deliveryId,
    p_claim_token: input.claimToken,
    p_provider_message_id: input.providerMessageId ?? null,
  });
  if (error || Number(data) < 0) throw databaseError(error);
  return Number(data);
}

export async function failBookingManualSmsSend(input: {
  deliveryId: string;
  claimToken: string;
  error: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) throw databaseError(null);
  const { data, error } = await supabase.rpc('fail_booking_manual_sms_send_v1', {
    p_delivery_id: input.deliveryId,
    p_claim_token: input.claimToken,
    p_error: input.error.slice(0, 1_000),
  });
  if (error || data !== true) throw databaseError(error);
}
