import { notFound, redirect } from 'next/navigation';

import FinancialWalletManager from '@/components/dashboard/wallet/FinancialWalletManager';
import UserWalletDashboard from '@/components/dashboard/wallet/UserWalletDashboard';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  canRefundBooking,
  canManageWallet,
  canReadWallet,
  walletOwnerForSession,
} from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

export default async function WalletPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (canReadWallet(session.role)) {
    return (
      <FinancialWalletManager
        canManageBankAccounts={session.role === 'superadmin'}
        canMutateWallets={canManageWallet(session.role)}
        canRefundBookings={canRefundBooking(session.role)}
      />
    );
  }
  if (!walletOwnerForSession(session)) notFound();
  return <UserWalletDashboard />;
}
