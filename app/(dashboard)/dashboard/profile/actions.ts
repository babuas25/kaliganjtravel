'use server';

import { revalidatePath } from 'next/cache';

import {
  AGENCY_IDENTITY_FIELDS,
  canUploadBusinessDocs,
  FILE_FIELDS,
  isFileField,
  PERSISTED_FIELDS,
  sectionsFor,
  type ProfileField,
  type ProfileValues,
} from '@/lib/profile';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getProfile, saveProfile, setProfileDocument } from '@/lib/db/profiles';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import {
  discardDocuments,
  signDocuments,
  storeDocuments,
  type SignedDoc,
} from '@/lib/db/document-uploads';
import { FOLDERS } from '@/lib/cloudinary';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';

export type SaveProfileResult = { ok: boolean; message: string };

/**
 * Saves the signed-in user's own profile. The id comes from the session, never
 * from the payload — a server action is a public endpoint, so accepting a user
 * id from the caller would let anyone overwrite anyone.
 */
export async function saveProfileAction(
  values: Partial<ProfileValues>
): Promise<SaveProfileResult> {
  const session = await getDashboardSession();
  if (!session) {
    return { ok: false, message: 'Your session expired — sign in again.' };
  }

  const limit = await checkActionLimit('saveProfile', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  // Read before merging. saveProfile writes every persisted column, so a
  // failed/partial read must never become a write that blanks fields omitted by
  // this role's form. This stored snapshot is also the authority for the B2B
  // agency-identity lock below.
  const current = await getProfile(session.clerkId);
  if (!current.ok) {
    return {
      ok: false,
      message:
        'Your current profile could not be read, so nothing was saved. Try again.',
    };
  }

  const editable = new Set(
    sectionsFor(session.role)
      .flatMap((section) => section.fields)
      .map((field) => field.name)
      .filter((field) => !FILE_FIELDS.includes(field))
  );
  const clean: Partial<ProfileValues> = { ...current.values };
  for (const field of PERSISTED_FIELDS) {
    if (!editable.has(field)) continue;
    const value = values?.[field];
    if (typeof value === 'string') clean[field] = value;
  }

  // Each agency identity field can be supplied while it is blank. Once it has
  // a stored value, only saveUserProfile() in the manager-only Users & Roles
  // action may replace or clear it. Preserving from the fresh server read makes
  // this a backend rule rather than a disabled-input courtesy.
  const lockedAttempts: string[] = [];
  if (session.role === 'b2b' || session.role === 'b2b_sub') {
    for (const field of AGENCY_IDENTITY_FIELDS) {
      const stored = current.values[field].trim();
      const requested = clean[field]?.trim() ?? '';
      if (!stored || requested === stored) continue;
      clean[field] = current.values[field];
      lockedAttempts.push(field);
    }
  }

  const result = await saveProfile(session.clerkId, clean);
  if (result.ok) revalidatePath('/dashboard/profile');

  if (result.ok && lockedAttempts.length) {
    return {
      ok: true,
      message:
        'Profile saved. Agency Name and Agency Email can only be changed by Admin or Super Admin.',
    };
  }
  return result;
}

/* ── Business documents ────────────────────────────────────────────
 *
 * Uploaded one at a time from the Business Docs tab, separately from the text
 * form. Files cannot ride in `saveProfileAction`'s payload, and a document
 * should not wait on a Save that also rewrites every other field.
 *
 * Same rule as everything else that writes the caller's own record: the user id
 * comes from the session and never from the payload. The only thing the browser
 * supplies is *which* of their own documents this is, and that is checked
 * against `FILE_FIELDS` rather than trusted.
 */

export type DocumentActionResult =
  | { ok: true; message: string; docs: Record<string, SignedDoc> }
  | { ok: false; message: string };

const NOT_AN_AGENCY: DocumentActionResult = {
  ok: false,
  message: 'Only a B2B partner or their sub user keeps business documents.',
};

const DOCUMENT_AUDIT_UNAVAILABLE: DocumentActionResult = {
  ok: false,
  message: 'The security audit trail is unavailable, so no document was exposed or changed.',
};

async function auditDocument(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  field: string,
  outcome: 'attempted' | 'succeeded' | 'failed'
): Promise<boolean> {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'business_document',
    targetId: field,
    outcome,
  });
}

/** Signed links for a whole document map, keyed by field. */
function signMap(documents: Record<string, { publicId: string; format: string; uploadedAt: string }>) {
  const signed: Record<string, SignedDoc> = {};

  for (const field of FILE_FIELDS) {
    const doc = documents[field];
    if (!doc) continue;
    const [link] = signDocuments([doc], () => 'View');
    if (link) signed[field] = link;
  }
  return signed;
}

