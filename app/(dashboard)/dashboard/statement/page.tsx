import { notFound, redirect } from 'next/navigation';

import AccountLedgerDashboard from '@/components/dashboard/wallet/AccountLedgerDashboard';
import UserAccountLedgerDashboard from '@/components/dashboard/wallet/UserAccountLedgerDashboard';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  canReadWallet,
  walletOwnerForSession,
} from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

export default async function StatementPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (canReadWallet(session.role)) return <AccountLedgerDashboard />;
  if (!walletOwnerForSession(session)) notFound();
  return <UserAccountLedgerDashboard />;
}
