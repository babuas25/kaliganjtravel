import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import BookingResume from '@/components/flights/BookingResume';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import { getSiteLogo } from '@/lib/appearance';
import { getAnnouncementSlider } from '@/lib/db/announcements';

export const dynamic = 'force-dynamic';

function valueOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default async function ResumeBookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [logo, announcementSlider, params] = await Promise.all([
    getSiteLogo(),
    getAnnouncementSlider(),
    searchParams,
  ]);

  return (
    <div className="min-h-screen bg-navy-50 text-navy-950">
      <AnnouncementBar
        messages={announcementSlider.messages
          .filter((message) => message.active)
          .map((message) => message.text)}
        durationSeconds={announcementSlider.scrollDurationSeconds}
      />
      <Header logo={logo} hiddenNavSegments={hiddenDashboardSegments()} />
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="sr-only">Preparing your booking</h1>
        <BookingResume
          searchId={valueOf(params.searchId)}
          itineraryId={valueOf(params.itineraryId)}
          returnTo={valueOf(params.returnTo)}
        />
      </main>
      <Footer />
    </div>
  );
}
