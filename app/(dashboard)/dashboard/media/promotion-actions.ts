'use server';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { revalidatePath } from 'next/cache';
import { getDashboardSession } from '@/lib/dashboard/session';
import { canManageMedia } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';
import { promotionSchema } from '@/lib/promotional-popup';
import { FOLDERS, uploadAsset } from '@/lib/cloudinary';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { recordSecurityAuditEvent } from '@/lib/db/security';

export async function savePromotionAction(input: unknown, expectedVersion: number) {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return { ok: false, message: 'Media management access is required.' };
  const limit = await checkActionLimit('manageHomepageOffers', session.clerkId);
  if (!limit.ok) return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  const parsed = promotionSchema.safeParse(input);
  if (!parsed.success || !Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, message: parsed.error?.issues[0]?.message ?? 'Reload this page before saving.' };
  const db = supabaseAdmin();
  if (!db) return { ok: false, message: 'Storage is unavailable.' };
  const audit = { actorUserId: session.clerkId, actorRole: session.role, action: 'media.promotion_saved', targetType: 'promotional_popup', targetId: 'primary' };
  if (!await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' })) return { ok: false, message: 'The audit service is unavailable. Try again.' };
  const { data, error } = await db.from('promotional_popup_settings').update({ enabled: parsed.data.enabled, slides: parsed.data.slides, display_settings: parsed.data.display, auto_close_seconds: parsed.data.autoCloseSeconds, version: expectedVersion + 1, updated_at: new Date().toISOString(), updated_by: session.clerkId }).eq('id', 'primary').eq('version', expectedVersion).select('version').maybeSingle();
  await recordSecurityAuditEvent({ ...audit, outcome: error || !data ? 'failed' : 'succeeded' });
  if (error || !data) return { ok: false, message: error ? 'The popup could not be saved.' : 'Another editor changed the popup. Reload before saving.' };
  revalidatePath('/dashboard/media');
  revalidatePath('/dashboard/announcements', 'layout');
  return { ok: true, message: 'Promotional popup saved.', version: data.version as number };
}

export async function uploadPromotionAction(form: FormData) {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return { ok: false, message: 'Media management access is required.' };
  const limit = await checkActionLimit('manageHomepageOffers', session.clerkId);
  if (!limit.ok) return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0 || file.size > 2 * 1024 * 1024) return { ok: false, message: 'Choose a JPG, PNG or WebP image up to 2 MB.' };
  try {
    const source = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 24000000 });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) return { ok: false, message: 'Use a static JPG, PNG or WebP image.' };
    const bytes = await source.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    const assetId = `promotion-${randomUUID()}`;
    const audit = { actorUserId: session.clerkId, actorRole: session.role, action: 'media.promotion_image_uploaded', targetType: 'promotional_popup', targetId: assetId };
    if (!await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' })) return { ok: false, message: 'The audit service is unavailable. Try again.' };
    const stored = await uploadAsset(bytes, 'image/webp', { folder: FOLDERS.marketing, publicId: assetId });
    await recordSecurityAuditEvent({ ...audit, outcome: stored.ok ? 'succeeded' : 'failed' });
    return stored.ok ? { ok: true, message: 'Image uploaded. Save to publish your changes.', url: stored.asset.url } : { ok: false, message: stored.message };
  } catch { return { ok: false, message: 'This image could not be processed. Try another file.' }; }
}
