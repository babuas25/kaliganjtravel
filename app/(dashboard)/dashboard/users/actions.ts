'use server';

import { revalidatePath } from 'next/cache';
import { clerkClient } from '@clerk/nextjs/server';

import { accountActiveMetadata, isUserActive } from '@/lib/account-access';
import { invitationRedirectUrl } from '@/lib/app-url';
import { revokeActiveUserSessions } from '@/lib/clerk-sessions';
import { getDashboardSession } from '@/lib/dashboard/session';
import { forgetUser, mirrorUserRole } from '@/lib/db/users';
import {
  sendAccountCreatedEmail,
  sendInvitationEmail,
  sendRoleChangedEmail,
} from '@/lib/email/notifications';
import {
  acquireSecurityLock,
  recordSecurityAuditEvent,
  releaseSecurityLock,
  securitySubjectHash,
} from '@/lib/db/security';
import { agencyExists, agencyProfileOwnerFor } from '@/lib/db/agencies';
import { getProfile, saveProfile, setProfileDocument } from '@/lib/db/profiles';
import {
  FILE_FIELDS,
  PERSISTED_FIELDS,
  sectionsFor,
  type ProfileValues,
} from '@/lib/profile';
import {
  getUpgradeRequest,
  recordUpgradeDecision,
} from '@/lib/db/upgrade-requests';
import {
  discardDocuments,
  signDocuments,
  type SignedDoc,
} from '@/lib/db/document-uploads';
import { FOLDERS, uploadAsset } from '@/lib/cloudinary';
import {
  inspectLogoBytes,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';
import { MAX_UPGRADE_LENGTH, type UpgradeValues } from '@/lib/upgrade';
import {
  checkActionLimit,
  rateLimitMessage,
  type LimitName,
} from '@/lib/rate-limit';
import {
  assignableRoles,
  canManageUsers,
  canManageUserProfile,
  resolveRole,
  roleRequiresAgency,
  ROLES,
  ROLE_LABELS,
  userActionBlockedReason,
  userDeleteBlockedReason,
  type Role,
} from '@/lib/roles';

export type UserActionResult = { ok: boolean; message: string };

/**
 * The actor's remaining allowance for an action, as a refusal or null when
 * they are within it. Checked after the permission rules, so being turned
 * away never costs anyone else their allowance.
 */
async function throttled(
  name: LimitName,
  clerkId: string
): Promise<UserActionResult | null> {
  const limit = await checkActionLimit(name, clerkId);
  return limit.ok
    ? null
    : { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
}

/**
 * Every action here re-derives the actor from the session and re-checks the
 * rules. The table hiding a control is presentation; a server action is a
 * public endpoint that anyone signed in can POST to.
 */
async function requireManager() {
  const session = await getDashboardSession();
  if (!session || !canManageUsers(session.role)) return null;
  return session;
}

/**
 * Anything longer than this is not the short user-facing string Clerk
 * documents `message` to be, so it is treated as unexpected and withheld.
 */
const MAX_CLERK_MESSAGE = 200;

/**
 * Clerk's own wording for a failure, or our fallback.
 *
 * `errors[0].message` is deliberately passed through: it is the short,
 * user-facing string Clerk's own components render — "That email address is
 * taken" — and replacing it with something generic would cost real feedback
 * without concealing anything of ours. Clerk's `longMessage`, `meta` and
 * trace id are not surfaced, and an unrecognisably long message falls back.
 *
 * Every failure is logged either way. Without this an unexpected Clerk error
 * reached the user and left nothing behind for whoever had to diagnose it.
 */
function clerkMessage(error: unknown, fallback: string): string {
  const first = (
    error as { errors?: { code?: string; message?: string }[] } | null
  )?.errors?.[0];

  console.error(
    '[clerk] action failed:',
    first?.code ?? 'unknown',
    first?.message ?? String(error)
  );

  const message = first?.message;
  if (!message || message.length > MAX_CLERK_MESSAGE) return fallback;

  return message;
}

const DENIED: UserActionResult = {
  ok: false,
  message: 'You do not have permission to manage users.',
};

const NEEDS_AGENCY: UserActionResult = {
  ok: false,
  message:
    'Choose the agency this sub user belongs to. A Sub User account cannot exist without one.',
};

const LAST_SUPERADMIN: UserActionResult = {
  ok: false,
  message:
    'The last Super Admin cannot be removed. The system must always have at least one Super Admin.',
};

const SECURITY_BUSY: UserActionResult = {
  ok: false,
  message: 'Another account security change is in progress. Try again shortly.',
};

const AUDIT_UNAVAILABLE: UserActionResult = {
  ok: false,
  message: 'The security audit trail is unavailable, so nothing was changed.',
};

/** Clerk's page cap for a user list request. */
const SCAN_PAGE = 100;

/**
 * Whether any account *other than* this one holds superadmin **and can still
 * sign in**.
 *
 * Clerk cannot filter a user list by public metadata, so this walks the roster
 * and stops at the first match — the answer needed is "is there another one",
 * not "how many". The full walk only happens when the answer is no, which is
 * exactly the case worth paying for.
 *
 * Deactivated accounts do not count. Leaving an inactive Super Admin in the
 * tally would let the last usable one be demoted, deleted or deactivated on
 * the strength of somebody who is already locked out.
 */
async function anotherSuperAdminExists(exceptClerkId: string) {
  const client = await clerkClient();

  for (let offset = 0; ; offset += SCAN_PAGE) {
    const { data, totalCount } = await client.users.getUserList({
      limit: SCAN_PAGE,
      offset,
      orderBy: '-created_at',
    });

    if (!data.length) return false;

    const found = data.some(
      (user) =>
        user.id !== exceptClerkId &&
        isUserActive(user) &&
        resolveRole(user.publicMetadata?.role) === 'superadmin'
    );
    if (found) return true;

    if (offset + data.length >= totalCount) return false;
  }
}

/**
 * The one invariant that outranks the permission rules: the application must
 * keep at least one Super Admin, or nobody can ever grant the role again and
 * the install is locked out of its own admin surface.
 *
 * Checked on the way into every write, not in the UI, so it holds for a direct
 * POST to the action as much as for a click in the table.
 */
async function wouldStrandInstall(target: { clerkId: string; role: Role }) {
  if (target.role !== 'superadmin') return false;
  return !(await anotherSuperAdminExists(target.clerkId));
}

/**
 * Reads the target's role from Clerk rather than trusting what the browser
 * sent — otherwise a forged payload could claim a Super Admin is a customer
 * and slip past the admin restriction.
 */
async function loadTarget(clerkId: string) {
  const client = await clerkClient();
  const user = await client.users.getUser(clerkId);
  return { clerkId: user.id, role: resolveRole(user.publicMetadata?.role) };
}

/**
 * Grants a role, and for `b2b_sub` the agency it is granted *at*.
 *
 * `agencyCode` is required for that role and ignored for every other — a
 * customer does not carry a stale agency around because they were briefly a
 * sub user.
 */
export async function setUserRole(
  clerkId: string,
  nextRole: Role,
  agencyCode: string | null = null
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('setUserRole', actor.clerkId);
  if (limited) return limited;

  if (!assignableRoles(actor.role).includes(nextRole)) {
    return { ok: false, message: `You cannot assign the ${nextRole} role.` };
  }

  // The invariant: a sub user is staff *of* an agency, so the grant carries
  // one or does not happen. `agencyExists` answers false for a malformed code,
  // an unknown one, and a database that could not be asked — none of which is
  // evidence the agency is real.
  const needsAgency = roleRequiresAgency(nextRole);
  if (needsAgency && !(await agencyExists(agencyCode))) return NEEDS_AGENCY;
  const nextAgency = needsAgency ? agencyCode : null;
  const identityLock = await acquireSecurityLock('clerk-user-role-authority');
  if (!identityLock) return SECURITY_BUSY;

  try {
    const target = await loadTarget(clerkId);

    const blocked = userActionBlockedReason(actor, target);
    if (blocked) return { ok: false, message: blocked };

    // Only a shortcut for roles with nothing else to carry. Re-picking Sub User
    // for someone who already holds it is how their agency gets corrected, so
    // it has to write through.
    if (target.role === nextRole && !needsAgency) {
      return { ok: true, message: 'That is already their role.' };
    }

    // Demoting the only Super Admin leaves nobody able to grant the role back.
    if (nextRole !== 'superadmin' && (await wouldStrandInstall(target))) {
      return LAST_SUPERADMIN;
    }

    const audit = {
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'user.role_changed',
      targetType: 'clerk_user',
      targetId: clerkId,
      metadata: {
        previousRole: target.role,
        nextRole,
        agencyCode: nextAgency,
      },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return AUDIT_UNAVAILABLE;
    }

    // The database write goes first, and this order is deliberate. Clerk
    // decides the role, so writing it first would mean a failure here left
    // someone holding `b2b_sub` with no agency — the exact state the check
    // above exists to prevent. Failing the other way is inert: the role never
    // changes, and a stray agency link on someone who is not a sub user is
    // read by nothing. `recordUserVisit()` corrects the mirrored role on their
    // next visit either way.
    if (!(await mirrorUserRole(clerkId, nextRole, nextAgency))) {
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
      return {
        ok: false,
        message:
          'The change could not be recorded, so nothing was applied. Try again, and contact support if it keeps happening.',
      };
    }

    const client = await clerkClient();
    const updatedUser = await client.users.updateUserMetadata(clerkId, {
      // Written as a mirror for the invitation path to read. Explicitly null
      // rather than omitted: updateUserMetadata merges, so leaving it out
      // would strand the previous agency on the record.
      publicMetadata: { role: nextRole, agencyCode: nextAgency },
    });
    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

    let notified = true;
    if (target.role !== nextRole) {
      try {
        const recipient = updatedUser.primaryEmailAddress?.emailAddress;
        if (!recipient) throw new Error('The promoted account has no primary email.');
        await sendRoleChangedEmail({
          to: recipient,
          firstName: updatedUser.firstName || '',
          previousRoleLabel: ROLE_LABELS[target.role],
          nextRoleLabel: ROLE_LABELS[nextRole],
        });
      } catch (error) {
        notified = false;
        console.error('[email] role-change notice failed:', clerkId, error);
      }
    }

    revalidatePath('/dashboard/users');
    const roleChanged = target.role !== nextRole;
    return {
      ok: true,
      message: roleChanged
        ? `Role updated.${notified ? '' : ' The confirmation email could not be delivered.'}`
        : 'Agency updated.',
    };
  } catch (error) {
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'user.role_changed',
      targetType: 'clerk_user',
      targetId: clerkId,
      outcome: 'failed',
      metadata: { nextRole },
    });
    return { ok: false, message: clerkMessage(error, 'Could not update role.') };
  } finally {
    await releaseSecurityLock(identityLock);
  }
}

