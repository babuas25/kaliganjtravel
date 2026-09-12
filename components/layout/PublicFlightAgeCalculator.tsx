'use client';

import { useAuth } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';

import AgeCalculator from '@/components/layout/AgeCalculator';

export default function PublicFlightAgeCalculator() {
  const pathname = usePathname();
  const { isLoaded, isSignedIn } = useAuth();

  // The home page is always a public search surface. Signed-in flight pages
  // use DashboardShell, which renders the role-scoped calculator instead.
  if (pathname === '/') return <AgeCalculator />;

  const isFlightPage = pathname === '/flights' || pathname.startsWith('/flights/');
  if (!isFlightPage || !isLoaded || isSignedIn) return null;

  return <AgeCalculator />;
}
