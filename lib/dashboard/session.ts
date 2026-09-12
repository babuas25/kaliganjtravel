import { cache } from 'react';
import { cookies } from 'next/headers';
import { after } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';

import { isUserActive } from '@/lib/account-access';
import { DEFAULT_ROLE, resolveRole, type Role } from '@/lib/roles';
import { recordUserVisit } from '@/lib/db/users';
import { resolveAgency } from '@/lib/db/agencies';
import { isSessionGoneError } from '@/lib/dashboard/auth-errors';

/** Cookie written by the dev-only role switcher. Ignored in production. */
export const DEV_ROLE_COOKIE = 'dev_role';

export const IS_DEV = process.env.NODE_ENV !== 'production';

export type DashboardSession = {
  /** Clerk user id — the primary key everything user-scoped hangs off. */
  clerkId: string;
  role: Role;
  name: string;
  email: string;
  /** Epoch ms of the last sign-in, or null when Clerk reports none. */
  signedInAt: number | null;
  /**
   * The agency this user belongs to (`ST-B2B######`), or null for everyone
   * outside one — and also when the lookup failed, which is why it is never
   * on its own a reason to allow anything.
   */
  agencyCode: string | null;
  /**
   * Whether the **database** says this user owns `agencyCode`. The gate for
   * managing sub users. False whenever the answer is not a clear yes: an
   * unconfigured or unreachable database fails closed here.
   */
  isAgencyOwner: boolean;
};

/**
 * The signed-in user, or null when the session no longer names a real account.
 *
 * `currentUser()` **throws** rather than returning null when Clerk rejects the
 * lookup, and an uncaught throw in a Server Component takes the whole dashboard
 * down with an error page. The way this is reached in practice: an admin
 * deletes an account while its owner has the dashboard open, and their next
 * reload asks Clerk for a user id that no longer exists.
 *
 * Returning null puts them on the path the layout already had waiting —
 * `if (!session) redirect('/sign-in')`. See `isSessionGoneError()` for which
 * failures are treated this way and which keep propagating.
 */
async function signedInUser() {
  try {
    return await currentUser();
  } catch (error) {
    if (isSessionGoneError(error)) {
      console.warn('[auth] session no longer names a user; signing out');
      return null;
    }
    throw error;
  }
}

/**
 * Whether the current Clerk identity exists but has been disabled by Users &
 * Roles. The dashboard layout uses this to clear a newly-created session
 * instead of bouncing an inactive account between the sign-in page and
 * `/dashboard`.
 */
export const isCurrentAccountInactive = cache(async (): Promise<boolean> => {
  const user = await signedInUser();
  return Boolean(user && !isUserActive(user));
});

/**
 * Resolves the signed-in user and their role for the dashboard. Routine visit
 * telemetry is deferred until after the response; agency users still write
 * before their membership is read, because their first visit can establish an
 * authorization-critical agency relationship.
 *
 * In production the role comes only from Clerk's publicMetadata, so the dev
 * switcher cannot be used to escalate privileges on the deployed site.
 *
 * Wrapped in React's `cache` so the layout and the page it renders share one
 * result — without it the registry write would repeat several times per
 * request.
 */
export const getDashboardSession = cache(
  async (): Promise<DashboardSession | null> => {
    const user = await signedInUser();
    if (!user) return null;

    // The Users & Roles switch is enforced here, at the one shared entry point
    // used by dashboard pages, server actions and authenticated API routes.
    // This deliberately does not depend on Clerk's paid ban feature.
    if (!isUserActive(user)) return null;

    // Clerk's own answer, before any dev override. This is what gets mirrored:
    // previewing the dashboard as another role must not rewrite the real one.
    const clerkRole = resolveRole(user.publicMetadata?.role);
    let role = clerkRole;

    if (IS_DEV) {
      // The cookie is scoped to whoever set it. It outlives a sign-out, so an
      // unscoped value would silently follow the browser into the next
      // account — sign in as a freshly invited Sub User after previewing as a
      // Customer and you would be told you are a Customer, with the real bug
      // invisible underneath. Anything not written for this user is ignored,
      // which also retires cookies from before this format.
      const [ownerId, previewed] = (
        (await cookies()).get(DEV_ROLE_COOKIE)?.value ?? ''
      ).split(':');
      if (previewed && ownerId === user.id) role = resolveRole(previewed);
    }

    const email = user.primaryEmailAddress?.emailAddress ?? '';

    const visit = {
      clerkId: user.id,
      email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: clerkRole,
    };

    if (clerkRole === 'b2b' || clerkRole === 'b2b_sub') {
      await recordUserVisit(visit);
    } else {
      after(() => recordUserVisit(visit));
    }

    // After the registry write, which is what guarantees the row the agency
    // links to. Keyed on Clerk's real role, never the previewed one: viewing
    // the dashboard as a B2B partner in dev must not mint a real agency.
    //
    // `publicMetadata.agencyCode` is a mirror, and is passed only as a seed for
    // a sub user who has no stored link yet — an invitation has to carry the
    // code before any row exists. resolveAgency() checks it against the
    // agencies table and ignores it entirely once the link is stored.
    const agency = await resolveAgency(
      user.id,
      clerkRole,
      user.publicMetadata?.agencyCode
    );

    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.username ||
      'there';

    return {
      clerkId: user.id,
      role: role ?? DEFAULT_ROLE,
      name,
      email,
      signedInAt: user.lastSignInAt ?? null,
      agencyCode: agency.ok ? agency.agencyCode : null,
      isAgencyOwner: agency.ok && agency.isOwner,
    };
  }
);