/**
 * Turns an account off, or back on.
 *
 * Deactivating records the app's access flag in Clerk metadata and ends the
 * account's active sessions. Everything they own stays — bookings, wallet,
 * profile — which is the whole point of having this next to the delete rather
 * than instead of it. The shared session gate rejects inactive accounts, so
 * this works even on Clerk plans that do not include the ban API.
 *
 * Same permission line as a role change, and for the same reasons: you cannot
 * switch off the account you are signed in with, and an Admin does not switch
 * off a Super Admin. Deactivating the last usable Super Admin is refused by the
 * install-wide invariant, exactly as demoting or deleting them is.
 */
export async function setUserActive(
  clerkId: string,
  active: boolean
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('setUserActive', actor.clerkId);
  if (limited) return limited;

  // The same lease the role writes take. Without it two admins could each see
  // the other's Super Admin as proof that deactivating theirs is safe.
  const identityLock = await acquireSecurityLock('clerk-user-role-authority');
  if (!identityLock) return SECURITY_BUSY;

  try {
    const target = await loadTarget(clerkId);

    const blocked = userActionBlockedReason(actor, target);
    if (blocked) return { ok: false, message: blocked };

    if (!active && (await wouldStrandInstall(target))) return LAST_SUPERADMIN;

    const audit = {
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: active ? 'user.activated' : 'user.deactivated',
      targetType: 'clerk_user',
      targetId: clerkId,
      metadata: { targetRole: target.role },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return AUDIT_UNAVAILABLE;
    }

    const client = await clerkClient();
    await client.users.updateUserMetadata(clerkId, {
      publicMetadata: accountActiveMetadata(active),
    });

    // Access is already denied by the metadata gate above. Revoking existing
    // sessions makes the change immediate too, but a transient sessions API
    // failure must not undo a successfully persisted deactivation.
    let sessionsRevoked = true;
    if (!active) {
      try {
        await revokeActiveUserSessions(client, clerkId);
      } catch (sessionError) {
        sessionsRevoked = false;
        console.error(
          '[clerk] failed to revoke deactivated user sessions:',
          clerkId,
          sessionError
        );
      }
    }

    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
    revalidatePath('/dashboard/users');

    return {
      ok: true,
      message: active
        ? 'Account activated. They can sign in again.'
        : sessionsRevoked
          ? 'Account deactivated and signed out. They can no longer access the dashboard.'
          : 'Account deactivated. Dashboard access is blocked; any existing session will be denied on its next request.',
    };
  } catch (error) {
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: active ? 'user.activated' : 'user.deactivated',
      targetType: 'clerk_user',
      targetId: clerkId,
      outcome: 'failed',
    });
    return {
      ok: false,
      message: clerkMessage(error, 'Could not change that account’s status.'),
    };
  } finally {
    await releaseSecurityLock(identityLock);
  }
}

