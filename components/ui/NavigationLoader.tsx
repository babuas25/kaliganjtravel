'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const DISPLAY_DELAY_MS = 120;
const FAILSAFE_RESET_MS = 60_000;

type PendingNavigation = {
  from: string;
  to: string;
};

function locationKey(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * Flight search owns its own supplier-aware progress UI. A generic route
 * indicator there would overlap the search skeleton and imply that the page,
 * rather than the flight response, is loading.
 */
function usesFlightSearchLoader(pathname: string): boolean {
  return pathname === '/flights';
}

/**
 * A lightweight, global page-navigation signal for ordinary internal links.
 * It intentionally does not attempt to infer arbitrary button work: mutations
 * such as saving a user or issuing a ticket already keep their loading state
 * on the button that started the work, where the feedback is unambiguous.
 */
export default function NavigationLoader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentLocation = locationKey(pathname, searchParams.toString());
  const [visible, setVisible] = useState(false);
  const navigationRef = useRef<PendingNavigation | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const failsafeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (failsafeTimerRef.current !== null) {
      window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    clearTimers();
    navigationRef.current = null;
    setVisible(false);
  }, [clearTimers]);

  const begin = useCallback(
    (from: string, to: string) => {
      clearTimers();
      navigationRef.current = { from, to };

      // A short delay avoids a distracting flash when a prefetched page opens
      // immediately, while slower transitions get an obvious response.
      revealTimerRef.current = window.setTimeout(() => {
        setVisible(true);
        revealTimerRef.current = null;
      }, DISPLAY_DELAY_MS);
      failsafeTimerRef.current = window.setTimeout(
        finish,
        FAILSAFE_RESET_MS
      );
    },
    [clearTimers, finish]
  );

  useEffect(() => {
    // A redirect is still a completed navigation. Checking against the source
    // rather than only the requested destination prevents the indicator from
    // lingering when a protected page forwards to sign-in.
    if (navigationRef.current?.from !== currentLocation) finish();
  }, [currentLocation, finish]);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor ||
        anchor.dataset.globalLoader === 'off' ||
        anchor.hasAttribute('download') ||
        anchor.getAttribute('aria-disabled') === 'true'
      ) {
        return;
      }

      const targetWindow = anchor.getAttribute('target');
      if (targetWindow && targetWindow !== '_self') return;

      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.protocol !== window.location.protocol ||
        usesFlightSearchLoader(destination.pathname)
      ) {
        return;
      }

      const nextLocation = locationKey(
        destination.pathname,
        destination.search.slice(1)
      );
      // Hash links remain in the current document, so they need no loader.
      if (nextLocation === currentLocation) return;

      begin(currentLocation, nextLocation);
    };

    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, [begin, currentLocation]);

  useEffect(() => {
    const resetForBrowserNavigation = () => finish();
    window.addEventListener('pageshow', resetForBrowserNavigation);
    window.addEventListener('popstate', resetForBrowserNavigation);
    return () => {
      window.removeEventListener('pageshow', resetForBrowserNavigation);
      window.removeEventListener('popstate', resetForBrowserNavigation);
    };
  }, [finish]);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers]
  );

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[100]"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <div className="h-1 overflow-hidden bg-navy-950/10 shadow-sm">
        <span className="navigation-loader-bar block h-full w-1/3 bg-brand-orange shadow-[0_0_12px_rgba(232,25,44,0.85)]" />
      </div>
      <div className="absolute right-4 top-3 inline-flex items-center gap-2 rounded-lg border border-navy-100 bg-white/95 px-3 py-2 text-xs font-semibold text-navy-800 shadow-lg backdrop-blur-sm sm:right-6">
        <Loader2
          className="h-4 w-4 animate-spin text-brand-orange motion-reduce:animate-none"
          aria-hidden
        />
        Loading page…
      </div>
    </div>
  );
}
