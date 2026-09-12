'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Role } from '@/lib/roles';
import type { SiteLogo } from '@/lib/appearance';
import DashboardSidebar from '@/components/dashboard/DashboardSidebar';
import DashboardTopbar from '@/components/dashboard/DashboardTopbar';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import AgeCalculator from '@/components/layout/AgeCalculator';
import Footer from '@/components/layout/Footer';

interface Props {
  role: Role;
  hiddenNavSegments: readonly string[];
  name: string;
  /** Agency code for a B2B partner or sub user; null for everyone else. */
  agencyCode: string | null;
  /** Uploaded site logo, or null for the built-in mark. */
  logo: SiteLogo | null;
  /** Active public ticker messages, already ordered by the server. */
  announcementMessages?: readonly string[];
  /** Seconds for one complete ticker loop. */
  announcementDurationSeconds?: number;
  showDevRoleSwitcher: boolean;
  children: React.ReactNode;
}

/**
 * Chrome shared by every role: fixed sidebar on desktop (collapsible to a
 * rail), off-canvas drawer on mobile. Only the nav contents differ by role.
 */
export default function DashboardShell({
  role,
  hiddenNavSegments,
  name,
  agencyCode,
  logo,
  announcementMessages = [],
  announcementDurationSeconds = 28,
  showDevRoleSwitcher,
  children,
}: Props) {
  const pathname = usePathname();
  // Start desktop sessions as a compact rail and reveal labels while the
  // pointer is over the sidebar.
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const showAnnouncement =
    pathname === '/dashboard' || pathname === '/dashboard/flight-search';
  const fullBleedContent = pathname === '/dashboard/flight-search';
  const showAgeCalculator =
    role === 'b2b' || role === 'b2b_sub' || role === 'customer';

  return (
    <div className="min-h-screen bg-navy-50 text-navy-950">
      {/* Desktop sidebar */}
      <div
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden lg:block',
          expanded ? 'w-64' : 'w-16'
        )}
      >
        <DashboardSidebar role={role} logo={logo} expanded={expanded} hiddenNavSegments={hiddenNavSegments} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-navy-950/60"
          />
          <div className="absolute inset-y-0 left-0 animate-slide-in">
            <DashboardSidebar
              role={role}
              hiddenNavSegments={hiddenNavSegments}
              logo={logo}
              expanded
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
            className="absolute left-[17rem] top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Content column */}
      <div
        className={cn(
          'flex min-h-screen flex-col transition-all duration-300 ease-in-out',
          expanded ? 'lg:pl-64' : 'lg:pl-16'
        )}
      >
        <DashboardTopbar
          role={role}
          name={name}
          agencyCode={agencyCode}
          expanded={expanded}
          showDevRoleSwitcher={showDevRoleSwitcher}
          onToggleSidebar={() => setExpanded((prev) => !prev)}
          onOpenMobileNav={() => setMobileOpen(true)}
        />
        {showAnnouncement ? (
          <AnnouncementBar
            messages={announcementMessages}
            durationSeconds={announcementDurationSeconds}
          />
        ) : null}
        <main
          className={cn(
            'flex-1',
            fullBleedContent ? 'p-0' : 'px-4 py-6 sm:px-6 lg:px-8'
          )}
        >
          {children}
        </main>
        <Footer />
      </div>
      {showAgeCalculator ? <AgeCalculator /> : null}
    </div>
  );
}
