import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Hammer } from 'lucide-react';

import { findNavItem } from '@/lib/roles';
import { getDashboardSession } from '@/lib/dashboard/session';

/**
 * Placeholder for nav sections that aren't built yet, so the sidebar never
 * links to a 404. Only segments the current role is allowed to reach resolve;
 * anything else 404s, so this can't be used to probe made-up routes.
 */
export default async function DashboardSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');

  const { section } = await params;
  const item = findNavItem(session.role, section);
  if (!item) notFound();

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center rounded-lg border border-dashed border-navy-200 bg-white px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
        <Hammer className="h-5 w-5" />
      </span>
      <h2 className="mt-5 text-xl font-semibold text-navy-950">
        {item.label} is coming soon
      </h2>
      <p className="mt-2 max-w-md text-sm text-navy-700/70">
        This section is part of the dashboard plan but hasn&apos;t been built
        yet. It will land once the booking data source is connected.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-brand-orange px-5 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>
    </div>
  );
}
