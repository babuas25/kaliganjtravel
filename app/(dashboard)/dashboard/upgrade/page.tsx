import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AlertTriangle, CheckCircle2, Clock, Rocket } from 'lucide-react';

import UpgradeRequestForm from '@/components/dashboard/UpgradeRequestForm';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getUpgradeRequest } from '@/lib/db/upgrade-requests';
import { canRequestUpgrade } from '@/lib/roles';
import type { UpgradeValues } from '@/lib/upgrade';

export const metadata: Metadata = {
  title: 'Upgrade to Business — Kaliganj Travels',
};

/** Fixed locale and zone: the server and the client must render the same string. */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * A customer's application to become a B2B partner, reached from the yellow
 * button at the foot of the sidebar.
 *
 * Customers only — the same check the sidebar makes, repeated here so a direct
 * URL 404s for everyone else. This is a real route, so it is not covered by the
 * `findNavItem()` gate that protects the unbuilt sections; `canRequestUpgrade()`
 * is what closes it, exactly as `canManageSubUsers()` closes `agency-users`.
 */
export default async function UpgradePage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (!canRequestUpgrade(session.role)) notFound();

  const read = await getUpgradeRequest(session.clerkId);

  const heading = (
    <div>
      <h1 className="flex items-center gap-2 text-xl font-semibold text-navy-950">
        <Rocket className="h-5 w-5 text-navy-700" />
        Upgrade to Business
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-navy-700/70">
        Trading as an agency gets you partner pricing, an agency code, staff
        logins and an account ledger. Tell us about the business and our team
        will review it.
      </p>
    </div>
  );

  // A failed read withholds the form rather than showing it blank. The same
  // rule as the profile page, and for the same reason: a blank form submitted
  // over an application that was there all along would replace it.
  if (!read.ok) {
    return (
      <div className="space-y-6">
        {heading}
        <div className="flex items-start gap-3 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Your application could not be loaded just now, so the form is
            hidden — filling in a blank one could overwrite answers you have
            already sent. Refresh in a moment, and contact support if it keeps
            happening.
          </span>
        </div>
      </div>
    );
  }

  const request = read.request;

  if (request?.status === 'pending') {
    return (
      <div className="space-y-6">
        {heading}
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-5 py-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-navy-950">
            <Clock className="h-4 w-4" />
            With our team for review
          </p>
          <p className="mt-2 max-w-2xl text-sm text-navy-700">
            You applied on {dateFormat.format(new Date(request.createdAt))} as{' '}
            <span className="font-semibold text-navy-950">
              {request.values.agencyName}
            </span>
            . The outcome will appear here, and your dashboard changes on its own
            once the upgrade is approved — there is nothing else to do.
          </p>
        </div>
      </div>
    );
  }

  if (request?.status === 'accepted') {
    return (
      <div className="space-y-6">
        {heading}
        <div className="rounded-lg border border-navy-100 bg-white px-5 py-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-navy-950">
            <CheckCircle2 className="h-4 w-4 text-navy-700" />
            Already approved
          </p>
          <p className="mt-2 max-w-2xl text-sm text-navy-700">
            This application was approved. If your dashboard still shows a
            customer account, sign out and back in — and contact support if it
            has not changed after that.
          </p>
        </div>
      </div>
    );
  }

  // Nothing applied for yet, or a rejected application being corrected. Seed
  // what we already know so the form is not asking twice; a rejected
  // application's own answers win over the account's, since those are the ones
  // being corrected.
  const defaults: Partial<UpgradeValues> = {
    fullName: session.name,
    businessEmail: session.email,
    ...(request?.status === 'rejected' ? request.values : {}),
  };

  return (
    <div className="space-y-6">
      {heading}

      {request?.status === 'rejected' && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-700">
            <AlertTriangle className="h-4 w-4" />
            Your last application was not approved
          </p>
          <p className="mt-2 max-w-2xl text-sm text-red-700/90">
            {request.reviewNote?.trim() ||
              'Our team did not approve the application. Check the details below and send it again.'}
          </p>
          <p className="mt-2 text-xs text-red-700/70">
            Reviewed{' '}
            {request.reviewedAt
              ? dateFormat.format(new Date(request.reviewedAt))
              : 'recently'}
            . Your answers are below — correct them and submit again.
          </p>
        </div>
      )}

      <UpgradeRequestForm defaults={defaults} />
    </div>
  );
}
