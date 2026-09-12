import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import FlightResults from '@/components/flights/FlightResults';
import FlightSearchModifier from '@/components/flights/FlightSearchModifier';
import DashboardShell from '@/components/dashboard/DashboardShell';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import { getSiteLogo } from '@/lib/appearance';
import { searchAirports } from '@/lib/airports/search';
import { getAnnouncementSlider } from '@/lib/db/announcements';
import { getDashboardSession, IS_DEV } from '@/lib/dashboard/session';
import type { AirportOption } from '@/lib/airports/types';
import { decodeSearchParams } from '@/lib/flights/search-params';
import type { FlightSearchInput } from '@/lib/flights/types';

/**
 * Search results.
 *
 * A server component for the shell only — the search itself runs from the
 * browser (`FlightResults`), because the supplier takes close to a minute to
 * answer and a server-rendered wait would leave the visitor on the previous
 * page with nothing happening.
 */

export const dynamic = 'force-dynamic';

function initialAirports(input: FlightSearchInput): Record<string, AirportOption> {
  const options: Record<string, AirportOption> = {};
  for (const route of input.routes) {
    for (const code of [route.origin, route.destination]) {
      if (options[code]) continue;
      const match = searchAirports(code, 20).find((airport) => airport.iata === code);
      options[code] =
        match ??
        ({
          id: `search-${code}`,
          iata: code,
          city: code,
          name: 'Airport',
          country: '',
        } satisfies AirportOption);
    }
  }
  return options;
}

export default async function FlightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [logo, announcementSlider, params, session] = await Promise.all([
    getSiteLogo(),
    getAnnouncementSlider(),
    searchParams,
    getDashboardSession(),
  ]);
  const input = decodeSearchParams(params);
  const airportOptions = input ? initialAirports(input) : {};
  const airportCities = Object.fromEntries(
    Object.entries(airportOptions).map(([code, airport]) => [
      code,
      airport.city,
    ])
  );

  const results = input ? (
    <>
      <FlightSearchModifier
        key={JSON.stringify(input)}
        input={input}
        initialAirports={airportOptions}
      />

      <div className="mt-3 sm:mt-5">
        <FlightResults input={input} airportCities={airportCities} />
      </div>
    </>
  ) : (
    <div className="mt-6 rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-neutral-200">
      <p className="text-base font-semibold">No search to show</p>
      <p className="mt-1 text-sm text-neutral-500">
        Start from the search panel on the home page.
      </p>
    </div>
  );

  if (session) {
    return (
      <DashboardShell
        hiddenNavSegments={hiddenDashboardSegments()}
        role={session.role}
        name={session.name}
        agencyCode={session.agencyCode}
        logo={logo}
        showDevRoleSwitcher={IS_DEV}
      >
        <div className="mx-auto w-full max-w-[1180px]">{results}</div>
      </DashboardShell>
    );
  }

  return (
    <div className="min-h-screen bg-navy-50 text-navy-950">
      <AnnouncementBar
        messages={announcementSlider.messages
          .filter((message) => message.active)
          .map((message) => message.text)}
        durationSeconds={announcementSlider.scrollDurationSeconds}
      />
      <Header logo={logo} hiddenNavSegments={hiddenDashboardSegments()} />
      <main className="mx-auto max-w-[1180px] px-4 py-4 sm:px-6 sm:py-8 lg:px-8">
        {results}
      </main>
      <Footer />
    </div>
  );
}
