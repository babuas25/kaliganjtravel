import { redirect } from 'next/navigation';

import PassengerManager from '@/components/dashboard/PassengerManager';
import { getDashboardSession } from '@/lib/dashboard/session';

export default async function CoTravelersPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');

  const isAdmin = session.role === 'superadmin' || session.role === 'admin';
  const title = isAdmin ? 'Passengers' : session.role === 'customer' ? 'Co-Travelers' : 'My Passengers';
  return (
    <PassengerManager
      title={title}
      description="Save only passenger details entered here, then select a matching profile during a flight booking."
      canDelete={isAdmin}
    />
  );
}
