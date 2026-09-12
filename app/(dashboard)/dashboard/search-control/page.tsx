import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import FlightSearchControlPanel from '@/components/dashboard/FlightSearchControlPanel';
import { getDashboardSession } from '@/lib/dashboard/session';
import { dashboardFeatureEnabled } from '@/lib/dashboard/features';
import { readFlightSearchUsageReport } from '@/lib/db/flight-search-usage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Flight Search Control — Kaliganj Travels',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dhakaToday(): string {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    values.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export default async function FlightSearchControlPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [session, query] = await Promise.all([getDashboardSession(), searchParams]);
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin' || !dashboardFeatureEnabled('search-control')) notFound();
  const today = dhakaToday();
  const fromDate = DATE.test(query.from ?? '') ? query.from! : today;
  const toDate = DATE.test(query.to ?? '') ? query.to! : today;
  const safeFrom = fromDate <= toDate ? fromDate : toDate;
  const safeTo = fromDate <= toDate ? toDate : fromDate;
  const report = await readFlightSearchUsageReport({
    from: `${safeFrom}T00:00:00+06:00`,
    to: `${nextDate(safeTo)}T00:00:00+06:00`,
  });
  return (
    <FlightSearchControlPanel
      report={report}
      fromDate={safeFrom}
      toDate={safeTo}
    />
  );
}
