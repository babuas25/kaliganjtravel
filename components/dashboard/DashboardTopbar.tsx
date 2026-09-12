'use client';

import { usePathname } from 'next/navigation';
import {
  Mail,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
} from 'lucide-react';

import { findNavItem, ROLE_LABELS, type Role } from '@/lib/roles';
import { SITE_EMAIL } from '@/lib/site';
import { cn } from '@/lib/utils';
import DevRoleSwitcher from '@/components/dashboard/DevRoleSwitcher';
import UserMenu from '@/components/dashboard/UserMenu';
import WalletBalancePopover from '@/components/dashboard/WalletBalancePopover';

/**
 * Segments that render without a topbar heading. Flight Search is its own
 * chrome — the panel fills the page and names itself.
 */
const UNTITLED_SEGMENTS = new Set(['flight-search']);

/**
 * Titles for pages that are real routes but not nav items, so `findNavItem()`
 * has nothing to offer. Upgrade is reached from the button at the foot of the
 * sidebar rather than from the nav — see `canRequestUpgrade()`.
 */
const EXTRA_TITLES: Record<string, string> = {
  upgrade: 'Upgrade to Business',
};

interface Props {
  role: Role;
  name: string;
  /** Agency code for a B2B partner or sub user; null for everyone else. */
  agencyCode: string | null;
  expanded: boolean;
  showDevRoleSwitcher: boolean;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
}

function SupportContact() {
  const phone = '01795271171';

  return (
    <div className="rounded-lg border border-navy-100 bg-white px-3 py-1.5 shadow-sm">
      <strong className="block text-[11px] font-semibold leading-tight text-navy-950">
        Reservation &amp; Support
      </strong>
      <div className="mt-0.5 space-y-0.5 text-[10px] leading-tight text-neutral-600">
        <a
          href={`tel:${phone}`}
          className="flex items-center gap-1 transition hover:text-brand-orange"
        >
          <Phone aria-hidden="true" className="h-3 w-3 shrink-0 text-brand-orange" />
          {phone}
        </a>
        <a
          href={`mailto:${SITE_EMAIL}`}
          className="flex items-center gap-1 transition hover:text-brand-orange"
        >
          <Mail aria-hidden="true" className="h-3 w-3 shrink-0 text-brand-orange" />
          {SITE_EMAIL}
        </a>
      </div>
    </div>
  );
}

export default function DashboardTopbar({
  role,
  name,
  agencyCode,
  expanded,
  showDevRoleSwitcher,
  onToggleSidebar,
  onOpenMobileNav,
}: Props) {
  const pathname = usePathname();
  const checkout = pathname === '/flights/checkout';
  const segment = checkout
    ? 'flight-checkout'
    : pathname.replace(/^\/dashboard\/?/, '').split('/')[0] ?? '';
  const title =
    (checkout ? 'Flight Checkout' : null) ??
    findNavItem(role, segment)?.label ?? EXTRA_TITLES[segment] ?? 'Dashboard';
  const hasWallet =
    role === 'customer' ||
    ((role === 'b2b' || role === 'b2b_sub') && Boolean(agencyCode));

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-navy-100 bg-white/90 px-4 backdrop-blur-md sm:px-6">
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-navy-700 transition hover:bg-navy-50 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        className="hidden h-9 w-9 items-center justify-center rounded-md text-navy-700 transition hover:bg-navy-50 lg:inline-flex"
      >
        {expanded ? (
          <PanelLeftClose className="h-5 w-5" />
        ) : (
          <PanelLeftOpen className="h-5 w-5" />
        )}
      </button>

      {!UNTITLED_SEGMENTS.has(segment) && (
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-navy-950">
            {title}
          </h1>
          <p className="truncate text-xs text-navy-700/70">{name}</p>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        {hasWallet && (
          <>
            <div
              className={cn(
                'hidden',
                expanded ? '2xl:block' : 'lg:block'
              )}
            >
              <SupportContact />
            </div>
            <WalletBalancePopover />
          </>
        )}
        {showDevRoleSwitcher && <DevRoleSwitcher role={role} />}
        <span className="hidden rounded-full bg-brand-orange-light px-3 py-1 text-xs font-semibold text-brand-orange-dark md:inline">
          {ROLE_LABELS[role]}
        </span>
        <UserMenu agencyCode={agencyCode} />
      </div>
    </header>
  );
}