export async function deleteUserAccount(
  clerkId: string
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('deleteUserAccount', actor.clerkId);
  if (limited) return limited;
  const identityLock = await acquireSecurityLock('clerk-user-role-authority');
  if (!identityLock) return SECURITY_BUSY;

  try {
    const target = await loadTarget(clerkId);

    // Stricter than the role change above: an Admin never reaches this.
    const blocked = userDeleteBlockedReason(actor, target);
    if (blocked) return { ok: false, message: blocked };

    // Same invariant as a demotion: deleting the account removes the role.
    if (await wouldStrandInstall(target)) return LAST_SUPERADMIN;

    const audit = {
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'user.deleted',
      targetType: 'clerk_user',
      targetId: clerkId,
      metadata: { previousRole: target.role },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return AUDIT_UNAVAILABLE;
    }

    const client = await clerkClient();
    await client.users.deleteUser(clerkId);
    // The profile row cascades off app_users, so this clears both.
    await forgetUser(clerkId);
    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

    revalidatePath('/dashboard/users');
    return { ok: true, message: 'Account deleted.' };
  } catch (error) {
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'user.deleted',
      targetType: 'clerk_user',
      targetId: clerkId,
      outcome: 'failed',
    });
    return {
      ok: false,
      message: clerkMessage(error, 'Could not delete that account.'),
    };
  } finally {
    await releaseSecurityLock(identityLock);
  }
}

/** Rejects an address the Clerk call would only reject more slowly. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates an account outright, with a password the admin sets.
 *
 * The other way in is `inviteUser()` below, and it remains the better one:
 * the person sets their own password and no admin ever handles someone else's
 * credentials. This exists for the cases an invitation cannot serve — signing
 * an agency up at a desk, or an address that cannot receive our mail — and it
 * carries the cost that goes with it: whoever creates the account knows the
 * password until the owner changes it.
 *
 * Clerk's own password policy applies, breached-password check included.
 * `skipPasswordChecks` is deliberately never set.
 */
