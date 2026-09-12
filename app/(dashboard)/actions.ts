'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { auth } from '@clerk/nextjs/server';

import { resolveRole } from '@/lib/roles';
import { DEV_ROLE_COOKIE, IS_DEV } from '@/lib/dashboard/session';

/**
 * Dev-only: preview the dashboard as another role while the data layer is
 * still mocked. No-ops in production so it can never grant real privileges.
 *
 * The value is stored as `<userId>:<role>`. The cookie has no expiry and
 * survives a sign-out, so without the id it would follow the browser into the
 * next account signed in on it — and a wrong role is the hardest thing to
 * notice, because the dashboard looks entirely normal. `getDashboardSession()`
 * ignores any value not written for the current user.
 */
export async function setDevRole(role: string) {
  if (!IS_DEV) return;

  const { userId } = await auth();
  if (!userId) return;

  const store = await cookies();
  store.set(DEV_ROLE_COOKIE, `${userId}:${resolveRole(role)}`, {
    path: '/',
    sameSite: 'lax',
  });

  revalidatePath('/dashboard', 'layout');
}
