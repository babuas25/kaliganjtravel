import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import SupplierControlPanel from '@/components/dashboard/SupplierControlPanel';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import { isTriploverConfigured } from '@/lib/triplover/config';

export const metadata: Metadata = {
  title: 'Supplier Control — Kaliganj Travels',
};

export default async function SupplierControlPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin') notFound();

  const controls = await getSupplierOperationalControls();
  return (
    <SupplierControlPanel
      controls={controls}
      supplierConfigured={{
        firsttrip: isTriploverConfigured('firsttrip'),
        takeoff: isTriploverConfigured('takeoff'),
        triplover: isTriploverConfigured('triplover'),
      }}
    />
  );
}
