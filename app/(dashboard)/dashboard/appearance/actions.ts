'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { LOGO_PUBLIC_ID, SITE_LOGO_CACHE_TAG } from '@/lib/appearance';
import {
  destroyAsset,
  FOLDERS,
  isCloudinaryConfigured,
  uploadAsset,
} from '@/lib/cloudinary';
import {
  inspectLogoBytes,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';

export type AppearanceResult = { ok: boolean; message: string };

const SUPERADMIN_ONLY: AppearanceResult = {
  ok: false,
  message: 'Only a Super Admin can change the logo.',
};

const UNCONFIGURED: AppearanceResult = {
  ok: false,
  message: 'Cloudinary is not configured on this environment.',
};

const AUDIT_UNAVAILABLE: AppearanceResult = {
  ok: false,
  message: 'The security audit trail is unavailable, so nothing was changed.',
};

async function auditLogo(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  outcome: 'attempted' | 'succeeded' | 'failed'
): Promise<boolean> {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'site_logo',
    targetId: LOGO_PUBLIC_ID,
    outcome,
  });
}

/**
 * Server actions are public endpoints — the sidebar hiding Appearance from
 * other roles is presentation, not access control, so every action re-checks
 * the role here.
 *
 * Returns the session rather than a bare pass/fail because the rate limit is
 * keyed on who the actor is.
 */
async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

/** The logo shows in the header, sidebar, auth pages and favicon — all of it. */
function revalidateBranding() {
  updateTag(SITE_LOGO_CACHE_TAG);
  revalidatePath('/', 'layout');
}

export async function uploadSiteLogo(
  formData: FormData
): Promise<AppearanceResult> {
  const session = await requireSuperadmin();
  if (!session) return SUPERADMIN_ONLY;

  const limit = await checkActionLimit('siteLogo', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  if (!isCloudinaryConfigured()) return UNCONFIGURED;

  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image file first.' };
  }

  // The browser already checked both, but a server action can be called
  // directly, so the limits are enforced where they actually bind.
  if (!LOGO_EXTENSIONS[file.type]) {
    return { ok: false, message: 'Use an SVG, PNG, WebP or JPEG file.' };
  }
  // Checked before the file is read into memory, so an oversized upload is
  // rejected rather than buffered.
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, message: 'That file is over the 512 KB limit.' };
  }

  // `file.type` is a claim made by the browser. Check it against the bytes, and
  // store under the type that was *verified* rather than the one asserted.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectLogoBytes(bytes, file.type);
  if (!inspection.ok) return { ok: false, message: inspection.reason };
  if (!(await auditLogo(session, 'appearance.logo_uploaded', 'attempted'))) {
    return AUDIT_UNAVAILABLE;
  }

  // A fixed public id, so this replaces rather than accumulates — no folder to
  // clear first, and no window in which two logos exist and something has to
  // choose. `uploadAsset` passes `overwrite` and `invalidate` for exactly this.
  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: FOLDERS.site,
    publicId: 'logo',
  });
  if (!stored.ok) {
    await auditLogo(session, 'appearance.logo_uploaded', 'failed');
    return { ok: false, message: stored.message };
  }
  await auditLogo(session, 'appearance.logo_uploaded', 'succeeded');

  revalidateBranding();
  return { ok: true, message: 'Logo updated.' };
}

export async function removeSiteLogo(): Promise<AppearanceResult> {
  const session = await requireSuperadmin();
  if (!session) return SUPERADMIN_ONLY;

  const limit = await checkActionLimit('siteLogo', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  if (!isCloudinaryConfigured()) return UNCONFIGURED;
  if (!(await auditLogo(session, 'appearance.logo_removed', 'attempted'))) {
    return AUDIT_UNAVAILABLE;
  }

  await destroyAsset(LOGO_PUBLIC_ID);
  await auditLogo(session, 'appearance.logo_removed', 'succeeded');

  revalidateBranding();
  return { ok: true, message: 'Logo removed — the default mark is back.' };
}
