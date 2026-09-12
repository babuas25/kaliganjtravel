import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';

import MarkupManager from '@/components/dashboard/MarkupManager';
import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import { listMarkupRules } from '@/lib/db/markup-rules';
import { isSupabaseConfigured } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Fare Pricing Rules — Kaliganj Travels',
};

/**
 * Commercial pricing control. Both the page and every action are Super Admin
 * only; hiding the sidebar item is presentation, not authorization.
 */
export default async function MarkupPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role !== 'superadmin') notFound();

  const [rulesResult, agencies] = await Promise.all([
    listMarkupRules(),
    listAgencies(),
  ]);

  return (
    <MarkupManager
      rules={rulesResult.rules}
      agencies={agencies}
      configured={isSupabaseConfigured()}
      readFailed={!rulesResult.ok}
    />
  );
}