export async function createUserAccount(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
  agencyCode?: string | null;
}): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  // Same allowance as an invitation: both mint an account from nothing.
  const limited = await throttled('createUserAccount', actor.clerkId);
  if (limited) return limited;

  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();

  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  if (!firstName) {
    return { ok: false, message: 'Enter a first name.' };
  }
  // Clerk's floor. Its full policy is checked server-side by Clerk itself, and
  // its refusal is what the admin sees — this only saves an obvious round trip.
  if (input.password.length < 8) {
    return {
      ok: false,
      message: 'The password must be at least 8 characters.',
    };
  }
  if (!assignableRoles(actor.role).includes(input.role)) {
    return { ok: false, message: `You cannot assign the ${input.role} role.` };
  }

  // Same invariant as every other grant: a sub user is staff *of* an agency,
  // so the account carries one or is not created.
  const needsAgency = roleRequiresAgency(input.role);
  const agencyCode = needsAgency ? (input.agencyCode ?? null) : null;
  if (needsAgency && !(await agencyExists(agencyCode))) return NEEDS_AGENCY;

  const audit = {
    actorUserId: actor.clerkId,
    actorRole: actor.role,
    action: 'user.created',
    metadata: { role: input.role, agencyCode },
  } as const;
  // No account yet, so the subject is the hashed address — the same stand-in
  // `inviteUser()` uses before an invitation exists.
  if (
    !(await recordSecurityAuditEvent({
      ...audit,
      targetType: 'email_hash',
      targetId: securitySubjectHash(email),
      outcome: 'attempted',
    }))
  ) {
    return AUDIT_UNAVAILABLE;
  }

  let clerkId: string;
  try {
    const client = await clerkClient();
    const created = await client.users.createUser({
      emailAddress: [email],
      password: input.password,
      firstName,
      lastName: lastName || undefined,
      // Written at creation so a sub user's agency is already on the record
      // before they ever sign in — `resolveAgency()` reads it as the seed for
      // the stored link, after checking it against the agencies table.
      publicMetadata: { role: input.role, agencyCode },
      // The user.created webhook handles public sign-ups and accepted
      // invitations. Direct admin creation has its own account-ready email.
      privateMetadata: { provisioningSource: 'admin' },
    });
    clerkId = created.id;
  } catch (error) {
    await recordSecurityAuditEvent({
      ...audit,
      targetType: 'email_hash',
      targetId: securitySubjectHash(email),
      outcome: 'failed',
    });
    return {
      ok: false,
      message: clerkMessage(error, 'Could not create that account.'),
    };
  }

  await recordSecurityAuditEvent({
    ...audit,
    targetType: 'clerk_user',
    targetId: clerkId,
    outcome: 'succeeded',
  });
  revalidatePath('/dashboard/users');

  // A failed mirror is reported rather than treated as a failed creation: the
  // account exists and is usable, the role and agency are on the Clerk record,
  // and `recordUserVisit()` writes the row on their first visit. Saying the
  // creation failed would be false, and inviting a retry that can only collide
  // with the address just taken.
  const mirrored = await mirrorUserRole(clerkId, input.role, agencyCode);
  let notified = true;
  try {
    await sendAccountCreatedEmail({ to: email, firstName });
  } catch (error) {
    notified = false;
    console.error('[email] account-created notice failed:', clerkId, error);
  }

  const notes = [
    `Account created for ${email}. Give them the password yourself — it is not emailed.`,
  ];
  if (!notified) {
    notes.push('The account email could not be delivered.');
  }
  if (!mirrored) {
    notes.push(
      'The directory record could not be written; it fills in when they first sign in.'
    );
  }
  return { ok: true, message: notes.join(' ') };
}

/**
 * Invitations rather than admin-created passwords: Clerk emails the person a
 * link, they set their own credentials, and the role travels in the
 * invitation's metadata so it is already attached when they sign up.
 */
export async function inviteUser(
  email: string,
  role: Role,
  agencyCode: string | null = null
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  // Tightest of the limits: this is the only action that sends mail to an
  // address of the caller's choosing.
  const limited = await throttled('inviteUser', actor.clerkId);
  if (limited) return limited;

  const address = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(address)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  if (!assignableRoles(actor.role).includes(role)) {
    return { ok: false, message: `You cannot assign the ${role} role.` };
  }

  // Same invariant as a direct grant, applied before the mail goes out: an
  // invitation that would create an agency-less sub user is never sent.
  const needsAgency = roleRequiresAgency(role);
  if (needsAgency && !(await agencyExists(agencyCode))) return NEEDS_AGENCY;
  const inviteAgency = needsAgency ? agencyCode : null;
  const auditTarget = securitySubjectHash(address);
  let createdInvitationId: string | null = null;
  let sendingEmail = false;

  try {
    const client = await clerkClient();
    if (
      !(await recordSecurityAuditEvent({
        actorUserId: actor.clerkId,
        actorRole: actor.role,
        action: 'invitation.created',
        targetType: 'email_hash',
        targetId: auditTarget,
        outcome: 'attempted',
        metadata: { role, agencyCode: inviteAgency },
      }))
    ) {
      return AUDIT_UNAVAILABLE;
    }
    const invitation = await client.invitations.createInvitation({
      emailAddress: address,
      // The invitee has no account and therefore no database row, so the
      // agency has to travel with the invitation. It lands on their
      // publicMetadata at sign-up, and `resolveAgency()` turns it into the
      // stored link on their first dashboard load — after checking it against
      // the agencies table, because by then it has been outside our control.
      publicMetadata: { role, agencyCode: inviteAgency },
      redirectUrl: invitationRedirectUrl(),
      // Clerk creates and validates the ticket; Zoho delivers our branded mail.
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
      roleLabel: ROLE_LABELS[role],
    });
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'invitation.created',
      targetType: 'clerk_invitation',
      targetId: invitation.id,
      outcome: 'succeeded',
      metadata: { role, agencyCode: inviteAgency },
    });

    revalidatePath('/dashboard/users');
    return { ok: true, message: `Invitation sent to ${address}.` };
  } catch (error) {
    // Do not leave an undiscoverable active ticket behind after its email
    // failed. This also makes an immediate retry possible for the same address.
    if (createdInvitationId) {
      try {
        const client = await clerkClient();
        await client.invitations.revokeInvitation(createdInvitationId);
      } catch (cleanupError) {
        console.error(
          '[email] failed to revoke undelivered invitation:',
          createdInvitationId,
          cleanupError
        );
      }
    }
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'invitation.created',
      targetType: 'email_hash',
      targetId: auditTarget,
      outcome: 'failed',
      metadata: { role, agencyCode: inviteAgency },
    });
    return {
      ok: false,
      message: sendingEmail
        ? 'The invitation email could not be delivered. Try again shortly.'
        : clerkMessage(error, 'Could not send that invitation.'),
    };
  }
}

