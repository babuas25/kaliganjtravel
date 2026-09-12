'use client';

import { usePathname } from 'next/navigation';

export default function AuthPanelHeading() {
  const pathname = usePathname();
  const isSignUp = pathname?.startsWith('/sign-up') ?? false;

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-orange-dark">Your Kaliganj account</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">{isSignUp ? 'Let’s get you started' : 'Welcome back'}</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-500">{isSignUp ? 'Create an account to book and manage your journeys.' : 'Sign in to book your next trip and manage your bookings.'}</p>
    </div>
  );
}
