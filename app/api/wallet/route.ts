import { getDashboardSession } from '@/lib/dashboard/session';
import { ensureSessionWallet, listAccountLedger } from '@/lib/db/wallet';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  try {
    const summary = await ensureSessionWallet(session);
    if (!summary) {
      return walletFail(
        403,
        'NO_PERSONAL_WALLET',
        'This operational account does not own a wallet.'
      );
    }
    const transactions = await listAccountLedger(summary.accountId, 500);
    return walletOk({ summary, transactions });
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
}
