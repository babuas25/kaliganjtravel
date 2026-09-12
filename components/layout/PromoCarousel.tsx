'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import type { MarketingKey, MarketingUrls } from '@/lib/marketing';

/**
 * Copy lives here; the artwork does not. Each slide names a marketing image and
 * the rendering page resolves it — building a Cloudinary URL needs the account
 * name, which stays on the server.
 */
const slides: {
  key: MarketingKey;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
}[] = [
  {
    key: 'promoMaldives',
    eyebrow: 'Beach Escapes',
    title: 'Maldives from $699',
    subtitle: 'Overwater villas, crystal lagoons and all-inclusive packages.',
    cta: 'Book Maldives',
  },
  {
    key: 'promoTokyo',
    eyebrow: 'City Breaks',
    title: 'Tokyo under $899',
    subtitle: 'Neon nights, ancient temples and world-class cuisine.',
    cta: 'Explore Tokyo',
  },
  {
    key: 'promoPatagonia',
    eyebrow: 'Adventure',
    title: 'Patagonia treks',
    subtitle: 'Glaciers, granite spires and the end of the world.',
    cta: 'Start adventure',
  },
];

/**
 * Not currently rendered anywhere — kept, like `layout/Sidebar.tsx`, for when
 * the marketing pages want it. It takes its images as a prop so that whenever
 * that happens it is already wired the way the hero is.
 */
export default function PromoCarousel({
  images = {},
}: {
  images?: MarketingUrls;
}) {
  const [i, setI] = useState(0);
  const next = () => setI((p) => (p + 1) % slides.length);
  const prev = () => setI((p) => (p - 1 + slides.length) % slides.length);

  useEffect(() => {
    const t = setInterval(next, 6000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative overflow-hidden rounded-2xl shadow-lg">
      {/* Slides */}
      <div className="relative h-72 sm:h-80 md:h-96">
        {slides.map((s, idx) => (
          <div
            key={idx}
            className={`absolute inset-0 transition-opacity duration-700 ${
              idx === i ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {/* The gradient below covers the whole slide, so a missing image
                degrades to navy rather than to a broken frame. */}
            {images[s.key] && (
              <Image
                src={images[s.key] as string}
                alt=""
                fill
                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 70vw, 50vw"
                className="object-cover"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-navy-950/90 via-navy-900/60 to-transparent" />
            <div className="absolute inset-0 flex flex-col justify-center px-8 text-white md:px-12">
              <p className="mb-2 inline-block w-fit rounded-full bg-brand-orange px-3 py-1 text-xs font-bold uppercase tracking-wide">
                {s.eyebrow}
              </p>
              <h3 className="max-w-md text-2xl font-bold leading-tight md:text-4xl">
                {s.title}
              </h3>
              <p className="mt-2 max-w-md text-sm text-navy-100 md:text-base">
                {s.subtitle}
              </p>
              <button className="mt-5 w-fit rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-navy-900 transition-colors hover:bg-navy-50">
                {s.cta}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Arrows */}
      <button
        onClick={prev}
        aria-label="Previous"
        className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/20 p-2 text-white backdrop-blur transition-colors hover:bg-white/40"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <button
        onClick={next}
        aria-label="Next"
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/20 p-2 text-white backdrop-blur transition-colors hover:bg-white/40"
      >
        <ChevronRight className="h-5 w-5" />
      </button>

      {/* Dots */}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
        {slides.map((_, idx) => (
          <button
            key={idx}
            onClick={() => setI(idx)}
            aria-label={`Go to slide ${idx + 1}`}
            className={`h-2 rounded-full transition-all ${
              idx === i ? 'w-6 bg-white' : 'w-2 bg-white/50'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
