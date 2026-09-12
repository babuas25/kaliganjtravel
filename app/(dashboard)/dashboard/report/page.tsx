import { notFound, redirect } from 'next/navigation';

import WalletReportDashboard from '@/components/dashboard/wallet/WalletReportDashboard';
import UserWalletDashboard from '@/components/dashboard/wallet/UserWalletDashboard';
import B2BIssuedTicketReport from '@/components/dashboard/reports/B2BIssuedTicketReport';
import AdminReportDashboard from '@/components/dashboard/reports/AdminReportDashboard';
import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import {
  canReadWallet,
  walletOwnerForSession,
} from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (
    session.role === 'superadmin' ||
    session.role === 'admin' ||
    session.role === 'staff_account'
  ) {
    const agencies = await listAgencies();
    return <AdminReportDashboard agencies={agencies} />;
  }
  if (canReadWallet(session.role)) return <WalletReportDashboard />;
  if (session.role === 'b2b' || session.role === 'b2b_sub') {
    if (!session.agencyCode) notFound();
    return <B2BIssuedTicketReport />;
  }
  if (!walletOwnerForSession(session)) notFound();
  return (
    <UserWalletDashboard initialTab="transaction" />
  );
}