/* ── Upgrade requests ──────────────────────────────────────────────
 *
 * A customer applies from the sidebar's "Upgrade to Business" button; the
 * roster shows "Waiting for upgrade" beside them, and these two actions are
 * what the reviewing admin's dialog calls.
 *
 * The applicant's id arrives from the browser, which is unavoidable — the admin
 * is acting on somebody else's record. It supplies an id and nothing else:
 * the actor comes from the session, the target's role is re-read from Clerk,
 * and the application itself is re-read from Postgres. See "Every write
 * re-derives ownership" in projectmap.md.
 */

export type UpgradeDetail = {
  clerkId: string;
  values: UpgradeValues;
  /** Short-lived signed links, minted for this view only. */
  docs: SignedDoc[];
  /** Epoch ms the application was submitted. */
  createdAt: number;
};

export type UpgradeDetailResult =
  | { ok: true; detail: UpgradeDetail }
  | { ok: false; message: string };

/**
 * The full application behind a "Waiting for upgrade" badge, for the review
 * dialog.
 *
 * Fetched on demand rather than shipped with the roster. An admin opens Users &
 * Roles to do all sorts of things, and putting every pending applicant's home
 * address into that page's HTML is not one of them — still less a live signed
 * link to their NID card, which is what pre-signing every row would mean.
 */
export async function loadUpgradeRequest(
  clerkId: string
): Promise<UpgradeDetailResult> {
  const actor = await requireManager();
  if (!actor) return { ok: false, message: DENIED.message };

  const limited = await throttled('reviewUpgradeRequest', actor.clerkId);
  if (limited) return { ok: false, message: limited.message };

  const read = await getUpgradeRequest(clerkId);
  if (!read.ok) {
    return {
      ok: false,
      message:
        'The application could not be loaded. Try again, and contact support if it keeps happening.',
    };
  }
  if (!read.request || read.request.status !== 'pending') {
    return {
      ok: false,
      message: 'There is no application waiting for this account.',
    };
  }
  if (
    !(await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'upgrade.documents_viewed',
      targetType: 'clerk_user',
      targetId: clerkId,
      outcome: 'succeeded',
    }))
  ) {
    return { ok: false, message: AUDIT_UNAVAILABLE.message };
  }

  return {
    ok: true,
    detail: {
      clerkId,
      values: read.request.values,
      docs: signDocuments(read.request.documents),
      createdAt: read.request.createdAt,
    },
  };
}

/**
 * Accepts or rejects an application.
 *
 * **Accepting is a role change and nothing more exotic than one.** It grants
 * `b2b` through the same `mirrorUserRole()` + Clerk pair that `setUserRole()`
 * uses, so the agency is minted by `resolveAgency()` on the partner's next
 * dashboard load exactly as it is for a role set by hand. This action does not
 * touch the agencies table.
 *
 * The verdict is written **before** the role, and reverted if the role does not
 * follow. The other order looks safer and is not: a role granted against a row
 * still marked pending leaves the applicant a B2B partner with an application
 * apparently still under review, and an admin looking at a badge for a decision
 * that has already taken effect.
 */
export async function decideUpgradeRequest(
  clerkId: string,
  decision: 'accept' | 'reject',
  note: string = ''
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('reviewUpgradeRequest', actor.clerkId);
  if (limited) return limited;

  const reason = note.trim().slice(0, MAX_UPGRADE_LENGTH);
  const audit = {
    actorUserId: actor.clerkId,
    actorRole: actor.role,
    action: 'upgrade.reviewed',
    targetType: 'clerk_user',
    targetId: clerkId,
    metadata: { decision },
  } as const;

  try {
    const target = await loadTarget(clerkId);

    const blocked = userActionBlockedReason(actor, target);
    if (blocked) return { ok: false, message: blocked };

    // Anything but a customer means the application has been overtaken —
    // another admin granted a role by hand, or accepted this same request.
    // Upgrading a sub user or a staff account is not what this button means.
    if (target.role !== 'customer') {
      return {
        ok: false,
        message: `This account is no longer a customer, so the application no longer applies. It is a ${ROLE_LABELS[target.role]}.`,
      };
    }
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return AUDIT_UNAVAILABLE;
    }

    if (decision === 'reject') {
      const done = await recordUpgradeDecision(
        clerkId,
        'rejected',
        actor.clerkId,
        reason || null,
        'pending'
      );
      if (!done) {
        await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
        return {
          ok: false,
          message:
            'The application could not be updated — it may have been decided already. Refresh and check.',
        };
      }

      await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
      revalidatePath('/dashboard/users');
      return { ok: true, message: 'Application rejected.' };
    }

    if (!assignableRoles(actor.role).includes('b2b')) {
      return { ok: false, message: 'You cannot assign the b2b role.' };
    }

    // Guarded on the row still being pending, so two admins with the dialog
    // open cannot both grant the role: the second write matches no row.
    const claimed = await recordUpgradeDecision(
      clerkId,
      'accepted',
      actor.clerkId,
      reason || null,
      'pending'
    );
    if (!claimed) {
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
      return {
        ok: false,
        message:
          'The application could not be updated — it may have been decided already. Refresh and check.',
      };
    }

    // `null` agency: a partner owns theirs rather than joining one, and
    // `resolveAgency()` creates it on their next dashboard load.
    if (!(await mirrorUserRole(clerkId, 'b2b', null))) {
      await recordUpgradeDecision(clerkId, 'pending', null, null, 'accepted');
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
      return {
        ok: false,
        message:
          'The upgrade could not be recorded, so nothing was applied. Try again, and contact support if it keeps happening.',
      };
    }

    const client = await clerkClient();
    const updatedUser = await client.users.updateUserMetadata(clerkId, {
      publicMetadata: { role: 'b2b', agencyCode: null },
    });
    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

    let notified = true;
    try {
      const recipient = updatedUser.primaryEmailAddress?.emailAddress;
      if (!recipient) throw new Error('The upgraded account has no primary email.');
      await sendRoleChangedEmail({
        to: recipient,
        firstName: updatedUser.firstName || '',
        previousRoleLabel: ROLE_LABELS.customer,
        nextRoleLabel: ROLE_LABELS.b2b,
      });
    } catch (error) {
      notified = false;
      console.error('[email] role-change notice failed:', clerkId, error);
    }

    revalidatePath('/dashboard/users');
    return {
      ok: true,
      message:
        `Upgraded to B2B Partner. Their agency code is generated on their next dashboard visit.${notified ? '' : ' The confirmation email could not be delivered.'}`,
    };
  } catch (error) {
    // The Clerk write is the only throw that can land here after the verdict
    // was stored, so putting the row back is what keeps the two in step. The
    // mirrored role corrects itself on the applicant's next visit either way.
    await recordUpgradeDecision(clerkId, 'pending', null, null, 'accepted');
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return {
      ok: false,
      message: clerkMessage(error, 'Could not review that application.'),
    };
  }
}

