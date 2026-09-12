'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plane, Rocket } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  canRequestUpgrade,
  navItemsFor,
  ROLE_LABELS,
  type Role,
} from '@/lib/roles';
import type { SiteLogo } from '@/lib/appearance';
import SiteLogoMark from '@/components/layout/SiteLogoMark';

export function dashboardHref(segment: string) {
  return segment ? `/dashboard/${segment}` : '/dashboard';
}

interface Props {
  role: Role;
  hiddenNavSegments: readonly string[];
  /** Uploaded site logo, or null for the built-in plane mark. */
  logo: SiteLogo | null;
  /** Collapsed rail (w-16) vs. full panel (w-64). Always full on mobile. */
  expanded: boolean;
  /** Called after a nav click so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

export default function DashboardSidebar({
  role,
  hiddenNavSegments,
  logo,
  expanded,
  onNavigate,
}: Props) {
  const pathname = usePathname();
  const items = navItemsFor(role).filter(
    (item) => !hiddenNavSegments.includes(item.segment),
  );

  return (
    <div
      className={cn(
        'flex h-full flex-col bg-brand-orange text-black transition-all duration-300 ease-in-out',
        expanded ? 'w-64' : 'w-16'
      )}
    >
      {/* Logo. Goes to Flight Search rather than the marketing home page —
          from inside the account area, the booking engine is the useful
          destination, and it keeps the click within the dashboard. */}
      <Link
        href="/dashboard/flight-search"
        onClick={onNavigate}
        className="flex h-16 shrink-0 items-center border-b border-black/10 px-3"
      >
        <SiteLogoMark logo={logo} className={expanded ? 'h-12 w-20 rounded-md' : 'h-9 w-9 rounded-md'}>
          <Plane className="h-4 w-4 text-black" />
        </SiteLogoMark>
        <div
          className={cn(
            'ml-3 overflow-hidden transition-all duration-300',
            expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
          )}
        >
          {/* Wraps rather than nowrap: the full name is wider than the rail. */}
          <p className="text-base font-bold leading-tight">
            Kaliganj Travels
          </p>
          <p className="whitespace-nowrap text-xs text-black/75">
            {ROLE_LABELS[role]}
          </p>
        </div>
      </Link>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map(({ segment, label, icon: Icon, built }) => {
          const href = dashboardHref(segment);
          const active = segment
            ? pathname.startsWith(href) ||
              (segment === 'flight-search' && pathname.startsWith('/flights/checkout'))
            : pathname === '/dashboard';

          return (
            <Link
              key={href}
              href={href}
              prefetch={segment === 'bookings'}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={!expanded ? label : undefined}
              className={cn(
                'group flex items-center gap-3 rounded-md px-2.5 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-white text-black shadow-sm'
                  : 'text-black/75 hover:bg-white/30 hover:text-black'
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span
                className={cn(
                  'flex flex-1 items-center gap-2 overflow-hidden whitespace-nowrap transition-all duration-300',
                  expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
                )}
              >
                {label}
                {!built && (
                  <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/75">
                    Soon
                  </span>
                )}
              </span>
              {active && expanded && built && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-brand-orange" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-black/10 px-2 py-4">
        {/* Account upgrade action, separate from the navigation. */}
        {canRequestUpgrade(role) && (
          <Link
            href="/dashboard/upgrade"
            onClick={onNavigate}
            title={!expanded ? 'Upgrade to Business' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md bg-white px-2.5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-white/80',
              !expanded && 'justify-center'
            )}
          >
            <Rocket className="h-5 w-5 shrink-0" />
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap transition-all duration-300',
                expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
              )}
            >
              Upgrade to Business
            </span>
          </Link>
        )}

        <p
          className={cn(
            'overflow-hidden whitespace-nowrap px-2.5 text-xs text-black/75 transition-all duration-300',
            expanded ? 'opacity-100' : 'w-0 opacity-0'
          )}
        >
          Signed in as {ROLE_LABELS[role]}
        </p>
      </div>
    </div>
  );
}
