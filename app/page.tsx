import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import Image from 'next/image';
import { ArrowRight, Globe2, Headphones, MapPin, Plane, RefreshCw } from 'lucide-react';
import Header from '@/components/layout/Header';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import FlightSearchPanel from '@/components/layout/FlightSearchPanel';
import Footer from '@/components/layout/Footer';
import { getSiteLogo } from '@/lib/appearance';
import { getAnnouncementSlider } from '@/lib/db/announcements';
import { getHomepageOffers } from '@/lib/db/homepage-offers';
import { marketingUrls } from '@/lib/marketing';

type Route = {
  destination: string;
  code: string;
  destinationAirport: string;
};

const airlinePartners = [
  { code: 'BS', name: 'US-Bangla Airlines', logo: 'BS.svg' },
  { code: 'BG', name: 'Biman Bangladesh Airlines', logo: 'BG.svg' },
  { code: 'SQ', name: 'Singapore Airlines', logo: 'SQ.svg' },
  { code: '2A', name: 'Air Astra', logo: '2A.svg' },
  { code: 'VQ', name: 'NOVOAIR', logo: 'VQ.svg' },
  { code: '6E', name: 'IndiGo', logo: '6E.svg' },
  { code: 'QR', name: 'Qatar Airways', logo: 'QR.svg' },
  { code: 'MH', name: 'Malaysia Airlines', logo: 'MH.svg' },
  { code: 'EK', name: 'Emirates', logo: 'EK.svg' },
  { code: 'TK', name: 'Turkish Airlines', logo: 'TK.svg' },
  { code: 'AI', name: 'Air India', logo: 'AI.svg' },
  { code: 'OD', name: 'Batik Air', logo: 'OD.png' },
] as const;

const domesticRoutes: Route[] = [
  { destination: "Cox's Bazar", code: 'CXB', destinationAirport: "Cox's Bazar Airport" },
  { destination: 'Jashore', code: 'JSR', destinationAirport: 'Jashore Airport' },
  { destination: 'Chattogram', code: 'CGP', destinationAirport: 'Shah Amanat International Airport' },
  { destination: 'Sylhet', code: 'ZYL', destinationAirport: 'Osmani International Airport' },
  { destination: 'Barishal', code: 'BZL', destinationAirport: 'Barishal Airport' },
  { destination: 'Saidpur', code: 'SPD', destinationAirport: 'Saidpur Airport' },
];

const internationalRoutes: Route[] = [
  { destination: 'Singapore', code: 'SIN', destinationAirport: 'Singapore Changi Airport' },
  { destination: 'Kuala Lumpur', code: 'KUL', destinationAirport: 'Kuala Lumpur International Airport' },
  { destination: 'Doha', code: 'DOH', destinationAirport: 'Hamad International Airport' },
  { destination: 'Dubai', code: 'DXB', destinationAirport: 'Dubai International Airport' },
  { destination: 'Bangkok', code: 'BKK', destinationAirport: 'Suvarnabhumi Airport' },
  { destination: 'Delhi', code: 'DEL', destinationAirport: 'Indira Gandhi International Airport' },
];

