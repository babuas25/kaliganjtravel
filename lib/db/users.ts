import { supabaseAdmin } from '@/lib/supabase/server';
import type { Role } from '@/lib/roles';

/**
 * The user registry: one `app_users` row per person who has opened the
 * dashboard. Clerk remains the authority on who exists and what role they
 * hold; this mirror is what lets Users & Roles, B2B Users and any future
 * reporting query people directly instead of paging the Clerk API.
 */

export type AppUserInput = {
  clerkId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Clerk's role, never the dev switcher's preview role. */
  role: Role;
};

/**
 * Records a visit: inserts the row on first sight, refreshes the mirrored
 * identity and `last_seen_at` after that.
 *
 * Never throws. A registry write failing is not a reason to take the dashboard
 * down with it — the page renders from Clerk either way, so the cost of a
 * failure is a stale row, and the error goes to the server log.
 */
export async function recordUserVisit(user: AppUserInput): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;

  const { error } = await supabase.from('app_users').upsert(
    {
      clerk_id: user.clerkId,
      email: user.email || null,
      first_name: user.firstName || null,
      last_name: user.lastName || null,
      role: user.role,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'clerk_id' }
  );

  if (error) {
    console.error('[db] recordUserVisit failed:', error.message);
  }
}

/**
 * Records a role change made in Users & Roles: the mirrored role, and the
 * agency the person now belongs to (`null` for every role outside one).
 *
 * Role and agency move together — granting `b2b_sub` is granting it *at* an
 * agency — so they are one write rather than two that could half-apply.
 *
 * **Upsert, not update.** The roster comes from Clerk, and someone who signed
 * up but has never opened the dashboard has no row here yet; an update would
 * match nothing and the agency assignment would be silently lost. A stub row
 * is safe: every other column is nullable, and `recordUserVisit()` fills them
 * in on that person's first visit without touching `agency_code`.
 *
 * Unlike the role, where Clerk is the authority and this is a convenience,
 * **the agency link is authoritative here** — this write is what decides which
 * agency a sub user belongs to. So it reports whether it worked, and the
 * caller must not report success when it did not.
 */
export async function mirrorUserRole(
  clerkId: string,
  role: Role,
  agencyCode: string | null
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;

  const { error } = await supabase
    .from('app_users')
    .upsert(
      { clerk_id: clerkId, role, agency_code: agencyCode },
      { onConflict: 'clerk_id' }
    );

  if (error) {
    console.error('[db] mirrorUserRole failed:', error.message);
    return false;
  }
  return true;
}

/** Drops the mirrored row after the Clerk account itself has been deleted. */
export async function forgetUser(clerkId: string): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;

  const { error } = await supabase
    .from('app_users')
    .delete()
    .eq('clerk_id', clerkId);

  if (error) {
    console.error('[db] forgetUser failed:', error.message);
  }
}
