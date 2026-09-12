import PromotionalPopup from '@/components/dashboard/PromotionalPopup';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import InactiveAccountSignOut from '@/components/auth/InactiveAccountSignOut';
import StatusFeedbackProvider from '@/components/feedback/StatusFeedback';
import DashboardShell from '@/components/dashboard/DashboardShell';
import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import { getSiteLogo } from '@/lib/appearance';
import { getAnnouncementSlider } from '@/lib/db/announcements';
import {
  getDashboardSession,
  isCurrentAccountInactive,
  IS_DEV,
} from '@/lib/dashboard/session';

export const metadata: Metadata = {
  title: 'Dashboard — Kaliganj Travels',
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getDashboardSession();

  // Middleware already gates these routes. For a disabled account, clear any
  // freshly-created Clerk session instead of sending it straight back to the
  // sign-in page, which would otherwise redirect here again.
  if (!session) {
    if (await isCurrentAccountInactive()) return <InactiveAccountSignOut />;
    redirect('/sign-in');
  }

  const [logo, announcementSlider] = await Promise.all([
    getSiteLogo(),
    getAnnouncementSlider(),
  ]);

  return (
    <StatusFeedbackProvider>
      <DashboardShell
        hiddenNavSegments={hiddenDashboardSegments()}
        role={session.role}
        name={session.name}
        agencyCode={session.agencyCode}
        logo={logo}
        announcementMessages={announcementSlider.messages
          .filter((message) => message.active)
          .map((message) => message.text)}
        announcementDurationSeconds={announcementSlider.scrollDurationSeconds}
        showDevRoleSwitcher={IS_DEV}
      >
        {children}
        <PromotionalPopup userId={session.clerkId} signedInAt={session.signedInAt} />
      </DashboardShell>
    </StatusFeedbackProvider>
  );
}
