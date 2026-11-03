import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export const BOOKING_PAYMENT_EFFECTS = ['capture_hold', 'already_paid', 'charge_wallet'] as const;
export type BookingPaymentEffect = typeof BOOKING_PAYMENT_EFFECTS[number];

export type TicketPaymentPreview = {
  ok: boolean;
  eligible?: boolean;
  code?: string;
  paymentEffect?: BookingPaymentEffect;
  amount?: number;
  existingHoldAmount?: number;
  currency?: string;
};

export type PaymentReturnPreview = {
  ok: boolean;
  eligible?: boolean;
  code?: string;
  captureLedgerEntryId?: string;
  capturedAmount?: number;
  refundedAmount?: number;
  refundableAmount?: number;
  currency?: string;
  availableBalance?: number;
  holdBalance?: number;
};

export type BookingPaymentReturnContext = {
  canReturn: boolean;
  capturedAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  holdBalance: number;
  captureLedgerEntryId?: string;
};

type ActorBooking = { bookingId: string; actorUserId: string; actorRole: string };

async function preview<T extends { ok: boolean; code?: string }>(name: string, input: ActorBooking): Promise<T> {
  const db = supabaseAdmin();
  if (!db) return { ok: false, code: 'STORAGE_UNAVAILABLE' } as T;
  try {
    const { data, error } = await db.rpc(name, {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_actor_role: input.actorRole,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
      return { ok: false, code: 'STORAGE_UNAVAILABLE' } as T;
    }
    return data as T;
  } catch {
    return { ok: false, code: 'STORAGE_UNAVAILABLE' } as T;
  }
}

export function previewShaponTicketPayment(input: ActorBooking): Promise<TicketPaymentPreview> {
  return preview('preview_shapon_ticket_payment_v1', input);
}

export async function readBookingPaymentReturnContext(input: ActorBooking): Promise<BookingPaymentReturnContext | null> {
  const result = await preview<PaymentReturnPreview>('preview_booking_payment_return_v1', input);
  if (result.ok !== true) return null;
  const fields = [result.capturedAmount, result.refundedAmount, result.refundableAmount,
    result.availableBalance, result.holdBalance];
  if (fields.some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
      typeof result.currency !== 'string' || !/^[A-Z]{3}$/.test(result.currency)) return null;
  const captured = result.capturedAmount!;
  const refunded = result.refundedAmount!;
  const refundable = result.refundableAmount!;
  const available = result.availableBalance!;
  if (captured !== refunded + refundable || !Number.isSafeInteger(available + refundable)) return null;
  return {
    canReturn: result.eligible === true && refundable > 0 && Boolean(result.captureLedgerEntryId),
    capturedAmount: captured / 100, refundedAmount: refunded / 100,
    refundableAmount: refundable / 100, currency: result.currency,
    availableBefore: available / 100, availableAfter: (available + refundable) / 100,
    holdBalance: result.holdBalance! / 100,
    ...(result.captureLedgerEntryId ? { captureLedgerEntryId: result.captureLedgerEntryId } : {}),
  };
}
