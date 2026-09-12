import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getDashboardSession } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Booking Decisions — Kaliganj Travels',
};

/** Compatibility redirect: decisions now live on each booking detail page. */
export default async function SafetyCasesPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin') notFound();
  redirect('/dashboard/bookings');
}
