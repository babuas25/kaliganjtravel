import PromotionalPopupManager from '@/components/dashboard/PromotionalPopupManager';
import { getPromotionalPopup } from '@/lib/db/promotional-popup';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import AnnouncementManager from '@/components/dashboard/AnnouncementManager';
import FlightSearchBackgroundManager from '@/components/dashboard/FlightSearchBackgroundManager';
import HomepageOffersManager from '@/components/dashboard/HomepageOffersManager';
import { isCloudinaryConfigured } from '@/lib/cloudinary';
import { getAnnouncementSlider } from '@/lib/db/announcements';
import { getHomepageOffers } from '@/lib/db/homepage-offers';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getFlightSearchBackground } from '@/lib/flight-search-background';
import { canManageMedia } from '@/lib/roles';

export const metadata: Metadata = {
  title: 'Media & Banners — Kaliganj Travels',
};

export default async function MediaPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (!canManageMedia(session.role)) notFound();

  const [slider, offers, background, promotion] = await Promise.all([
    getAnnouncementSlider(),
    getHomepageOffers(),
    getFlightSearchBackground(),
    getPromotionalPopup(),
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PromotionalPopupManager initialState={promotion} configured={isCloudinaryConfigured()} />
      <AnnouncementManager initialState={slider} />
      <HomepageOffersManager
        initialState={offers}
        configured={isCloudinaryConfigured()}
      />
      <FlightSearchBackgroundManager
        background={background}
        configured={isCloudinaryConfigured()}
      />
    </main>
  );
}
