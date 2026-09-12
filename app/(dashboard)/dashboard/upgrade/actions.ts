'use server';

import { revalidatePath } from 'next/cache';

import { FOLDERS } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  getUpgradeRequest,
  submitUpgradeRequest,
} from '@/lib/db/upgrade-requests';
import { discardDocuments, storeDocuments } from '@/lib/db/document-uploads';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { canRequestUpgrade } from '@/lib/roles';
import {
  coerceUpgradeValues,
  MAX_UPGRADE_DOCS,
  upgradeBlockedReason,
} from '@/lib/upgrade';

export type UpgradeActionResult = { ok: boolean; message: string };

const DENIED: UpgradeActionResult = {
  ok: false,
  message: 'Only a customer account can apply to become a B2B partner.',
};

/**
 * Submits this customer's application.
 *
 * **The user id comes from the session and never from the payload.** This is
 * the rule every action that writes the caller's own record follows, and it is
 * what makes the action safe without an ownership check: there is no target to
 * forge. The reviewing actions in Users & Roles are the ones that necessarily
 * take an id, and they have their own checks.
 *
 * `FormData` because the attachments are files.
 */
export async function submitUpgradeRequestAction(
  formData: FormData
): Promise<UpgradeActionResult> {
  const session = await getDashboardSession();
  if (!session) return DENIED;

  // The sidebar showing the button to customers is presentation. A server
  // action is a public endpoint that anyone signed in can POST to, so the role
  // is re-checked here, where it binds.
  if (!canRequestUpgrade(session.role)) return DENIED;

  const limit = await checkActionLimit(
    'submitUpgradeRequest',
    session.clerkId
  );
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  // Narrowed to the known fields, so an unexpected key in the payload can never
  // reach a column.
  const values = coerceUpgradeValues(
    Object.fromEntries(
      Array.from(formData.entries()).filter(
        ([, value]) => typeof value === 'string'
      )
    )
  );

  // The same check the form makes, repeated where it cannot be skipped.
  const blocked = upgradeBlockedReason(values);
  if (blocked) return { ok: false, message: blocked };

  // Read before writing: a pending application is not editable, an accepted one
  // is finished, and the row carries the attachments this submission replaces.
  // A failed read stops the submission — overwriting an application we could
  // not see is exactly the case worth refusing.
  const existing = await getUpgradeRequest(session.clerkId);
  if (!existing.ok) {
    return {
      ok: false,
      message:
        'Your application could not be loaded, so nothing was submitted. Try again, and contact support if it keeps happening.',
    };
  }

  const previous = existing.request;
  if (previous?.status === 'pending') {
    return {
      ok: false,
      message: 'Your application is already with our team for review.',
    };
  }
  if (previous?.status === 'accepted') {
    return {
      ok: false,
      message: 'This account has already been upgraded to a B2B partner.',
    };
  }

  const files = formData
    .getAll('docs')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length > MAX_UPGRADE_DOCS) {
    return {
      ok: false,
      message: `Attach at most ${MAX_UPGRADE_DOCS} documents.`,
    };
  }
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'upgrade.submitted',
    targetType: 'clerk_user',
    targetId: session.clerkId,
    metadata: { documentCount: files.length },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was submitted.',
    };
  }

  // Files go up before the row is written, so a failed upload leaves no
  // application claiming attachments that are not there. The reverse failure —
  // assets stored under a row that never lands — is cleaned up below.
  const stored = await storeDocuments(files, `${FOLDERS.upgradeDocs}/${session.clerkId}`);
  if (!stored.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return { ok: false, message: stored.message };
  }

  if (!(await submitUpgradeRequest(session.clerkId, values, stored.docs))) {
    await discardDocuments(stored.docs);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return {
      ok: false,
      message:
        'Your application could not be submitted. Nothing has been sent — try again, and contact support if it keeps happening.',
    };
  }

  // Only once the new row is safely stored. Doing this first would destroy the
  // previous attempt's evidence on the strength of a submission that might yet
  // fail.
  if (previous?.documents.length) {
    await discardDocuments(previous.documents);
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

  revalidatePath('/dashboard/upgrade');
  revalidatePath('/dashboard/users');
  return {
    ok: true,
    message:
      'Your application is with our team. You will see the outcome here once it has been reviewed.',
  };
}
