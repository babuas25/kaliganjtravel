'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, LogIn, Mail, Menu, Phone, Plane, UserPlus } from 'lucide-react';
import { UserButton, useUser } from '@clerk/nextjs';
import { useState } from 'react';

import type { SiteLogo } from '@/lib/appearance';
import SiteLogoMark from '@/components/layout/SiteLogoMark';
import DashboardSidebar from '@/components/dashboard/DashboardSidebar';
import { resolveRole } from '@/lib/roles';
import { SITE_EMAIL, SITE_PHONE, SITE_PHONE_HREF } from '@/lib/site';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const navigation = [
  { label: 'Flights', href: '/#flight-search', path: '/' },
  { label: 'About us', href: '/about-us', path: '/about-us' },
  { label: 'Contact', href: '/contact-us', path: '/contact-us' },
];
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-4';

/** The logo is resolved server-side and handed down; this stays a client tree. */
export default function Header({ logo, hiddenNavSegments, showContactBar = false }: {
  logo: SiteLogo | null;
  hiddenNavSegments: readonly string[];
  showContactBar?: boolean;
}) {
  const { isLoaded, isSignedIn, user } = useUser();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const role = resolveRole(user?.publicMetadata?.role);

  return (
    <>
      {showContactBar && (
        <div className="bg-navy-950 text-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 text-sm sm:px-6 lg:px-8">
            <a href={SITE_PHONE_HREF} className={`inline-flex min-h-8 items-center gap-2.5 rounded-sm hover:text-orange-200 ${focusRing}`}>
              <Phone className="h-3.5 w-3.5 text-brand-orange" aria-hidden />
              {SITE_PHONE}
            </a>
            <a href={`mailto:${SITE_EMAIL}`} className={`inline-flex min-h-8 items-center gap-2.5 rounded-sm hover:text-orange-200 ${focusRing}`}>
              <Mail className="h-3.5 w-3.5 text-brand-orange" aria-hidden />
              <span className="hidden sm:inline">{SITE_EMAIL}</span>
              <span className="sm:hidden">Email us</span>
            </a>
          </div>
        </div>
      )}
      <header className="sticky top-0 z-40 border-b border-navy-200/70 bg-white/95 shadow-[0_4px_24px_-16px_rgba(0,0,0,0.18)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-3 px-4 sm:min-h-24 sm:gap-6 sm:px-6 lg:px-8">
          <Link href="/" aria-label="Kaliganj Travels home" className={`flex shrink-0 items-center gap-3 rounded-lg ${focusRing}`}>
            <SiteLogoMark logo={logo} className="h-14 w-20 rounded-md sm:h-16 sm:w-24">KT</SiteLogoMark>
            <span className="hidden border-l border-navy-200 pl-4 lg:block">
              <span className="block text-xl font-bold leading-tight tracking-tight text-navy-950">Kaliganj</span>
              <span className="mt-1 block text-xs font-semibold uppercase tracking-[0.28em] text-brand-orange-dark">Travels</span>
            </span>
          </Link>

          <nav aria-label="Main navigation" className="hidden self-stretch md:flex md:items-stretch md:gap-6 xl:gap-8">
            {navigation.map((item) => {
              const active = pathname === item.path || (item.path === '/' && pathname.startsWith('/flights'));
              return (
                <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                  className={`relative inline-flex items-center gap-2 border-b-[3px] px-1 pt-[3px] text-sm font-semibold transition-colors ${focusRing} ${active ? 'border-brand-orange text-navy-950' : 'border-transparent text-navy-600 hover:border-brand-orange/40 hover:text-navy-950'}`}>
                  {item.path === '/' && <Plane className="h-4 w-4 text-brand-orange-dark" aria-hidden />}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            {!isLoaded && <div aria-label="Loading account" role="status" className="h-11 w-20 animate-pulse rounded-xl bg-navy-100 motion-reduce:animate-none sm:w-40" />}
            {isLoaded && isSignedIn && (
              <>
                <Link href="/dashboard" className={`hidden min-h-11 items-center gap-2 rounded-xl bg-brand-orange px-5 text-sm font-semibold text-navy-950 transition hover:bg-orange-300 sm:inline-flex ${focusRing}`}>
                  Dashboard <ArrowUpRight className="h-4 w-4" aria-hidden />
                </Link>
                <UserButton />
              </>
            )}
            {isLoaded && !isSignedIn && (
              <>
                <Link href="/sign-in" className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-navy-800 transition hover:bg-navy-50 hover:text-navy-950 ${focusRing}`}>Sign in</Link>
                <Link href="/sign-up" className={`hidden min-h-11 items-center gap-2 rounded-xl bg-brand-orange px-5 text-sm font-semibold text-navy-950 transition hover:bg-orange-300 sm:inline-flex ${focusRing}`}>
                  Create account <ArrowUpRight className="h-4 w-4" aria-hidden />
                </Link>
              </>
            )}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <button type="button" aria-label="Open navigation menu" className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border border-navy-200 text-navy-950 transition hover:bg-orange-50 md:hidden ${focusRing}`}>
                  <Menu className="h-5 w-5" />
                </button>
              </SheetTrigger>
              <SheetContent side="right" aria-describedby={undefined} className="w-80 max-w-[90vw] overflow-y-auto border-navy-200 bg-white p-0 text-navy-950">
                <SheetHeader className="border-b border-navy-100 px-5 py-6 text-left">
                  <SiteLogoMark logo={logo} className="h-14 w-24 rounded-md">KT</SiteLogoMark>
                  <SheetTitle className="text-lg font-bold">Kaliganj Travels</SheetTitle>
                </SheetHeader>
                <nav aria-label="Mobile travel navigation" className="space-y-1 p-4">
                  {navigation.map((item) => (
                    <SheetClose asChild key={item.href}>
                      <Link href={item.href} className={`flex min-h-12 items-center justify-between rounded-xl px-4 text-sm font-semibold transition hover:bg-orange-50 ${focusRing}`}>
                        {item.label}<ArrowUpRight className="h-4 w-4 text-brand-orange-dark" aria-hidden />
                      </Link>
                    </SheetClose>
                  ))}
                </nav>
                {isLoaded && isSignedIn ? (
                  <DashboardSidebar role={role} hiddenNavSegments={hiddenNavSegments} logo={logo} expanded onNavigate={() => setMobileMenuOpen(false)} />
                ) : isLoaded ? (
                  <div className="space-y-2 border-t border-navy-100 p-4">
                    <SheetClose asChild>
                      <Link href="/sign-in" className={`flex min-h-12 items-center gap-3 rounded-xl border border-navy-200 px-4 text-sm font-semibold hover:bg-navy-50 ${focusRing}`}><LogIn className="h-4 w-4" aria-hidden />Sign in</Link>
                    </SheetClose>
                    <SheetClose asChild>
                      <Link href="/sign-up" className={`flex min-h-12 items-center gap-3 rounded-xl bg-brand-orange px-4 text-sm font-semibold hover:bg-orange-300 ${focusRing}`}><UserPlus className="h-4 w-4" aria-hidden />Create account</Link>
                    </SheetClose>
                  </div>
                ) : null}
                <div className="border-t border-navy-100 p-5">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-navy-500">Travel support</p>
                  <a href={SITE_PHONE_HREF} className={`inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold ${focusRing}`}><Phone className="h-4 w-4 text-brand-orange-dark" aria-hidden />{SITE_PHONE}</a>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
    </>
  );
}
