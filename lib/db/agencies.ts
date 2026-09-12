import {
  generateAgencyCode,
  isAgencyCode,
  type AgencyOption,
} from '@/lib/agency';
import { supabaseAdmin } from '@/lib/supabase/server';
import type { Role } from '@/lib/roles';

/**
 * Agency membership: who belongs to which agency, and who owns it.
 *
 * **The database is the authority here.** The provider's user metadata may
 * carry `agencyCode` — an invitation has to, since it travels before any row
 * exists — but that value is only ever a *seed* for a user with no link yet,
 * and it is checked against the `agencies` table before it is stored. Once the
 * row exists, nothing outside Postgres can change who a person works for.
 *
 * Every authorization decision about sub users reads `isOwner` from here.
 */

const AGENCIES = 'agencies';
const APP_USERS = 'app_users';

/** Postgres unique-violation. Both of this module's collisions raise it. */
const UNIQUE_VIOLATION = '23505';

/**
 * Where a user sits in the agency structure.
 *
 * A failed read is `ok: false`, kept separate from "belongs to no agency", and
 * the difference decides permissions: callers **must fail closed** on it. A
 * database that cannot be reached is not a database that said yes.
 */
export type AgencyMembership =
  | { ok: true; agencyCode: string | null; isOwner: boolean }
  | { ok: false };

/**
 * The canonical profile that owns an agency's shared branding.
 *
 * B2B sub users have their own profile row, but the agency name and logo shown
 * on bookings come from the agency owner's row. Administrative logo changes
 * therefore resolve through this structure instead of writing to whichever
 * member happened to be opened in Users & Roles.
 */
export type AgencyProfileOwner =
  | { ok: true; agencyCode: string; ownerUserId: string }
  | { ok: true; agencyCode: null; ownerUserId: null }
  | { ok: false };

/** Belongs to nothing. The answer for every role that is not B2B. */
const UNAFFILIATED: AgencyMembership = {
  ok: true,
  agencyCode: null,
  isOwner: false,
};

const FAILED: AgencyMembership = { ok: false };

type Client = NonNullable<ReturnType<typeof supabaseAdmin>>;

/**
 * The stored membership, read fresh. `isOwner` is derived by comparing the
 * agency's `owner_user_id` to this user rather than inferred from their role,
 * so a mirrored role that has drifted cannot grant ownership.
 */
async function readMembership(
  supabase: Client,
  userId: string
): Promise<AgencyMembership> {
  const { data, error } = await supabase
    .from(APP_USERS)
    .select('agency_code')
    .eq('clerk_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[db] readMembership failed:', error.message);
    return FAILED;
  }

  const agencyCode = (data?.agency_code as string | null) ?? null;
  if (!agencyCode) return UNAFFILIATED;

  const { data: agency, error: agencyError } = await supabase
    .from(AGENCIES)
    .select('owner_user_id')
    .eq('agency_code', agencyCode)
    .maybeSingle();

  if (agencyError) {
    console.error('[db] readMembership agency failed:', agencyError.message);
    return FAILED;
  }

  return {
    ok: true,
    agencyCode,
    isOwner: Boolean(agency) && agency?.owner_user_id === userId,
  };
}

/** The agency this user owns, or null. Null is also the answer for a failure. */
async function findOwnedAgency(
  supabase: Client,
  ownerUserId: string
): Promise<{ ok: boolean; agencyCode: string | null }> {
  const { data, error } = await supabase
    .from(AGENCIES)
    .select('agency_code')
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    console.error('[db] findOwnedAgency failed:', error.message);
    return { ok: false, agencyCode: null };
  }

  return { ok: true, agencyCode: (data?.agency_code as string) ?? null };
}

/** Points a person at an agency. The owner gets this too — they belong to theirs. */
async function setMembership(
  supabase: Client,
  userId: string,
  agencyCode: string
): Promise<boolean> {
  const { error } = await supabase
    .from(APP_USERS)
    .update({ agency_code: agencyCode })
    .eq('clerk_id', userId);

  if (error) {
    console.error('[db] setMembership failed:', error.message);
    return false;
  }
  return true;
}

/**
 * Attempts before giving up on finding a free code.
 *
 * With ~900k codes and a handful of agencies, one collision is already
 * improbable and eight in a row is not something a healthy system produces —
 * so exhausting this means something else is wrong, and refusing beats
 * spinning.
 */
const MAX_ATTEMPTS = 8;