/**
 * The caller's own documents, re-signed.
 *
 * Links are short-lived by design, so a page left open outlives them. This is
 * what the form calls to get working ones back without a reload.
 */
export async function refreshBusinessDocuments(): Promise<DocumentActionResult> {
  const session = await getDashboardSession();
  if (!session) {
    return { ok: false, message: 'Your session expired — sign in again.' };
  }
  if (!canUploadBusinessDocs(session.role)) return NOT_AN_AGENCY;

  const profile = await getProfile(session.clerkId);
  if (!profile.ok) {
    return { ok: false, message: 'Your documents could not be loaded.' };
  }
  if (!(await auditDocument(session, 'document.links_refreshed', 'all', 'succeeded'))) {
    return DOCUMENT_AUDIT_UNAVAILABLE;
  }

  return { ok: true, message: '', docs: signMap(profile.documents) };
}

/** Narrows the field name the browser sent to one this form actually has. */
function documentField(value: unknown): ProfileField | null {
  return typeof value === 'string' && isFileField(value as ProfileField)
    ? (value as ProfileField)
    : null;
}

export async function uploadBusinessDocument(
  formData: FormData
): Promise<DocumentActionResult> {
  const session = await getDashboardSession();
  if (!session) {
    return { ok: false, message: 'Your session expired — sign in again.' };
  }
  // The tab is only rendered for agency roles, but a server action is a public
  // endpoint, so the role is re-checked where it binds.
  if (!canUploadBusinessDocs(session.role)) return NOT_AN_AGENCY;

  const limit = await checkActionLimit('businessDocument', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const field = documentField(formData.get('field'));
  if (!field) return { ok: false, message: 'That is not a document we keep.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a file first.' };
  }

  // Read first: it carries the document this one replaces, and a read that
  // failed must not become a write that overwrites what it could not see.
  const before = await getProfile(session.clerkId);
  if (!before.ok) {
    return {
      ok: false,
      message:
        'Your documents could not be loaded, so nothing was uploaded. Try again, and contact support if it keeps happening.',
    };
  }
  const replaced = before.documents[field];
  if (!(await auditDocument(session, 'document.uploaded', field, 'attempted'))) {
    return DOCUMENT_AUDIT_UNAVAILABLE;
  }

  const stored = await storeDocuments(
    [file],
    `${FOLDERS.businessDocs}/${session.clerkId}`
  );
  if (!stored.ok) {
    await auditDocument(session, 'document.uploaded', field, 'failed');
    return { ok: false, message: stored.message };
  }

  const written = await setProfileDocument(
    session.clerkId,
    field,
    stored.docs[0]
  );
  if (!written.ok) {
    await discardDocuments(stored.docs);
    await auditDocument(session, 'document.uploaded', field, 'failed');
    return {
      ok: false,
      message:
        'The document could not be saved. Nothing has changed — try again, and contact support if it keeps happening.',
    };
  }

  // Only once the new handle is stored, so a failed write never costs the
  // document that was already there.
  if (replaced) await discardDocuments([replaced]);
  await auditDocument(session, 'document.uploaded', field, 'succeeded');

  revalidatePath('/dashboard/profile');
  return {
    ok: true,
    message: 'Document uploaded.',
    docs: signMap(written.documents),
  };
}

export async function removeBusinessDocument(
  field: string
): Promise<DocumentActionResult> {
  const session = await getDashboardSession();
  if (!session) {
    return { ok: false, message: 'Your session expired — sign in again.' };
  }
  if (!canUploadBusinessDocs(session.role)) return NOT_AN_AGENCY;

  const limit = await checkActionLimit('businessDocument', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const name = documentField(field);
  if (!name) return { ok: false, message: 'That is not a document we keep.' };

  const before = await getProfile(session.clerkId);
  if (!before.ok) {
    return { ok: false, message: 'Your documents could not be loaded.' };
  }
  const existing = before.documents[name];
  if (!(await auditDocument(session, 'document.removed', name, 'attempted'))) {
    return DOCUMENT_AUDIT_UNAVAILABLE;
  }

  const written = await setProfileDocument(session.clerkId, name, null);
  if (!written.ok) {
    await auditDocument(session, 'document.removed', name, 'failed');
    return { ok: false, message: 'The document could not be removed.' };
  }

  // The row no longer points at it, so the asset goes. Best-effort: a failed
  // delete costs storage, and the document is already unreachable either way.
  if (existing) await discardDocuments([existing]);
  await auditDocument(session, 'document.removed', name, 'succeeded');

  revalidatePath('/dashboard/profile');
  return {
    ok: true,
    message: 'Document removed.',
    docs: signMap(written.documents),
  };
}
