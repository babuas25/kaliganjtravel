import Link from 'next/link';
import SiteLogoMark from '@/components/layout/SiteLogoMark';
import { Facebook, Mail, MapPin, Phone } from 'lucide-react';

import {
  SITE_ADDRESS,
  SITE_EMAIL,
  SITE_FACEBOOK_HREF,
  SITE_PHONE,
  SITE_PHONE_HREF,
  SITE_WHATSAPP_HREF,
} from '@/lib/site';

const cols = [
  {
    title: 'Company',
    links: [
      { label: 'About us', href: '/about-us' },
      { label: 'Careers', href: '/careers' },
      { label: 'Blog', href: '/blog' },
      { label: 'Affiliates', href: '/affiliates' },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'Help center', href: '/help-center' },
      { label: 'Contact us', href: '/contact-us' },
      { label: 'Booking guide', href: '/booking-guide' },
      { label: 'Cancellation', href: '/cancellation' },
      { label: 'Refunds', href: '/refunds' },
    ],
  },
  {
    title: 'Discover',
    links: [
      { label: 'Destinations', href: '/destinations' },
      { label: 'Flight routes', href: '/flight-routes' },
      { label: 'Travel guide', href: '/travel-guides' },
      { label: 'Visa info', href: '/visa-info' },
      { label: 'Travel insurance', href: '/travel-insurance' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="mt-10 border-t border-neutral-200 bg-neutral-100 text-black">
      {/* Newsletter */}
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-orange-200 bg-brand-orange px-6 py-8 text-center text-black md:flex-row md:text-left">
          <div className="flex-1">
            <h3 className="text-xl font-bold">Get the best deals first</h3>
            <p className="mt-1 text-sm text-black/80">
              Subscribe to our newsletter for exclusive fares and travel tips.
            </p>
          </div>
          <form className="flex w-full max-w-md gap-2">
            <input
              type="email"
              placeholder="Your email address"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm text-black placeholder:text-neutral-600 focus:border-brand-orange focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-navy-950 transition-colors hover:bg-white/80 hover:text-black"
            >
              Subscribe
            </button>
          </form>
        </div>
      </div>

      {/* Links */}
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          {/* Brand */}
          <div className="col-span-2 md:col-span-2">
            <div className="flex items-center gap-2">
              <SiteLogoMark logo={null} className="h-16 w-28 rounded-lg">KT</SiteLogoMark>
              <span className="text-lg font-bold text-black">Kaliganj Travels</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-neutral-600">
              Flights, visas, and travel made simple.
            </p>
            <div className="mt-4 space-y-2 text-sm text-neutral-600">
              <a
                href={SITE_PHONE_HREF}
                className="flex items-center gap-2 transition-colors hover:text-black"
              >
                <Phone className="h-4 w-4 shrink-0 text-black" />
                {SITE_PHONE}
              </a>
              <a
                href={`mailto:${SITE_EMAIL}`}
                className="flex items-center gap-2 transition-colors hover:text-black"
              >
                <Mail className="h-4 w-4 shrink-0 text-black" />
                {SITE_EMAIL}
              </a>
              {/* items-start, not items-center: the address runs to two lines
                  in this column, and the pin belongs beside the first one. */}
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-black" /> <span>{SITE_ADDRESS}</span></p>
            </div>
          </div>

          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="text-sm font-semibold text-black">{c.title}</h4>
              <ul className="mt-3 space-y-2">
                {c.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-neutral-600 transition-colors hover:text-black"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-neutral-200 pt-6 md:flex-row">
          <p className="text-xs text-neutral-600">
            © 2026 Kaliganj Travels. All rights reserved.
          </p>
          <div className="flex items-center gap-2">
            <a
              href={SITE_FACEBOOK_HREF}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Kaliganj Travels on Facebook"
              title="Facebook"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-neutral-600 transition-colors hover:bg-white/20 hover:text-black"
            >
              <Facebook className="h-4 w-4" />
            </a>
            <a
              href={SITE_WHATSAPP_HREF}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Chat with Kaliganj Travels on WhatsApp at 01795-271171"
              title="WhatsApp: 01795-271171"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-neutral-600 transition-colors hover:bg-[#25D366] hover:text-black"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3a9 9 0 0 0-7.7 13.67L3 21l4.46-1.2A9 9 0 1 0 12 3Z" />
                <path d="M8.35 7.75c.28-.3.72-.24.94.1l1.02 1.55c.18.28.15.63-.08.86l-.7.7a8.25 8.25 0 0 0 3.55 3.55l.7-.7c.23-.23.58-.26.86-.08l1.55 1.02c.34.22.4.66.1.94l-.76.72c-.52.5-1.28.68-1.97.47-3.3-1-5.92-3.62-6.92-6.92-.21-.69-.03-1.45.47-1.97l.72-.76Z" />
              </svg>
            </a>
          </div>
          <div className="flex gap-4 text-xs text-neutral-600">
            <Link href="/privacy-policy" className="hover:text-black">
              Privacy Policy
            </Link>
            <Link href="/terms-and-conditions" className="hover:text-black">
              Terms &amp; Conditions
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
