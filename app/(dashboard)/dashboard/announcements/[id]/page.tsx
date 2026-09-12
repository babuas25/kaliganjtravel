import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, FileText, Tag } from 'lucide-react';
import { getPromotionalPopup } from '@/lib/db/promotional-popup';

type Props = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';

async function findOffer(id: string) {
  const state = await getPromotionalPopup();
  return state.slides.find((slide) => slide.id === id && slide.active);
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const offer = await findOffer((await params).id);
  return { title: `${offer?.title ?? 'Announcement'} — Kaliganj Travels` };
}

export default async function AnnouncementDetailPage({ params }: Props) {
  const offer = await findOffer((await params).id);
  if (!offer) notFound();
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    <Link href="/dashboard/announcements" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-neutral-600 hover:text-brand-orange"><ArrowLeft className="h-4 w-4" aria-hidden />All announcements</Link>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <article className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <header className="p-6 sm:p-8">
          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-brand-orange-light px-3 py-1 text-xs font-semibold text-brand-orange-dark"><Tag className="h-3.5 w-3.5" aria-hidden />Promotional offer</span>
          <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-navy-950 sm:text-3xl">{offer.title}</h1>
        </header>
        <div className="border-y border-neutral-100 bg-navy-50 p-4 sm:p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={offer.imageUrl} alt={offer.title} className="mx-auto max-h-[600px] w-full object-contain" />
        </div>
        <div className="space-y-8 p-6 sm:p-8">
          <section><h2 className="mb-4 text-lg font-bold text-navy-950">About this offer</h2><p className="whitespace-pre-wrap break-words text-sm leading-7 text-neutral-600">{offer.details || 'Please refer to the promotional artwork for the offer details. Contact our team for booking information.'}</p></section>
          {offer.terms && <section className="border-t border-neutral-200 pt-6"><h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-navy-950"><FileText className="h-5 w-5" aria-hidden />Terms & conditions</h2><p className="whitespace-pre-wrap break-words text-sm leading-7 text-neutral-600">{offer.terms}</p></section>}
        </div>
      </article>
      <aside className="space-y-4 lg:sticky lg:top-24">
        <div className="rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-navy-950">Plan your next trip</h2><p className="mt-2 text-sm leading-6 text-neutral-500">Explore flight options or follow the offer’s booking link.</p>
          <Link href={offer.link || '/dashboard/flight-search'} className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-3 text-sm font-bold text-navy-950 hover:bg-brand-orange-dark hover:text-white">{offer.link ? 'Continue to offer' : 'Search flights'}<ArrowRight className="h-4 w-4" aria-hidden /></Link>
        </div>
        <div className="rounded-2xl border border-navy-100 bg-navy-50 p-6"><h2 className="text-sm font-bold text-navy-950">Need help with this offer?</h2><p className="mt-2 text-sm leading-6 text-neutral-600">Our team can help with availability and booking details.</p><a href="tel:+8801795271171" className="mt-4 block text-sm font-bold text-navy-950 hover:underline">+880 1795-271171</a><a href="mailto:support@kaliganjtravel.com" className="mt-2 block break-all text-xs text-neutral-600 hover:underline">support@kaliganjtravel.com</a></div>
      </aside>
    </div>
  </main>;
}
