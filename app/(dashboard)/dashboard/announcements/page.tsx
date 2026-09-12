import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Megaphone, Tag } from 'lucide-react';
import { getPromotionalPopup } from '@/lib/db/promotional-popup';

export const metadata: Metadata = { title: 'Announcements & Offers — Kaliganj Travels' };
export const dynamic = 'force-dynamic';

export default async function AnnouncementsPage() {
  const state = await getPromotionalPopup();
  const offers = state.slides.filter((slide) => slide.active);
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    <header className="mb-8 rounded-2xl border border-navy-100 bg-white px-6 py-7 sm:px-8">
      <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-brand-orange"><Megaphone className="h-4 w-4" aria-hidden />Stay up to date</div>
      <h1 className="text-2xl font-bold tracking-tight text-navy-950 sm:text-3xl">Announcements & offers</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">Explore our latest promotions, flight offers and travel updates. Open an announcement for the full details and booking information.</p>
    </header>
    {!state.available ? <div role="status" className="rounded-2xl border border-neutral-200 bg-white p-8 text-center text-neutral-600">Announcements are temporarily unavailable. Please try again later.</div> : offers.length === 0 ? <div className="rounded-2xl border border-dashed border-navy-200 bg-white px-6 py-16 text-center">
      <Megaphone className="mx-auto mb-4 h-9 w-9 text-navy-300" aria-hidden />
      <h2 className="text-lg font-bold text-navy-950">No announcements yet</h2><p className="mt-2 text-sm text-neutral-500">New promotions will appear here when they’re published.</p>
      <Link href="/dashboard/flight-search" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-brand-orange">Search flights <ArrowRight className="h-4 w-4" aria-hidden /></Link>
    </div> : <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {offers.map((offer) => <Link key={offer.id} href={`/dashboard/announcements/${offer.id}`} className="group flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">
        <div className="flex aspect-[16/10] items-center justify-center border-b border-neutral-100 bg-navy-50 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={offer.imageUrl} alt={offer.title} className="h-full w-full object-contain" />
        </div>
        <div className="flex flex-1 flex-col p-5">
          <span className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-brand-orange"><Tag className="h-3.5 w-3.5" aria-hidden />Promotional offer</span>
          <h2 className="break-words text-lg font-bold leading-snug text-navy-950 group-hover:text-brand-orange-dark">{offer.title}</h2>
          <p className="mt-3 line-clamp-3 text-sm leading-6 text-neutral-500">{offer.details || 'View this promotional offer and its booking information.'}</p>
          <span className="mt-auto flex items-center gap-2 pt-5 text-sm font-semibold text-brand-orange">Read announcement <ArrowRight className="h-4 w-4" aria-hidden /></span>
        </div>
      </Link>)}
    </div>}
  </main>;
}