/**
 * Creates the agency, retrying until the code is free.
 *
 * Uniqueness is settled by the primary key, not by looking first: a
 * check-then-insert would let two concurrent first-loads agree that a code was
 * free. Insert, and let Postgres be the one to say no.
 *
 * A unique violation has two possible causes and they need opposite responses,
 * so rather than parsing the constraint name out of the error we re-read: if
 * this owner now has an agency, another request created it and we take theirs;
 * otherwise the collision was on the code, and we try a different one.
 */
async function createAgency(
  supabase: Client,
  ownerUserId: string
): Promise<AgencyMembership> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const agencyCode = generateAgencyCode();

    const { error } = await supabase
      .from(AGENCIES)
      .insert({ agency_code: agencyCode, owner_user_id: ownerUserId });

    if (!error) {
      await setMembership(supabase, ownerUserId, agencyCode);
      return { ok: true, agencyCode, isOwner: true };
    }

    if (error.code !== UNIQUE_VIOLATION) {
      console.error('[db] createAgency failed:', error.message);
      return FAILED;
    }

    const raced = await findOwnedAgency(supabase, ownerUserId);
    if (!raced.ok) return FAILED;
    if (raced.agencyCode) {
      await setMembership(supabase, ownerUserId, raced.agencyCode);
      return { ok: true, agencyCode: raced.agencyCode, isOwner: true };
    }
    // The code itself was taken. Round again with a new one.
  }

  console.error(
    `[db] createAgency exhausted ${MAX_ATTEMPTS} attempts for ${ownerUserId}`
  );
  return FAILED;
}

/**
 * Resolves — and where necessary establishes — this user's place in the agency
 * structure. Called once per dashboard request from `getDashboardSession()`.
 *
 * A **B2B partner** gets an agency created on first sight, which is what makes
 * "generated automatically when a new agency is created" true however the role
 * was granted: promoted in Users & Roles, accepted from an invitation, or set
 * by hand in the provider's dashboard. All three arrive here.
 *
 * A **Sub User** is linked from `seedCode` exactly once, and only if that code
 * names a real agency. After that the stored link is the answer and the seed is
 * ignored — so the mirror can drift, or be wrong, without moving anybody.
 *
 * Pass the provider's *real* role, never a previewed one: the dev role switcher
 * must not mint an agency.
 */
export async function resolveAgency(
  userId: string,
  role: Role,
  seedCode: unknown
): Promise<AgencyMembership> {
  if (role !== 'b2b' && role !== 'b2b_sub') return UNAFFILIATED;

  const supabase = supabaseAdmin();
  if (!supabase) return FAILED;

  const membership = await readMembership(supabase, userId);
  if (!membership.ok) return FAILED;

  if (role === 'b2b') {
    if (membership.isOwner) return membership;

    // Owns one, but `app_users` does not say so yet — a membership write that
    // failed after the agency was created, or a partner who was a sub user
    // before being promoted.
    const owned = await findOwnedAgency(supabase, userId);
    if (!owned.ok) return FAILED;
    if (owned.agencyCode) {
      await setMembership(supabase, userId, owned.agencyCode);
      return { ok: true, agencyCode: owned.agencyCode, isOwner: true };
    }

    return createAgency(supabase, userId);
  }

  // Sub User.
  if (membership.agencyCode) return membership;
  if (!isAgencyCode(seedCode)) return UNAFFILIATED;

  // The seed came from outside the database, so it is a claim until the
  // agencies table agrees. An unknown code links nobody to anything.
  const { data, error } = await supabase
    .from(AGENCIES)
    .select('agency_code')
    .eq('agency_code', seedCode)
    .maybeSingle();

  if (error) {
    console.error('[db] resolveAgency seed lookup failed:', error.message);
    return FAILED;
  }
  if (!data) return UNAFFILIATED;

  if (!(await setMembership(supabase, userId, seedCode))) return FAILED;
  return { ok: true, agencyCode: seedCode, isOwner: false };
}

/* ── Administration ────────────────────────────────────────────────
 *
 * Used by Users & Roles, where an admin granting `b2b_sub` has to name the
 * agency the person joins. A B2B partner never reaches any of this: their own
 * agency is the only possible answer, so it is filled in for them.
 */

/**
 * Every agency, for the admin's picker. Newest first, matching the roster's
 * order.
 *
 * The label is assembled from two other tables because the agency's *name*
 * lives on the owner's profile (`user_profiles.agency_name`) — the agencies
 * table holds identity, not business details. A partner who has not filled in
 * their profile yet falls back to their email, and then to the bare code, so
 * an agency is never unselectable merely for being new.
 */