// A server component so the uploaded logo can be read before the first paint.
// The interactive pieces below (header, search panel) carry their own
// 'use client'.
export default async function Home() {
  const [logo, announcementSlider, homepageOffers] = await Promise.all([
    getSiteLogo(),
    getAnnouncementSlider(),
    getHomepageOffers(),
  ]);
  // Resolved here rather than in the carousel: building a Cloudinary URL needs
  // the account name, and keeping that on the server is what avoids a
  // NEXT_PUBLIC_ copy of it.
  const images = marketingUrls();
  const activeOffers = homepageOffers.offers.filter((offer) => offer.active);
  const fallbackOfferImages = [
    images.promoMaldives,
    images.promoTokyo,
    images.promoPatagonia,
  ];

  return (
    <div className="min-h-screen bg-navy-50 text-navy-950">
      <AnnouncementBar
        messages={announcementSlider.messages
          .filter((message) => message.active)
          .map((message) => message.text)}
        durationSeconds={announcementSlider.scrollDurationSeconds}
      />
      <Header logo={logo} hiddenNavSegments={hiddenDashboardSegments()} showContactBar />

      <main>
        <section id="flight-search" className="relative scroll-mt-28 overflow-hidden bg-hero-gradient text-white">
          {/* Absent until the image is seeded into Cloudinary. The section is
              already `bg-navy-950` under an 80% overlay, so its absence reads
              as a plain navy band rather than a hole. */}
          {images.hero && (
            <Image
              src={images.hero}
              alt=""
              fill
              className="-z-10 object-cover"
            />
          )}
          <div className="absolute inset-0 bg-navy-950/80" />
          {/* pt-8 on phones, not the pt-10 used from `sm` up: with the heading
              hidden there, the panel should sit just under the header. It
              cannot go lower than 28px, though — the panel's tab strip is
              `absolute -top-7`, so it overhangs the panel by that much and
              anything less tucks it behind the sticky header. 32px clears the
              overhang and leaves a few pixels of navy. */}
          <div className="relative mx-auto max-w-7xl px-4 pb-10 pt-8 sm:px-6 sm:pt-10 lg:px-8 lg:py-14">
            {/* Hidden on phones: the search panel is the only thing that
                should be above the fold there. */}
            <div className="hidden max-w-2xl space-y-4 sm:block">
              <p className="inline-flex items-center gap-2 rounded-full bg-brand-orange/20 px-4 py-2 text-sm font-semibold uppercase tracking-[0.3em] text-white">
                Kaliganj Travels · Kaligonj, Jhenaidah
              </p>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
                Your journey starts with Kaliganj
              </h1>
            </div>

            {/* mt-8 separates the panel from the heading above it, which only
                exists from `sm` up — on phones it would be a gap under the
                header with nothing above it. */}
            <div className="mt-0 sm:mt-8">
              <FlightSearchPanel />
            </div>

            <ul aria-label="Travel services" className="mt-6 grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-3 sm:gap-6">
              {[
                { icon: Plane, title: 'Air tickets', description: 'Domestic & international flights' },
                { icon: RefreshCw, title: 'Reissue & refund', description: 'Help with changes to your trip' },
                { icon: Headphones, title: 'Travel support', description: 'A helping hand for your journey' },
              ].map(({ icon: Icon, title, description }) => (
                <li key={title} className="flex items-center gap-3 sm:justify-center">
                  <Icon className="h-5 w-5 shrink-0 text-orange-300" strokeWidth={1.5} aria-hidden />
                  <div>
                    <p className="text-sm font-semibold text-white">{title}</p>
                    <p className="mt-0.5 text-xs leading-5 text-neutral-300">{description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {activeOffers.length > 0 ? (
          <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-bold text-navy-950">
                  {homepageOffers.heading}
                </h2>
                <p className="mt-2 text-sm text-neutral-600">
                  {homepageOffers.subheading}
                </p>
              </div>
              <button className="inline-flex items-center gap-2 rounded-full bg-brand-orange px-5 py-3 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white hover:text-navy-950">
                View all <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              {activeOffers.map((offer, index) => {
                const imageUrl = offer.image?.url ?? fallbackOfferImages[index];
                return (
                  <article
                    key={offer.id}
                    className="relative min-h-56 overflow-hidden rounded-2xl bg-gradient-to-br from-navy-950 via-navy-900 to-brand-orange p-6 text-white shadow-xl"
                  >
                    {imageUrl ? (
                      <>
                        <Image
                          src={imageUrl}
                          alt=""
                          fill
                          sizes="(min-width: 768px) 33vw, 100vw"
                          className="object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-br from-navy-950/40 via-navy-900/20 to-brand-orange/25" />
                      </>
                    ) : null}
                    <div className="relative flex h-full min-h-44 flex-col justify-end">
                      <p className="text-sm uppercase tracking-[0.3em] text-white/80">
                        {offer.eyebrow}
                      </p>
                      <h3 className="mt-5 text-2xl font-semibold">{offer.title}</h3>
                      <p className="mt-4 text-sm leading-6 text-white/80">
                        {offer.description}
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        <section id="airlines" aria-labelledby="airlines-heading" className="scroll-mt-20 bg-white py-10 sm:py-12">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="overflow-hidden rounded-3xl border border-navy-100 bg-navy-50/60 lg:grid lg:grid-cols-[280px_1fr]">
              <div className="relative overflow-hidden bg-brand-orange p-6 text-black sm:p-8 lg:flex lg:flex-col lg:justify-between">
                <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full border border-white/10" />
                <div aria-hidden className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full border border-white/10" />
                <div className="relative">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-black">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-orange" aria-hidden /> Our airlines
                  </p>
                  <h2 id="airlines-heading" className="mt-4 max-w-sm text-3xl font-bold leading-tight tracking-tight">
                    More airlines.<br /><span className="text-black">More possibilities.</span>
                  </h2>
                  <p className="mt-4 max-w-sm text-sm leading-6 text-black/75">
                    From a quick trip home to your next adventure abroad, find your flight with airlines you know.
                  </p>
                </div>
                <div className="relative mt-7 flex items-center gap-3 border-t border-white/15 pt-5">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10"><Globe2 className="h-5 w-5 text-black" aria-hidden /></span>
                  <div>
                    <p className="text-sm font-semibold">Domestic & international</p>
                    <p className="mt-1 text-xs text-navy-200">Your journey, your choice</p>
                  </div>
                </div>
              </div>

              <div className="p-4 sm:p-6">
                <div className="mb-4 flex items-center gap-2 text-xs font-medium text-navy-600">
                  <Plane className="h-4 w-4 text-brand-orange-dark" aria-hidden /> Explore our airline selection
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                  {airlinePartners.map((airline) => (
                    <article key={airline.code} aria-label={airline.name}
                      className="flex min-w-0 flex-col items-center justify-center gap-3 rounded-2xl border border-navy-100 bg-white px-3 py-4 transition-colors hover:border-brand-orange/50">
                      <div className="relative h-10 w-full max-w-[160px]">
                        <Image src={`/airlines/${airline.logo}`} alt={`${airline.name} logo`} fill
                          sizes="(min-width: 640px) 160px, 40vw" className="object-contain" />
                      </div>
                      <p className="text-center text-[11px] font-medium leading-4 text-navy-600">{airline.name}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl space-y-12 px-4 py-12 sm:px-6 lg:px-8">
          <RouteCollection
            title="Top Domestic Routes from Bangladesh"
            kind="domestic"
            routes={domesticRoutes}
          />
          <RouteCollection
            title="Top International Routes from Bangladesh"
            kind="international"
            routes={internationalRoutes}
          />
        </section>
      </main>

      <Footer />
    </div>
  );
}

function RouteCollection({ title, routes, kind }: { title: string; routes: Route[]; kind: 'domestic' | 'international' }) {
  const domestic = kind === 'domestic';
  const Icon = domestic ? MapPin : Globe2;
  return (
    <section aria-labelledby={`${kind}-routes-heading`} id={`${kind}-routes`} className="scroll-mt-28">
      <div className="flex items-start gap-4 sm:items-center">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${domestic ? 'bg-brand-orange/15 text-brand-orange-dark' : 'bg-brand-orange text-black'}`}>
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-orange-dark">{domestic ? 'Closer to home' : 'Beyond borders'}</p>
          <h2 id={`${kind}-routes-heading`} className="text-xl font-bold tracking-tight text-navy-950 sm:text-2xl">{title}</h2>
          <p className="mt-1.5 text-sm text-navy-600">{domestic ? 'Discover Bangladesh, one destination at a time.' : 'Start your next chapter somewhere new.'}</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {routes.map((route) => <RouteCard key={route.destination} route={route} domestic={domestic} />)}
      </div>
    </section>
  );
}

function RouteCard({ route, domestic }: { route: Route; domestic: boolean }) {
  return (
    <article aria-label={`Dhaka to ${route.destination}`} className="overflow-hidden rounded-2xl border border-navy-100 bg-white transition-colors hover:border-navy-300">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-xl text-lg font-bold tracking-wide ${domestic ? 'bg-orange-50 text-brand-orange-dark' : 'bg-navy-50 text-navy-800'}`} aria-hidden>
          {route.code}
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium text-navy-500">From Dhaka <ArrowRight className="h-3.5 w-3.5" aria-hidden /></p>
          <h3 className="mt-1 text-xl font-bold leading-tight text-navy-950">{route.destination}</h3>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-dashed border-navy-100 bg-navy-50/40 px-5 py-2.5">
        <Plane className={`h-3.5 w-3.5 shrink-0 ${domestic ? 'text-brand-orange-dark' : 'text-navy-500'}`} aria-hidden />
        <p className="text-xs leading-5 text-navy-600">{route.destinationAirport}</p>
      </div>
    </article>
  );
}
