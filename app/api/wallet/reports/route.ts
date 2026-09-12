import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import {
  listAdjustmentRequests,
  listAllLedger,
  listDepositRequests,
  listWallets,
} from '@/lib/db/wallet';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canReadWallet(session.role)) return walletFail(403, 'FORBIDDEN', 'Wallet read access is required.');
  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  try {
    const [allWallets, transactions, bookingResult, agencies, deposits, adjustments] = await Promise.all([
      listWallets(null),
      listAllLedger(1000),
      supabase
        .from('booking_payment_report_v')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000),
      listAgencies(),
      listDepositRequests(undefined, 1000),
      listAdjustmentRequests(),
    ]);
    if (bookingResult.error) {
      console.error('[wallet] booking payment report failed:', bookingResult.error.message);
      return walletFail(503, 'STORAGE_ERROR', 'The booking payment report is unavailable.');
    }

    const totalsByCurrency = Object.values(allWallets.reduce(
      (groups, wallet) => {
        const totals = groups[wallet.currency] ?? {
          currency: wallet.currency,
          available: 0,
          hold: 0,
          total: 0,
        };
        totals.available += wallet.availableBalance;
        totals.hold += wallet.holdBalance;
        totals.total += wallet.totalBalance;
        groups[wallet.currency] = totals;
        return groups;
      },
      {} as Record<string, { currency: string; available: number; hold: number; total: number }>
    )).sort((left, right) => left.currency.localeCompare(right.currency));
    const walletStatus = new Map(allWallets.map((wallet) => [wallet.walletId, wallet.status]));
    const agencyNames = new Map(
      agencies.map((agency) => [agency.agencyCode, agency.label] as const)
    );
    const depositsByLedgerEntryId = new Map(
      deposits
        .filter(
          (deposit): deposit is typeof deposit & { ledger_entry_id: string } =>
            Boolean(deposit.ledger_entry_id)
        )
        .map((deposit) => [deposit.ledger_entry_id, deposit] as const)
    );
    const adjustmentsByLedgerEntryId = new Map(
      adjustments
        .filter(
          (adjustment): adjustment is typeof adjustment & { ledger_entry_id: string } =>
            Boolean(adjustment.ledger_entry_id)
        )
        .map((adjustment) => [adjustment.ledger_entry_id, adjustment] as const)
    );
    const identityUserIds = Array.from(
      new Set(
        [...transactions.flatMap((transaction) => [
          transaction.createdByUserId,
          ...(transaction.ownerType === 'user' && transaction.ownerKey
            ? [transaction.ownerKey]
            : []),
        ]), ...(bookingResult.data ?? []).flatMap((booking) => [
          booking.booked_by_user_id,
          booking.issued_by_user_id,
          ...(booking.booking_owner_type === 'user' ? [booking.booking_owner_key] : []),
        ])]
          .filter((userId): userId is string => typeof userId === 'string' && Boolean(userId))
      )
    );
    const actorsResult = identityUserIds.length
      ? await supabase
          .from('app_users')
          .select('clerk_id, first_name, last_name, email, role')
          .in('clerk_id', identityUserIds)
      : { data: [], error: null };
    if (actorsResult.error) {
      // Keep the activity report available if the optional identity lookup is
      // unavailable; the immutable ledger data is still the source of truth.
      console.warn('[wallet] activity actor lookup failed:', actorsResult.error.message);
    }
    const actorsById = new Map(
      (actorsResult.data ?? []).map((actor) => {
        const name = [actor.first_name, actor.last_name]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(' ')
          .trim() || actor.email || null;
        return [actor.clerk_id, { name, role: actor.role ?? null }] as const;
      })
    );
    const bdt = totalsByCurrency.find((row) => row.currency === 'BDT') ?? {
      currency: 'BDT', available: 0, hold: 0, total: 0,
    };
    const totals = {
      available: bdt.available,
      hold: bdt.hold,
      total: bdt.total,
      active: Array.from(walletStatus.values()).filter((status) => status === 'active').length,
      frozen: Array.from(walletStatus.values()).filter((status) => status === 'frozen').length,
    };
    return walletOk({
      currency: 'BDT',
      totals,
      totalsByCurrency,
      wallets: allWallets.slice(0, 1000),
      transactions: transactions.map((transaction) => {
        const deposit =
          transaction.transactionType === 'deposit'
            ? depositsByLedgerEntryId.get(transaction.id)
            : undefined;
        const adjustment =
          transaction.transactionType === 'manual_credit' ||
          transaction.transactionType === 'manual_debit'
            ? adjustmentsByLedgerEntryId.get(transaction.id)
            : undefined;
        return {
          ...transaction,
          ownerName:
            transaction.ownerType === 'agency' && transaction.ownerKey
              ? agencyNames.get(transaction.ownerKey) || null
              : transaction.ownerType === 'user' && transaction.ownerKey
                ? actorsById.get(transaction.ownerKey)?.name || null
                : null,
          deposit: deposit
            ? { method: deposit.method, publicRef: deposit.public_ref }
            : null,
          adjustment: adjustment ? { publicRef: adjustment.public_ref } : null,
          processedBy: actorsById.get(transaction.createdByUserId) ?? null,
        };
      }),
      bookingPayments: (bookingResult.data ?? []).map((booking) => ({
        ...booking,
        ownerName: booking.booking_owner_type === 'agency'
          ? agencyNames.get(booking.booking_owner_key) || null
          : actorsById.get(booking.booking_owner_key)?.name || null,
        bookedByName: actorsById.get(booking.booked_by_user_id)?.name || null,
        issuedByName: actorsById.get(booking.issued_by_user_id)?.name || null,
      })),
    });
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet reports are unavailable.');
  }
}