/* ── Account details ───────────────────────────────────────────────
 *
 * The "View Details" button on each roster row. It shows what the account owner
 * filled in on their own Profile page and lets managers correct permitted
 * fields; sensitive business documents remain read-only, apart from the shared
 * agency logo.
 */

export type ProfileDetail = {
  clerkId: string;
  /** The target's role, which decides the sections the dialog renders. */
  role: Role;
  name: string;
  email: string;
  /** Their agency (`ST-B2B######`), or null for everyone outside one. */
  agencyCode: string | null;
  values: ProfileValues;
  /** Short-lived signed links to the business documents, keyed by field. */
  docs: Record<string, SignedDoc>;
};

export type ProfileDetailResult =
  | { ok: true; detail: ProfileDetail }
  | { ok: false; message: string };

/**
 * One account's stored profile, for the roster's details dialog.
 *
 * Fetched on demand rather than shipped with the roster, for the same reason
 * the upgrade application is: this is a page of passport numbers, home
 * addresses and bank accounts, and an admin opens Users & Roles to change a
 * role. None of it belongs in that page's HTML until somebody asks for it.
 *
 * A failed read is reported rather than rendered as blanks — an admin reading
 * "—" against Passport No. would take it as "not provided", which is a
 * different fact from "we could not ask".
 */
export async function loadUserProfile(
  clerkId: string
): Promise<ProfileDetailResult> {
  const actor = await requireManager();
  if (!actor) return { ok: false, message: DENIED.message };

  const limited = await throttled('viewUserProfile', actor.clerkId);
  if (limited) return { ok: false, message: limited.message };

  // Clerk's answer, not the browser's: a forged id paired with a claimed role
  // must not talk its way past the seniority line below. It throws on an id
  // Clerk does not know, which a deleted account in a stale tab produces.
  let user;
  try {
    const client = await clerkClient();
    user = await client.users.getUser(clerkId);
  } catch (error) {
    return {
      ok: false,
      message: clerkMessage(error, 'That account could not be loaded.'),
    };
  }
  const role = resolveRole(user.publicMetadata?.role);

  if (!canManageUserProfile(actor.role, role)) {
    return {
      ok: false,
      message: `Only a Super Admin can view a ${ROLE_LABELS[role]}'s details.`,
    };
  }

  const profile = await getProfile(clerkId);
  if (!profile.ok) {
    return {
      ok: false,
      message:
        'These details could not be read just now. Nothing has been changed — try again, and contact support if it keeps happening.',
    };
  }

  let agencyCode: string | null = null;
  let documents = profile.documents;

  // An agency's logo is shared branding and lives on its owner's profile. A
  // sub user's dialog therefore reads that canonical logo while keeping the
  // sub user's personal documents and details on their own row.
  if (role === 'b2b' || role === 'b2b_sub') {
    const agency = await agencyProfileOwnerFor(clerkId);
    if (!agency.ok) {
      return {
        ok: false,
        message:
          'This agency could not be resolved just now. Nothing has been changed — try again.',
      };
    }
    agencyCode = agency.agencyCode;

    if (agency.ownerUserId && agency.ownerUserId !== clerkId) {
      const ownerProfile = await getProfile(agency.ownerUserId);
      if (!ownerProfile.ok) {
        return {
          ok: false,
          message:
            'This agency logo could not be read just now. Nothing has been changed — try again.',
        };
      }
      documents = { ...profile.documents };
      if (ownerProfile.documents.logo) {
        documents.logo = ownerProfile.documents.logo;
      } else {
        delete documents.logo;
      }
    }
  }

  // Signed here rather than in the browser, and only for the documents that
  // exist. They expire in minutes, which is the point.
  const docs: Record<string, SignedDoc> = {};
  for (const field of FILE_FIELDS) {
    const stored = documents[field];
    if (!stored) continue;
    const [link] = signDocuments([stored], () => 'Open');
    if (link) docs[field] = link;
  }

  if (
    !(await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'user.profile_viewed',
      targetType: 'clerk_user',
      targetId: clerkId,
      outcome: 'succeeded',
      metadata: { targetRole: role },
    }))
  ) {
    return { ok: false, message: AUDIT_UNAVAILABLE.message };
  }

  return {
    ok: true,
    detail: {
      clerkId,
      role,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.username ||
        '—',
      email: user.emailAddresses[0]?.emailAddress ?? '—',
      agencyCode,
      values: profile.values,
      docs,
    },
  };
}

