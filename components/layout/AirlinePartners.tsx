import AirlineLogo from '@/components/flights/AirlineLogo';

/** The carriers the site sells, by IATA code — the same set the search filter offers. */
const partners = [
  { code: 'BS', name: 'US-Bangla Airlines' },
  { code: 'BG', name: 'Biman Bangladesh' },
  { code: '2A', name: 'Air Astra' },
  { code: 'VQ', name: 'Novoair' },
  { code: 'EK', name: 'Emirates' },
  { code: 'QR', name: 'Qatar Airways' },
];

/**
 * The logo strip under the sign-in card.
 *
 * Each tile carries the airline's name as well as its mark: the logos come from
 * a third-party CDN and fall back to a generic plane, which on its own would
 * leave a row of six identical tiles.
 */
export default function AirlinePartners() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <h2 className="text-center text-xl font-bold text-navy-950">
        Top Airlines Are With Us
      </h2>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {partners.map(({ code, name }) => (
          <div
            key={code}
            className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-center shadow-sm"
          >
            <AirlineLogo airlineCode={code} size={36} />
            <span className="text-xs font-medium text-neutral-600">{name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
