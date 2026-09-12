import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';

import LogoUploader from '@/components/dashboard/LogoUploader';
import { getSiteLogo } from '@/lib/appearance';
import { getDashboardSession } from '@/lib/dashboard/session';
import { isCloudinaryConfigured } from '@/lib/cloudinary';

export const metadata: Metadata = {
  title: 'Appearance — Kaliganj Travels',
};

/**
 * Site-wide branding. Superadmin only — the same check the nav makes, repeated
 * here so a direct URL 404s for everyone else rather than rendering.
 */
export default async function AppearancePage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin') notFound();

  const logo = await getSiteLogo();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-navy-950">Appearance</h1>
        <p className="mt-1 text-sm text-navy-700/70">
          Branding that applies to the whole site. Changes go live as soon as
          you save.
        </p>
      </div>

      <LogoUploader logo={logo} configured={isCloudinaryConfigured()} />
    </div>
  );
}