/**
 * Saves an admin's corrections to somebody else's profile.
 *
 * Two things keep this from being a hole. The **fields** are filtered to those
 * the target's own form would show — `sectionsFor(their role)` minus the
 * uploads — so a payload naming a column outside that set changes nothing,
 * whatever the browser sent. And the values are **merged over a fresh read**
 * rather than written wholesale: `saveProfile()` writes every persisted column
 * at once, so a dialog that renders a customer's four sections must not blank
 * the columns it never showed.
 *
 * File fields are deliberately excluded from this general save. Sensitive
 * business documents stay with the account owner; the separately authorized
 * agency-logo actions below are the one narrow exception.
 */
export async function saveUserProfile(
  clerkId: string,
  values: Partial<ProfileValues>
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('editUserProfile', actor.clerkId);
  if (limited) return limited;

  let role: Role;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    role = resolveRole(user.publicMetadata?.role);
  } catch (error) {
    return {
      ok: false,
      message: clerkMessage(error, 'That account could not be loaded.'),
    };
  }

  if (!canManageUserProfile(actor.role, role)) {
    return {
      ok: false,
      message: `Only a Super Admin can edit a ${ROLE_LABELS[role]}'s details.`,
    };
  }

  const current = await getProfile(clerkId);
  if (!current.ok) {
    return {
      ok: false,
      message:
        'Their current details could not be read, so nothing was saved — a partial write would have blanked the rest. Try again.',
    };
  }

  const editable = new Set(
    sectionsFor(role)
      .flatMap((section) => section.fields)
      .map((spec) => spec.name)
      .filter((field) => !FILE_FIELDS.includes(field))
  );

  const merged: ProfileValues = { ...current.values };
  const changed: string[] = [];
  for (const field of PERSISTED_FIELDS) {
    if (!editable.has(field)) continue;
    // Only fields the payload actually carries. Reading a missing one as ''
    // would let a partial save blank every field it happened not to mention —
    // clearing a value has to be an explicit empty string.
    const raw = values[field];
    if (typeof raw !== 'string') continue;
    const next = raw.trim();
    if (next === merged[field]) continue;
    merged[field] = next;
    // Field names only. What an admin typed into somebody's passport line is
    // not something to copy into the audit table.
    changed.push(field);
  }

  if (!changed.length) return { ok: true, message: 'No changes to save.' };

  const audit = {
    actorUserId: actor.clerkId,
    actorRole: actor.role,
    action: 'user.profile_updated',
    targetType: 'clerk_user',
    targetId: clerkId,
    metadata: { targetRole: role, fields: changed },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return AUDIT_UNAVAILABLE;
  }

  const saved = await saveProfile(clerkId, merged);
  if (!saved.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return saved;
  }

  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  revalidatePath('/dashboard/users');
  return { ok: true, message: 'Details saved.' };
}

export type AgencyLogoActionResult = {
  ok: boolean;
  message: string;
  doc?: SignedDoc | null;
};

type ManagedAgencyLogoTarget =
  | {
      ok: true;
      role: 'b2b' | 'b2b_sub';
      agencyCode: string | null;
      ownerUserId: string;
    }
  | { ok: false; message: string };

/**
 * Re-reads the target and agency for every logo mutation. The browser supplies
 * only an account id; it cannot promote a non-agency account into an eligible
 * target or choose which profile row owns the agency's shared branding.
 */
async function managedAgencyLogoTarget(
  actorRole: Role,
  clerkId: string
): Promise<ManagedAgencyLogoTarget> {
  let role: Role;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    role = resolveRole(user.publicMetadata?.role);
  } catch (error) {
    return {
      ok: false,
      message: clerkMessage(error, 'That account could not be loaded.'),
    };
  }

  if (!canManageUserProfile(actorRole, role)) {
    return {
      ok: false,
      message: `Only a Super Admin can edit a ${ROLE_LABELS[role]}'s details.`,
    };
  }
  if (role !== 'b2b' && role !== 'b2b_sub') {
    return { ok: false, message: 'Only a B2B agency can have an agency logo.' };
  }

  const agency = await agencyProfileOwnerFor(clerkId);
  if (!agency.ok) {
    return {
      ok: false,
      message: 'This agency could not be resolved, so its logo was not changed.',
    };
  }
  // A newly promoted B2B partner may not have visited their dashboard yet, so
  // resolveAgency() has not created the agency row. Their own profile is still
  // the future agency-owner profile and is safe to update now. A sub user has
  // no such fallback: without membership there is no reliable owner to write.
  if (!agency.agencyCode || !agency.ownerUserId) {
    if (role === 'b2b') {
      return {
        ok: true,
        role,
        agencyCode: null,
        ownerUserId: clerkId,
      };
    }
    return {
      ok: false,
      message:
        'This B2B account is not attached to an agency yet, so its logo cannot be changed.',
    };
  }

  return {
    ok: true,
    role,
    agencyCode: agency.agencyCode,
    ownerUserId: agency.ownerUserId,
  };
}

