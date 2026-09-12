import { NextRequest } from 'next/server';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  readActiveBookingOperationState,
} from '@/lib/db/booking-operations';
import { readBookingLocalTimeLimitContext } from '@/lib/db/booking-local-time-limit';
import { readOpenBookingReconciliationCaseForBooking } from '@/lib/db/booking-reconciliation-evidence';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { readWalletForOwner } from '@/lib/db/wallet';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canIssueBooking } from '@/lib/wallet/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only post-write recovery state for the Issue Ticket panel.  It never
 * calls a supplier, creates a wallet, reserves funds, or changes a booking.
 * The client deliberately treats `canSubmit !== true` as a lock.
 */
export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');

  const reference = request.nextUrl.searchParams.get('reference') ?? '';
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(
      400,
      'INVALID_BOOKING_REFERENCE',
      'Check the booking reference.'
    );
  }

  const booking = await readBookingByPublicRef(
    reference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');

  let operationState;
  let openReconciliationCase;
  let localTimeLimit;
  let wallet;
  try {
    [operationState, openReconciliationCase, localTimeLimit, wallet] = await Promise.all([
      readActiveBookingOperationState(booking.id),
      readOpenBookingReconciliationCaseForBooking(booking.id),
      readBookingLocalTimeLimitContext(booking.id),
      booking.booking_owner_type && booking.booking_owner_key
        ? readWalletForOwner(
            {
              ownerType: booking.booking_owner_type,
              ownerKey: booking.booking_owner_key,
            },
            booking.currency
          )
        : Promise.resolve(null),
    ]);
  } catch {
    return walletFail(
      503,
      'ISSUE_STATUS_UNAVAILABLE',
      'Ticketing status could not be checked. Do not submit again until it refreshes.'
    );
  }

  const supplierControls = await getSupplierOperationalControls();
  const supplierPnr = booking.booking_ref_number || booking.pnr;
  const refs = booking.supplier_refs;
  const localDeadlineExpired = Boolean(
    localTimeLimit.localGrantActive &&
      localTimeLimit.localDeadlineAt &&
      Date.parse(localTimeLimit.localDeadlineAt) <= Date.now()
  );
  const localTimeLimitBlocked = Boolean(
    localTimeLimit.requestRequired && !localTimeLimit.localDeadlineActive
  );
  const reconciliationRequired =
    booking.payment_state === 'reconciliation' ||
    operationState === 'needs_reconciliation' ||
    Boolean(openReconciliationCase);
  const operationActive = operationState !== null;
  const supplierReferencesReady = Boolean(
    supplierPnr &&
      booking.booking_code_ref &&
      refs?.uniqueTransId &&
      refs.itemCodeRef &&
      refs.priceCodeRef
  );
  const requiredAmount =
    booking.payment_state === 'captured'
      ? 0
      : Math.round(Number(booking.pricing_snapshot.sellingPrice) * 100);
  const walletCanFund = Boolean(
    wallet &&
      wallet.status === 'active' &&
      wallet.availableBalance >= requiredAmount
  );

  // This is intentionally a preview gate only. The POST claims the operation
  // atomically and remains the authoritative duplicate-write guard.
  const canSubmit = Boolean(
    supplierControls.ticketingEnabled &&
      booking.import_source !== 'MANUAL' &&
      booking.supplier === 'triplover' &&
      isTriploverSupplier(booking.supplier_account) &&
      !localDeadlineExpired &&
      !localTimeLimitBlocked &&
      !reconciliationRequired &&
      !operationActive &&
      supplierReferencesReady &&
      walletCanFund &&
      canIssueBooking(session, booking)
  );

  return walletOk({
    lifecycleStatus: booking.lifecycle_status ?? booking.status,
    paymentState: booking.payment_state,
    operationState,
    openReconciliationCase: Boolean(openReconciliationCase),
    reconciliationRequired,
    canSubmit,
    wallet: wallet
      ? {
          availableBalance: wallet.availableBalance,
          holdBalance: wallet.holdBalance,
          currency: wallet.currency,
          status: wallet.status,
        }
      : null,
    requiredAmount,
  });
}
