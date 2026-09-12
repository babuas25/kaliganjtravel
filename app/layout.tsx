import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Suspense } from 'react';
import { ClerkProvider } from '@clerk/nextjs';

import WhatsAppChatButton from '@/components/layout/WhatsAppChatButton';
import PublicFlightAgeCalculator from '@/components/layout/PublicFlightAgeCalculator';
import NavigationLoader from '@/components/ui/NavigationLoader';
import { getSiteLogo } from '@/lib/appearance';
import { authLocalization } from '@/lib/clerk-appearance';

const inter = Inter({ subsets: ['latin'] });

const TITLE = 'Kaliganj Travels — Book Cheap Flights';
const DESCRIPTION =
  'Book cheap domestic and international flights with Kaliganj Travels.';

// Dynamic only because of the favicon: the uploaded logo doubles as the tab
// icon, and Next has to know its URL at render time. Falls back to the
// framework default when no logo is set.
export async function generateMetadata(): Promise<Metadata> {
  const logo = await getSiteLogo();

  return {
    title: TITLE,
    description: DESCRIPTION,
    openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' },
    twitter: {
      card: 'summary_large_image',
      title: TITLE,
      description: DESCRIPTION,
    },
    icons: logo ? { icon: logo.url, apple: logo.url } : undefined,
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      // Strict CSP routes receive a per-request nonce from clerkMiddleware.
      // `dynamic` lets Clerk read that nonce and attach it to clerk.browser.js;
      // without it the browser blocks Clerk and every auth component stays blank.
      dynamic
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      afterSignOutUrl="/"
      appearance={{ variables: { colorPrimary: '#f68712' } }}
      // `localization` is a Clerk option, so it can only be set here — the
      // sign-in and sign-up pages carry the matching `appearance` themselves.
      localization={authLocalization}
      >
      <html lang="en" suppressHydrationWarning>
        <body className={inter.className}>
          {children}
          <PublicFlightAgeCalculator />
          <WhatsAppChatButton />
          {/* `useSearchParams` lets this global indicator finish on query-only
              navigations too; Suspense keeps the root layout static-safe. */}
          <Suspense fallback={null}>
            <NavigationLoader />
          </Suspense>
        </body>
      </html>
    </ClerkProvider>
  );
}