/** Super Admin/Admin replacement of one agency's shared logo. */
export async function uploadUserAgencyLogo(
  formData: FormData
): Promise<AgencyLogoActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('editUserProfile', actor.clerkId);
  if (limited) return limited;

  const clerkId = formData.get('clerkId');
  if (typeof clerkId !== 'string' || !clerkId) {
    return { ok: false, message: 'Choose a B2B user first.' };
  }
  const target = await managedAgencyLogoTarget(actor.role, clerkId);
  if (!target.ok) return target;

  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image file first.' };
  }
  if (!LOGO_EXTENSIONS[file.type]) {
    return { ok: false, message: 'Use an SVG, PNG, WebP or JPEG file.' };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, message: 'That file is over the 512 KB limit.' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectLogoBytes(bytes, file.type);
  if (!inspection.ok) return { ok: false, message: inspection.reason };

  const before = await getProfile(target.ownerUserId);
  if (!before.ok) {
    return {
      ok: false,
      message:
        'The current agency logo could not be read, so nothing was uploaded. Try again.',
    };
  }
  const replaced = before.documents.logo;
  const audit = {
    actorUserId: actor.clerkId,
    actorRole: actor.role,
    action: 'user.agency_logo_uploaded',
    targetType: target.agencyCode ? 'agency' : 'clerk_user',
    targetId: target.agencyCode ?? clerkId,
    metadata: {
      targetUserId: clerkId,
      ownerUserId: target.ownerUserId,
      targetRole: target.role,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return AUDIT_UNAVAILABLE;
  }

  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: `${FOLDERS.businessDocs}/${target.ownerUserId}`,
    authenticated: true,
  });
  if (!stored.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return { ok: false, message: stored.message };
  }

  const next = {
    publicId: stored.asset.publicId,
    format: stored.asset.format,
    uploadedAt: stored.asset.createdAt ?? new Date().toISOString(),
  };
  const written = await setProfileDocument(target.ownerUserId, 'logo', next);
  if (!written.ok) {
    await discardDocuments([next]);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return {
      ok: false,
      message:
        'The agency logo could not be saved. Nothing has changed — try again.',
    };
  }

  if (replaced) await discardDocuments([replaced]);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  revalidatePath('/dashboard/users');
  revalidatePath('/dashboard/bookings');

  const [doc] = signDocuments([next], () => 'View logo');
  return {
    ok: true,
    message: 'Agency logo updated.',
    doc: doc ?? null,
  };
}

/** Super Admin/Admin removal of one agency's shared logo. */
export async function removeUserAgencyLogo(
  clerkId: string
): Promise<AgencyLogoActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('editUserProfile', actor.clerkId);
  if (limited) return limited;

  const target = await managedAgencyLogoTarget(actor.role, clerkId);
  if (!target.ok) return target;

  const before = await getProfile(target.ownerUserId);
  if (!before.ok) {
    return { ok: false, message: 'The current agency logo could not be read.' };
  }
  const existing = before.documents.logo;
  const audit = {
    actorUserId: actor.clerkId,
    actorRole: actor.role,
    action: 'user.agency_logo_removed',
    targetType: target.agencyCode ? 'agency' : 'clerk_user',
    targetId: target.agencyCode ?? clerkId,
    metadata: {
      targetUserId: clerkId,
      ownerUserId: target.ownerUserId,
      targetRole: target.role,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return AUDIT_UNAVAILABLE;
  }

  const written = await setProfileDocument(target.ownerUserId, 'logo', null);
  if (!written.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return { ok: false, message: 'The agency logo could not be removed.' };
  }

  if (existing) await discardDocuments([existing]);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  revalidatePath('/dashboard/users');
  revalidatePath('/dashboard/bookings');
  return { ok: true, message: 'Agency logo removed.', doc: null };
}

export async function revokeInvite(
  invitationId: string
): Promise<UserActionResult> {
  const actor = await requireManager();
  if (!actor) return DENIED;

  const limited = await throttled('revokeInvite', actor.clerkId);
  if (limited) return limited;

  try {
    const client = await clerkClient();
    let invitation: Awaited<
      ReturnType<typeof client.invitations.revokeInvitation>
    > | null = null;
    for (let offset = 0; ; offset += SCAN_PAGE) {
      const { data, totalCount } = await client.invitations.getInvitationList({
        status: 'pending',
        limit: SCAN_PAGE,
        offset,
      });
      invitation = data.find((row) => row.id === invitationId) ?? null;
      if (invitation || offset + data.length >= totalCount || data.length === 0) {
        break;
      }
    }
    if (!invitation) {
      return { ok: false, message: 'That pending invitation was not found.' };
    }

    const rawRole = (invitation.publicMetadata as { role?: unknown } | null)?.role;
    const invitedRole =
      typeof rawRole === 'string' && ROLES.includes(rawRole as Role)
        ? (rawRole as Role)
        : null;
    if (!invitedRole || !assignableRoles(actor.role).includes(invitedRole)) {
      return {
        ok: false,
        message:
          actor.role === 'admin'
            ? 'Only a Super Admin can revoke that invitation.'
            : 'That invitation has invalid role metadata and was not changed.',
      };
    }
    const audit = {
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'invitation.revoked',
      targetType: 'clerk_invitation',
      targetId: invitationId,
      metadata: { invitedRole },
    } as const;
    if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
      return AUDIT_UNAVAILABLE;
    }
    await client.invitations.revokeInvitation(invitationId);
    await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

    revalidatePath('/dashboard/users');
    return { ok: true, message: 'Invitation revoked.' };
  } catch (error) {
    await recordSecurityAuditEvent({
      actorUserId: actor.clerkId,
      actorRole: actor.role,
      action: 'invitation.revoked',
      targetType: 'clerk_invitation',
      targetId: invitationId,
      outcome: 'failed',
    });
    return {
      ok: false,
      message: clerkMessage(error, 'Could not revoke that invitation.'),
    };
  }
}
