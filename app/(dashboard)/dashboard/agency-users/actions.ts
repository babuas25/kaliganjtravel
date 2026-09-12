'use server';

import { revalidatePath } from 'next/cache';
import { clerkClient } from '@clerk/nextjs/server';

import { accountActiveMetadata } from '@/lib/account-access';
import { invitationRedirectUrl } from '@/lib/app-url';
import { revokeActiveUserSessions } from '@/lib/clerk-sessions';
import { forgetUser } from '@/lib/db/users';
import { sendInvitationEmail } from '@/lib/email/notifications';
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from '@/lib/db/security';
import {
  ownedSubUser,
  requireAgencyOwner,
} from '@/lib/dashboard/sub-user-guard';
import {
  checkActionLimit,
  rateLimitMessage,
  type LimitName,
} from '@/lib/rate-limit';
import { ROLE_LABELS, SUB_USER_ROLE } from '@/lib/roles';

export type SubUserActionResult = { ok: boolean; message: string };

const PAGE = '/dashboard/agency-users';

const DENIED: SubUserActionResult = {
  ok: false,
  message: 'You do not have permission to manage sub users.',
};

const NOT_YOURS: SubUserActionResult = {
  ok: false,
  message: 'That account is not a sub user of your agency.',
};

const AUDIT_UNAVAILABLE: SubUserActionResult = {
  ok: false,
  message: 'The security audit trail is unavailable, so nothing was changed.',
};

async function auditAgencyAction(
  actor: { clerkId: string; agencyCode: string },
  action: string,
  targetType: string,
  targetId: string,
  outcome: 'attempted' | 'succeeded' | 'failed',
  metadata: Record<string, unknown> = {}
): Promise<boolean> {
  return recordSecurityAuditEvent({
    actorUserId: actor.clerkId,
    actorRole: 'b2b',
    action,
    targetType,
    targetId,
    outcome,
    metadata: { agencyCode: actor.agencyCode, ...metadata },
  });
}

