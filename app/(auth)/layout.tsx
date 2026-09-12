import Link from 'next/link';
import { ArrowLeft, Mail } from 'lucide-react';
import { getSiteLogo } from '@/lib/appearance';
import { SITE_EMAIL, SITE_NAME, SITE_PHONE, SITE_PHONE_HREF } from '@/lib/site';
import AuthPanelHeading from '@/components/auth/AuthPanelHeading';
import AuthPromoPanel from '@/components/auth/AuthPromoPanel';
import SiteLogoMark from '@/components/layout/SiteLogoMark';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const logo = await getSiteLogo();
  return (
    <div className="min-h-screen bg-[#faf9f6] text-navy-950">
      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Link href="/" aria-label="Kaliganj Travels home" className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">
          <SiteLogoMark logo={logo} className="h-10 w-20 rounded-lg">KT</SiteLogoMark>
          <span className="hidden text-sm font-bold sm:block">{SITE_NAME}</span>
        </Link>
        <Link href="/" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition hover:bg-white hover:text-navy-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to home
        </Link>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-3 pt-1 sm:px-8">
        <div className="grid overflow-hidden rounded-3xl border border-neutral-200/80 bg-white shadow-[0_20px_70px_-35px_rgba(23,23,23,0.2)] lg:grid-cols-[0.95fr_1.05fr]">
          <AuthPromoPanel />
          <section aria-label="Your account" className="flex flex-col justify-center px-6 py-5 sm:px-10 sm:py-6 lg:px-12">
            <AuthPanelHeading />
            <div className="mt-5 flex w-full justify-center">{children}</div>
          </section>
        </div>
        <footer className="mt-3 flex flex-col items-center justify-between gap-3 px-1 text-xs text-neutral-500 sm:flex-row">
          <p>Need a hand signing in? <a href={SITE_PHONE_HREF} className="whitespace-nowrap font-medium text-neutral-700 hover:underline">{SITE_PHONE}</a></p>
          <a href={`mailto:${SITE_EMAIL}`} className="inline-flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange hover:text-brand-orange-dark"><Mail className="h-3.5 w-3.5" aria-hidden />{SITE_EMAIL}</a>
        </footer>
      </main>
    </div>
  );
}
