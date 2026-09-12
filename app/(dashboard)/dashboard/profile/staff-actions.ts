'use server';

import { revalidatePath } from 'next/cache';

import { getDashboardSession } from '@/lib/dashboard/session';
import { requireStaffAccess } from '@/lib/dashboard/sub-user-guard';
import { deleteStaffDetails, saveStaffDetails } from '@/lib/db/staff';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { coerceStaffValues } from '@/lib/staff';

export type StaffActionResult = { ok: boolean; message: string };

const PAGE = '/dashboard/profile';

/**
 * Staff records, written from the Company profile's Staff tab.
 *
 * Deliberately **not** part of `saveProfileAction`. That action takes the user
 * id from the session and never from the payload, which is what makes it safe;
 * a B2B admin editing someone else's record needs a target id in the payload,
 * so it gets its own action with its own ownership check rather than a
 * loosening of that rule.
 *
 * `requireStaffAccess()` is the gate, and it admits exactly two callers: the
 * sub user on their own record, and the B2B admin on a sub user of their own
 * agency. A sub user passing another sub user's id lands in neither branch.
 */

/** Guards shared by both writes: rate limit keyed to the actor, then access. */
async function authorise(targetId: string) {
  const session = await getDashboardSession();
  if (!session) {
    return { denied: { ok: false, message: 'You are not signed in.' } };
  }

  // Keyed to the actor, not the target, so one account cannot spend another's
  // allowance. Checked after identity but before the database work.
  const limit = await checkActionLimit('saveProfile', session.clerkId);
  if (!limit.ok) {
    return {
      denied: { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) },
    };
  }

  const access = await requireStaffAccess(targetId);
  if (!access.ok) return { denied: { ok: false, message: access.message } };

  return { denied: null, session };
}

async function auditStaffDetails(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  targetId: string,
  outcome: 'attempted' | 'succeeded' | 'failed'
) {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'staff_details',
    targetId,
    outcome,
  });
}

export async function saveStaffDetailsAction(
  targetId: string,
  values: unknown
): Promise<StaffActionResult> {
  const access = await authorise(targetId);
  if (access.denied || !access.session) return access.denied;
  if (!(await auditStaffDetails(access.session, 'staff.saved', targetId, 'attempted'))) {
    return { ok: false, message: 'The security audit trail is unavailable.' };
  }

  // The payload is a claim until narrowed to the known fields.
  const result = await saveStaffDetails(targetId, coerceStaffValues(values));
  await auditStaffDetails(
    access.session,
    'staff.saved',
    targetId,
    result.ok ? 'succeeded' : 'failed'
  );

  if (result.ok) revalidatePath(PAGE);
  return result;
}

/**
 * Clears someone's staff record.
 *
 * The account, the login and the travel profile are untouched — this removes
 * employment details only. Removing a person from the agency is the Sub Users
 * page, which is a different action with a different confirmation.
 */
export async function deleteStaffDetailsAction(
  targetId: string
): Promise<StaffActionResult> {
  const access = await authorise(targetId);
  if (access.denied || !access.session) return access.denied;
  if (!(await auditStaffDetails(access.session, 'staff.deleted', targetId, 'attempted'))) {
    return { ok: false, message: 'The security audit trail is unavailable.' };
  }

  const result = await deleteStaffDetails(targetId);
  await auditStaffDetails(
    access.session,
    'staff.deleted',
    targetId,
    result.ok ? 'succeeded' : 'failed'
  );

  if (result.ok) revalidatePath(PAGE);
  return result;
}