export async function listAgencies(): Promise<AgencyOption[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(AGENCIES)
    .select('agency_code, owner_user_id')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[db] listAgencies failed:', error.message);
    return [];
  }

  const rows = (data ?? []) as {
    agency_code: string;
    owner_user_id: string | null;
  }[];

  const ownerIds = rows
    .map((row) => row.owner_user_id)
    .filter((id): id is string => Boolean(id));

  const names = new Map<string, string>();

  if (ownerIds.length) {
    const [profiles, users] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('clerk_id, agency_name')
        .in('clerk_id', ownerIds),
      supabase.from(APP_USERS).select('clerk_id, email').in('clerk_id', ownerIds),
    ]);

    for (const row of (users.data ?? []) as {
      clerk_id: string;
      email: string | null;
    }[]) {
      if (row.email) names.set(row.clerk_id, row.email);
    }
    // Business name wins over email where both exist.
    for (const row of (profiles.data ?? []) as {
      clerk_id: string;
      agency_name: string | null;
    }[]) {
      if (row.agency_name) names.set(row.clerk_id, row.agency_name);
    }
  }

  return rows.map((row) => ({
    agencyCode: row.agency_code,
    label: (row.owner_user_id && names.get(row.owner_user_id)) || '',
  }));
}

/**
 * Agency code per user, for the roster — one query for the whole page rather
 * than one per row. Users with no agency are simply absent from the map.
 */
export async function membershipsFor(
  userIds: string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!userIds.length) return found;

  const supabase = supabaseAdmin();
  if (!supabase) return found;

  const { data, error } = await supabase
    .from(APP_USERS)
    .select('clerk_id, agency_code')
    .in('clerk_id', userIds);

  if (error) {
    console.error('[db] membershipsFor failed:', error.message);
    return found;
  }

  for (const row of (data ?? []) as {
    clerk_id: string;
    agency_code: string | null;
  }[]) {
    if (row.agency_code) found.set(row.clerk_id, row.agency_code);
  }
  return found;
}

/**
 * Resolves one user's agency and its canonical profile owner without creating
 * or changing membership. Missing membership is a valid unaffiliated answer;
 * a broken/missing agency row fails closed because an administrative write must
 * never guess which user's profile should receive shared branding.
 */
export async function agencyProfileOwnerFor(
  userId: string
): Promise<AgencyProfileOwner> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false };

  const { data: member, error: memberError } = await supabase
    .from(APP_USERS)
    .select('agency_code')
    .eq('clerk_id', userId)
    .maybeSingle();

  if (memberError) {
    console.error('[db] agencyProfileOwnerFor membership failed:', memberError.message);
    return { ok: false };
  }

  const agencyCode = (member?.agency_code as string | null) ?? null;
  if (!agencyCode) {
    return { ok: true, agencyCode: null, ownerUserId: null };
  }

  const { data: agency, error: agencyError } = await supabase
    .from(AGENCIES)
    .select('owner_user_id')
    .eq('agency_code', agencyCode)
    .maybeSingle();

  if (agencyError) {
    console.error('[db] agencyProfileOwnerFor agency failed:', agencyError.message);
    return { ok: false };
  }

  const ownerUserId = (agency?.owner_user_id as string | null) ?? null;
  if (!ownerUserId) {
    console.error('[db] agencyProfileOwnerFor found no owner for:', agencyCode);
    return { ok: false };
  }

  return { ok: true, agencyCode, ownerUserId };
}

/**
 * Whether this code names a real agency.
 *
 * The gate on granting `b2b_sub`. Note what a `false` covers: a malformed
 * code, an unknown one, **and** a database that could not be asked. All three
 * have to block the grant, because none of them is evidence that the agency
 * exists — and a sub user attached to nothing is the state this whole check is
 * here to prevent.
 */
export async function agencyExists(code: unknown): Promise<boolean> {
  if (!isAgencyCode(code)) return false;

  const supabase = supabaseAdmin();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from(AGENCIES)
    .select('agency_code')
    .eq('agency_code', code)
    .maybeSingle();

  if (error) {
    console.error('[db] agencyExists failed:', error.message);
    return false;
  }
  return Boolean(data);
}

/**
 * Writing the membership after an admin's grant is `mirrorUserRole()` in
 * `lib/db/users.ts` — role and agency move together, so they are one write.
 */
