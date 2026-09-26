import { z } from 'zod';
import { getDashboardSession } from '@/lib/dashboard/session';
import { canBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { supabaseAdmin } from '@/lib/supabase/server';
import { shapontravelsReadBooking } from '@/lib/shapontravels/client';
import { verifyShapontravelsBookingStatus } from '@/lib/shapontravels/booking-status';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const uuid = z.string().uuid();
const pendingId = /\bbookingId=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=\b|$)/i;
const pendingReference = /\breference=(STR[A-Z0-9]{6,32})(?=\b|$)/;

/** A supplier read for an already-owned uncertain Book attempt. No replay or local resolution. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canBookingReconciliation(session.role, 'investigate_supplier_evidence')) {
    return walletFail(403, 'INVESTIGATION_FORBIDDEN', 'Supplier investigation access is required.');
  }
  const parsed = uuid.safeParse((await params).id);
  if (!parsed.success) return walletFail(400, 'INVALID_ATTEMPT', 'Invalid booking attempt.');
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const { data: attempt, error } = await db.from('booking_attempts')
    .select('id,supplier,supplier_account,state,unique_trans_id,item_code_ref,price_code_ref,booking_code_ref,pnr,supplier_message')
    .eq('id', parsed.data)
    .maybeSingle();
  if (error) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  if (!attempt || attempt.supplier !== 'shapontravels' ||
      attempt.supplier_account !== 'shapontravels' || attempt.state !== 'unknown') {
    return walletFail(404, 'ATTEMPT_NOT_FOUND', 'No uncertain Shapontravels attempt was found.');
  }
  const { data: ownedCase, error: caseError } = await db.from('booking_reconciliation_cases')
    .select('id')
    .eq('subject_booking_attempt_id', attempt.id)
    .in('state', ['open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'])
    .limit(1)
    .maybeSingle();
  if (caseError) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  if (!ownedCase) return walletFail(409, 'RECONCILIATION_CASE_MISSING',
    'A staff reconciliation case is required before supplier investigation.');

  const message = attempt.supplier_message ?? '';
  const bookingId = attempt.booking_code_ref || pendingId.exec(message)?.[1];
  const reference = pendingReference.exec(message)?.[1];
  if (!bookingId && !reference) {
    return walletFail(409, 'SUPPLIER_LOOKUP_UNAVAILABLE',
      'This attempt has no supplier booking ID or STR reference. Check the supplier portal; do not submit Book again.');
  }
  try {
    const read = await shapontravelsReadBooking(
      bookingId ? { bookingId } : { reference: reference! }
    );
    const status = verifyShapontravelsBookingStatus(read, {
      uniqueTransId: attempt.unique_trans_id,
      itemCodeRef: attempt.item_code_ref,
      priceCodeRef: attempt.price_code_ref,
      bookingCodeRef: bookingId,
      pnr: attempt.pnr,
      supplierPublicRef: reference,
    });
    if (status.result === 'mismatch' || status.result === 'unverified') {
      console.error('[shapontravels] attempt status identity unverified', {
        attemptId: attempt.id, result: status.result,
      });
      return walletFail(409, 'SUPPLIER_IDENTITY_UNVERIFIED',
        'Supplier details did not verify against this attempt. Continue manual reconciliation.');
    }
    return walletOk(status);
  } catch (readError) {
    console.error('[shapontravels] attempt status read failed', {
      attemptId: attempt.id,
      code: readError instanceof Error ? readError.message : 'unknown',
    });
    return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
      'Supplier status is temporarily unavailable. The attempt remains in reconciliation.');
  }
}
