import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Which accounts belong to an agency.
 *
 * **The database answers this, not Clerk.** Clerk cannot filter a user list by
 * public metadata — it is why `anotherSuperAdminExists()` in the Users & Roles
 * actions has to page the entire roster — so asking Clerk "who works for this
 * agency" would mean walking every account in the installation on every page
 * load. The mirror exists precisely so this is one indexed query.
 *
 * The division of labour that follows: **the database says who belongs to the
 * agency, Clerk says what state those accounts are in** (name, avatar, last
 * sign-in and access metadata). Neither is asked a question the other owns.
 */

const APP_USERS = 'app_users';

/** Sub users an agency can hold before the page pages. Far beyond real use. */
export const MAX_AGENCY_MEMBERS = 100;

/**
 * Ids of everyone linked to this agency, newest first.
 *
 * Deliberately **not** filtered by role in SQL. `app_users.role` is a mirror of
 * Clerk's and can lag; filtering on it here would silently hide a real sub user
 * whose mirror is stale. The caller filters on Clerk's answer instead, which
 * also drops the owner — they belong to the agency too.
 */
export async function agencyMemberIds(agencyCode: string): Promise<string[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(APP_USERS)
    .select('clerk_id')
    .eq('agency_code', agencyCode)
    .order('created_at', { ascending: false })
    .limit(MAX_AGENCY_MEMBERS);

  if (error) {
    console.error('[db] agencyMemberIds failed:', error.message);
    return [];
  }

  return ((data ?? []) as { clerk_id: string }[]).map((row) => row.clerk_id);
}

/**
 * Whether this account is recorded as belonging to this agency.
 *
 * Half of the ownership check every sub-user action makes; the other half is
 * the target's role, which Clerk owns. Each authority is asked only what it
 * owns, and both have to agree before a partner may touch an account.
 *
 * False on a failed read, as everywhere else here: a database that could not
 * answer has not said yes.
 */
export async function isAgencyMember(
  agencyCode: string,
  userId: string
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from(APP_USERS)
    .select('agency_code')
    .eq('clerk_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[db] isAgencyMember failed:', error.message);
    return false;
  }

  return data?.agency_code === agencyCode;
}