async function throttled(
  name: LimitName,
  clerkId: string
): Promise<SubUserActionResult | null> {
  const limit = await checkActionLimit(name, clerkId);
  return limit.ok
    ? null
    : { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
}

/** Matches the Users & Roles handling: Clerk's short wording, or our fallback. */
const MAX_CLERK_MESSAGE = 200;

function clerkMessage(error: unknown, fallback: string): string {
  const first = (
    error as { errors?: { code?: string; message?: string }[] } | null
  )?.errors?.[0];

  console.error(
    '[clerk] sub-user action failed:',
    first?.code ?? 'unknown',
    first?.message ?? String(error)
  );

  const message = first?.message;
  if (!message || message.length > MAX_CLERK_MESSAGE) return fallback;
  return message;
}

/**
 * Invites a sub user into the caller's own agency.
 *
 * **Takes only an email.** The role is fixed at `b2b_sub` and the agency comes
 * from the session, so there is no role to escalate and no agency to redirect
 * — the two things a forged payload would otherwise reach for. A B2B partner
 * never chooses an agency because there is only one possible answer.
 */
export async function inviteSubUser(
  email: string
): Promise<SubUserActionResult> {
  const actor = await requireAgencyOwner();
  if (!actor) return DENIED;

  const limited = await throttled('inviteSubUser', actor.clerkId);
  if (limited) return limited;

  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  const auditTarget = securitySubjectHash(address);
  let createdInvitationId: string | null = null;
  let sendingEmail = false;

  try {
    const client = await clerkClient();
    if (
      !(await auditAgencyAction(
        actor,
        'agency.invitation_created',
        'email_hash',
        auditTarget,
        'attempted'
      ))
    ) {
      return AUDIT_UNAVAILABLE;
    }
    const invitation = await client.invitations.createInvitation({
      emailAddress: address,
      publicMetadata: { role: SUB_USER_ROLE, agencyCode: actor.agencyCode },
      redirectUrl: invitationRedirectUrl(),
      notify: false,
    });
    createdInvitationId = invitation.id;
    if (!invitation.url) {
      throw new Error('Clerk did not return an invitation acceptance URL.');
    }
    sendingEmail = true;
    await sendInvitationEmail({
      to: address,
      invitationId: invitation.id,
      roleLabel: ROLE_LABELS[SUB_USER_ROLE],
    });
    await auditAgencyAction(
      actor,
      'agency.invitation_created',
      'clerk_invitation',
      invitation.id,
      'succeeded'
    );

    revalidatePath(PAGE);
    return { ok: true, message: `Invitation sent to ${address}.` };
  } catch (error) {
    if (createdInvitationId) {
      try {
        const client = await clerkClient();
        await client.invitations.revokeInvitation(createdInvitationId);
      } catch (cleanupError) {
        console.error(
          '[email] failed to revoke undelivered sub-user invitation:',
          createdInvitationId,
          cleanupError
        );
      }
    }
    await auditAgencyAction(
      actor,
      'agency.invitation_created',
      'email_hash',
      auditTarget,
      'failed'
    );
    return {
      ok: false,
      message: sendingEmail
        ? 'The invitation email could not be delivered. Try again shortly.'
        : clerkMessage(error, 'Could not send that invitation.'),
    };
  }
}

/**
 * Revokes a pending invitation this agency sent.
 *
 * The id is re-checked against the invitation's own metadata before anything
 * happens: pending invitations are listed application-wide, so without this a
 * partner holding an id could revoke an admin's invitation, or another
 * agency's.
 */
export async function revokeSubUserInvite(
  invitationId: string
): Promise<SubUserActionResult> {
  const actor = await requireAgencyOwner();
  if (!actor) return DENIED;

  const limited = await throttled('manageSubUser', actor.clerkId);
  if (limited) return limited;

  try {
    const client = await clerkClient();
    const { data } = await client.invitations.getInvitationList({
      status: 'pending',
      limit: 100,
    });

    const invite = data.find((row) => row.id === invitationId);
    const metadata = invite?.publicMetadata as { agencyCode?: unknown } | null;
    if (!invite || metadata?.agencyCode !== actor.agencyCode) {
      return { ok: false, message: 'That invitation is not yours to revoke.' };
    }
    if (
      !(await auditAgencyAction(
        actor,
        'agency.invitation_revoked',
        'clerk_invitation',
        invitationId,
        'attempted'
      ))
    ) {
      return AUDIT_UNAVAILABLE;
    }

    await client.invitations.revokeInvitation(invitationId);
    await auditAgencyAction(
      actor,
      'agency.invitation_revoked',
      'clerk_invitation',
      invitationId,
      'succeeded'
    );

    revalidatePath(PAGE);
    return { ok: true, message: 'Invitation revoked.' };
  } catch (error) {
    await auditAgencyAction(
      actor,
      'agency.invitation_revoked',
      'clerk_invitation',
      invitationId,
      'failed'
    );
    return {
      ok: false,
      message: clerkMessage(error, 'Could not revoke that invitation.'),
    };
  }
}

/**
 * Turns a sub user's access off or back on.
 *
 * The application access flag is permanent until changed again, unlike Clerk's
 * temporary lockout. The shared session gate denies disabled accounts and
 * active sessions are revoked when possible, without depending on Clerk's
 * paid-plan ban feature.
 */
export async function setSubUserAccess(
  clerkId: string,
  disabled: boolean
): Promise<SubUserActionResult> {
  const actor = await requireAgencyOwner();
  if (!actor) return DENIED;

  const limited = await throttled('manageSubUser', actor.clerkId);
  if (limited) return limited;

  try {
    const target = await ownedSubUser(actor, clerkId);
    if (!target) return NOT_YOURS;
    if (
      !(await auditAgencyAction(
        actor,
        'agency.user_access_changed',
        'clerk_user',
        clerkId,
        'attempted',
        { disabled }
      ))
    ) {
      return AUDIT_UNAVAILABLE;
    }

    const client = await clerkClient();
    await client.users.updateUserMetadata(clerkId, {
      publicMetadata: accountActiveMetadata(!disabled),
    });

    let sessionsRevoked = true;
    if (disabled) {
      try {
        await revokeActiveUserSessions(client, clerkId);
      } catch (sessionError) {
        sessionsRevoked = false;
        console.error(
          '[clerk] failed to revoke disabled sub-user sessions:',
          clerkId,
          sessionError
        );
      }
    }
    await auditAgencyAction(
      actor,
      'agency.user_access_changed',
      'clerk_user',
      clerkId,
      'succeeded',
      { disabled }
    );

    revalidatePath(PAGE);
    return {
      ok: true,
      message: disabled
        ? sessionsRevoked
          ? 'Sub user disabled and signed out. They can no longer access the dashboard.'
          : 'Sub user disabled. Dashboard access is blocked; any existing session will be denied on its next request.'
        : 'Sub user enabled.',
    };
  } catch (error) {
    await auditAgencyAction(
      actor,
      'agency.user_access_changed',
      'clerk_user',
      clerkId,
      'failed',
      { disabled }
    );
    return {
      ok: false,
      message: clerkMessage(error, 'Could not change that account.'),
    };
  }
}

/** Longest a name may be. Clerk's own limit is higher; this is a sanity bound. */
const MAX_NAME = 60;

/**
 * Renames a sub user.
 *
 * Name only. The email is their sign-in identity and belongs to Clerk's own
 * account flows, and the role is fixed — so a partner correcting a typo has
 * exactly one thing to change here.
 */
export async function renameSubUser(
  clerkId: string,
  firstName: string,
  lastName: string
): Promise<SubUserActionResult> {
  const actor = await requireAgencyOwner();
  if (!actor) return DENIED;

  const limited = await throttled('manageSubUser', actor.clerkId);
  if (limited) return limited;

  const first = firstName.trim();
  const last = lastName.trim();

  if (!first && !last) {
    return { ok: false, message: 'Enter a first or last name.' };
  }
  if (first.length > MAX_NAME || last.length > MAX_NAME) {
    return { ok: false, message: 'That name is too long.' };
  }

  try {
    const target = await ownedSubUser(actor, clerkId);
    if (!target) return NOT_YOURS;
    if (
      !(await auditAgencyAction(
        actor,
        'agency.user_renamed',
        'clerk_user',
        clerkId,
        'attempted'
      ))
    ) {
      return AUDIT_UNAVAILABLE;
    }

    const client = await clerkClient();
    await client.users.updateUser(clerkId, {
      firstName: first,
      lastName: last,
    });
    await auditAgencyAction(
      actor,
      'agency.user_renamed',
      'clerk_user',
      clerkId,
      'succeeded'
    );

    revalidatePath(PAGE);
    return { ok: true, message: 'Name updated.' };
  } catch (error) {
    await auditAgencyAction(
      actor,
      'agency.user_renamed',
      'clerk_user',
      clerkId,
      'failed'
    );
    return {
      ok: false,
      message: clerkMessage(error, 'Could not update that name.'),
    };
  }
}

/**
 * Deletes a sub user's account for good.
 *
 * The profile row cascades off `app_users`, so `forgetUser()` clears both. The
 * agency itself is untouched — this removes a person, not the company.
 */
export async function removeSubUser(
  clerkId: string
): Promise<SubUserActionResult> {
  const actor = await requireAgencyOwner();
  if (!actor) return DENIED;

  const limited = await throttled('manageSubUser', actor.clerkId);
  if (limited) return limited;

  try {
    const target = await ownedSubUser(actor, clerkId);
    if (!target) return NOT_YOURS;
    if (
      !(await auditAgencyAction(
        actor,
        'agency.user_removed',
        'clerk_user',
        clerkId,
        'attempted'
      ))
    ) {
      return AUDIT_UNAVAILABLE;
    }

    const client = await clerkClient();
    await client.users.deleteUser(clerkId);
    await forgetUser(clerkId);
    await auditAgencyAction(
      actor,
      'agency.user_removed',
      'clerk_user',
      clerkId,
      'succeeded'
    );

    revalidatePath(PAGE);
    return { ok: true, message: 'Sub user removed.' };
  } catch (error) {
    await auditAgencyAction(
      actor,
      'agency.user_removed',
      'clerk_user',
      clerkId,
      'failed'
    );
    return {
      ok: false,
      message: clerkMessage(error, 'Could not remove that account.'),
    };
  }
}
