import { redirect } from 'next/navigation';

import FlightSearchSuggestions from '@/components/dashboard/FlightSearchSuggestions';
import FlightSearchTrustStrip from '@/components/dashboard/FlightSearchTrustStrip';
import FlightSearchPanel from '@/components/layout/FlightSearchPanel';
import type { AirportOption } from '@/lib/airports/types';
import { searchAirports } from '@/lib/airports/search';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getFlightSearchSuggestions } from '@/lib/db/flight-search-history';
import { getFlightSearchBackground } from '@/lib/flight-search-background';
import {
  decodeSearchParams,
  encodeSearchParams,
} from '@/lib/flights/search-params';
import type { FlightSearchInput } from '@/lib/flights/types';
import { cn } from '@/lib/utils';

function initialAirports(input: FlightSearchInput): Record<string, AirportOption> {
  const options: Record<string, AirportOption> = {};
  for (const route of input.routes) {
    for (const code of [route.origin, route.destination]) {
      if (options[code]) continue;
      options[code] =
        searchAirports(code, 20).find((airport) => airport.iata === code) ??
        ({
          id: `history-${code}`,
          iata: code,
          city: code,
          name: 'Airport',
          country: '',
        } satisfies AirportOption);
    }
  }
  return options;
}

/**
 * The booking engine inside the account area, so a signed-in user never has to
 * leave the dashboard to start a search. Same panel as the public home page,
 * and deliberately unheaded — the panel is the whole page.
 */
export default async function DashboardFlightSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, background, params] = await Promise.all([
    getDashboardSession(),
    getFlightSearchBackground(),
    searchParams,
  ]);
  if (!session) redirect('/sign-in');

  const prefillInput = decodeSearchParams(params);
  const suggestions = await getFlightSearchSuggestions(session.clerkId);
  const prefillAirports = prefillInput ? initialAirports(prefillInput) : {};
  const panelKey = prefillInput ? encodeSearchParams(prefillInput) : 'default';

  // The panel floats across a fixed-height full-width band. The band is an
  // absolute background layer while the panel remains in normal document
  // flow, so content below always clears the panel even when a narrower
  // expanded-sidebar layout makes it taller.
  //
  // No `overflow-hidden` on the band, deliberately: the panel's airport, date
  // and traveller menus open downwards out of it, and clipping them to the
  // boundary would cut every one of them off.
  //
  // The tab strip is `absolute -top-7`, so the larger top padding creates a
  // deliberate gap below the announcement slider without moving the fixed
  // background-image layer.
  return (
    <div className="w-full">
      <section
        className="relative w-full px-4 pb-10 pt-16 sm:px-6 sm:pt-20 lg:px-8"
      >
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-x-0 top-0 h-[255px] bg-cover bg-center',
            !background && 'bg-search-gradient'
          )}
          style={
            background
              ? { backgroundImage: `url("${background.url}")` }
              : undefined
          }
        />
        <div className="relative mx-auto max-w-7xl">
          <FlightSearchPanel
            key={panelKey}
            initialInput={prefillInput ?? undefined}
            initialAirports={prefillAirports}
          />
        </div>
      </section>
      <div className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
        <FlightSearchTrustStrip />
        <div className="mt-8">
          <FlightSearchSuggestions suggestions={suggestions} />
        </div>
      </div>
    </div>
  );
}
