import { clerkClient } from '@clerk/nextjs/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { isAgencyMember } from '@/lib/db/sub-users';
import { canManageSubUsers, resolveRole, SUB_USER_ROLE } from '@/lib/roles';

/**
 * Who may act on whom inside an agency.
 *
 * One copy of the rule, because it is enforced from two places now — the Sub
 * Users page and the staff records on the Company profile — and two copies of
 * a permission check is one copy too many.
 *
 * Every answer here is re-derived from the authorities on each request:
 * **the role from Clerk, the agency link from Postgres**. Nothing is taken from
 * the caller's payload except the id being asked about.
 */

export type AgencyOwner = {
  clerkId: string;
  agencyCode: string;
};

/**
 * The signed-in user, if they own an agency.
 *
 * Two conditions from two authorities. The role is Clerk's answer (only a B2B
 * partner reaches this, never their staff); the ownership is the database's —
 * `isAgencyOwner` comes from comparing `agencies.owner_user_id` to this user.
 * Holding the role is not permission on its own, and an unreadable database
 * leaves the flag false, so this fails closed.
 */
export async function requireAgencyOwner(): Promise<AgencyOwner | null> {
  const session = await getDashboardSession();
  if (!session) return null;
  if (!canManageSubUsers(session.role)) return null;
  if (!session.isAgencyOwner || !session.agencyCode) return null;

  return { clerkId: session.clerkId, agencyCode: session.agencyCode };
}

/**
 * The target account, if it really is a sub user of this owner's agency.
 *
 * Membership is re-read from the database and the role from Clerk. Without
 * this, a B2B partner could POST any user id at these actions and reach an
 * account that is not theirs — a Super Admin, or another agency's staff.
 *
 * Self is excluded: a partner is not their own sub user.
 */
export async function ownedSubUser(actor: AgencyOwner, targetId: string) {
  if (!targetId || targetId === actor.clerkId) return null;

  if (!(await isAgencyMember(actor.agencyCode, targetId))) return null;

  const client = await clerkClient();
  const target = await client.users.getUser(targetId);
  if (resolveRole(target.publicMetadata?.role) !== SUB_USER_ROLE) return null;

  return target;
}

export type StaffAccess =
  | { ok: true; targetId: string; isSelf: boolean }
  | { ok: false; message: string };

const NO_STAFF_ACCESS: StaffAccess = {
  ok: false,
  message: 'You cannot change that staff record.',
};

/**
 * Whether the signed-in user may read or write a given staff record.
 *
 * Two ways in, and no third:
 *
 * - **the sub user themselves**, on their own record only. This is what keeps
 *   the standing rule intact — a sub user still cannot reach another sub
 *   user's anything, because the id has to equal their own.
 * - **the B2B admin**, on a sub user of their own agency, via `ownedSubUser()`.
 *
 * A B2B admin has no staff record of their own: they are not staff, so passing
 * their own id lands in neither branch and is refused.
 */
export async function requireStaffAccess(
  targetId: string
): Promise<StaffAccess> {
  const session = await getDashboardSession();
  if (!session || !targetId) return NO_STAFF_ACCESS;

  if (targetId === session.clerkId) {
    return session.role === SUB_USER_ROLE
      ? { ok: true, targetId, isSelf: true }
      : NO_STAFF_ACCESS;
  }

  const owner = await requireAgencyOwner();
  if (!owner) return NO_STAFF_ACCESS;
  if (!(await ownedSubUser(owner, targetId))) return NO_STAFF_ACCESS;

  return { ok: true, targetId, isSelf: false };
}
