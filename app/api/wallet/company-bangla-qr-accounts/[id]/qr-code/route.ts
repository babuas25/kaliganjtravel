import { z } from 'zod';

import { destroyAsset, isCloudinaryConfigured, uploadAsset } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { inspectLogoBytes, LOGO_EXTENSIONS, LOGO_MAX_BYTES } from '@/lib/upload-verify';
import {
  BANGLA_QR_UPLOAD_FOLDER,
  banglaQrAssetUrl,
  banglaQrPaymentAsset,
  type BanglaQrPaymentAsset,
} from '@/lib/wallet/bangla-qr';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type RouteContext = { params: Promise<{ id: string }> };

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table|wallet_company_bangla_qr/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'Bangla QR storage is not ready. Apply the Bangla QR database migration to enable uploads.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', 'The Bangla QR image could not be saved.');
}

export async function POST(request: Request, context: RouteContext) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(403, 'SUPERADMIN_REQUIRED', 'Only a Super Admin can upload Bangla QR images.');
  }
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BANGLA_QR_ACCOUNT', 'Invalid Bangla QR account.');
  }
  const { id } = parsed.data;
  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  if (!isCloudinaryConfigured()) {
    return walletFail(503, 'UPLOAD_UNAVAILABLE', 'QR image uploads are not configured on this environment.');
  }

  const contentLength = Number(request.headers.get('content-length')) || 0;
  if (contentLength > LOGO_MAX_BYTES + 128 * 1024) {
    return walletFail(413, 'ASSET_TOO_LARGE', 'The Bangla QR image is over 512 KB.');
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return walletFail(400, 'INVALID_BODY', 'Expected a Bangla QR image upload.');
  }
  const file = form.get('asset');
  if (!(file instanceof File) || file.size === 0) {
    return walletFail(400, 'ASSET_REQUIRED', 'Choose a Bangla QR image first.');
  }
  if (!LOGO_EXTENSIONS[file.type]) {
    return walletFail(400, 'INVALID_ASSET_TYPE', 'Use an SVG, PNG, WebP or JPEG QR image.');
  }
  if (file.size > LOGO_MAX_BYTES) {
    return walletFail(413, 'ASSET_TOO_LARGE', 'The Bangla QR image is over 512 KB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectLogoBytes(bytes, file.type);
  if (!inspection.ok) return walletFail(400, 'INVALID_ASSET', inspection.reason);

  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  const { data: account, error: accountError } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .select('id, qr_code, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message);
  if (!account) return walletFail(404, 'BANGLA_QR_ACCOUNT_NOT_FOUND', 'Bangla QR account not found.');

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bangla_qr_uploaded',
    targetType: 'payment_bangla_qr_account',
    targetId: id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'AUDIT_UNAVAILABLE', 'The security audit trail is unavailable, so nothing was changed.');
  }
  const stored = await uploadAsset(bytes, inspection.mime, { folder: BANGLA_QR_UPLOAD_FOLDER });
  if (!stored.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(400, 'ASSET_UPLOAD_FAILED', stored.message);
  }
  const asset: BanglaQrPaymentAsset = {
    publicId: stored.asset.publicId,
    version: stored.asset.version,
    format: stored.asset.format,
    uploadedAt: stored.asset.createdAt ?? new Date().toISOString(),
  };
  const { data: updated, error: updateError } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .update({ qr_code: asset })
    .eq('id', id)
    .eq('updated_at', account.updated_at)
    .select('id')
    .maybeSingle();

  if (updateError || !updated) {
    await destroyAsset(asset.publicId);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return updateError
      ? storageFailure(updateError.message)
      : walletFail(409, 'ACCOUNT_CHANGED', 'This Bangla QR account changed during the upload. Refresh and try again.');
  }
  const previous = banglaQrPaymentAsset(account.qr_code);
  if (previous && previous.publicId !== asset.publicId) await destroyAsset(previous.publicId);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ assetUrl: banglaQrAssetUrl(asset) });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(403, 'SUPERADMIN_REQUIRED', 'Only a Super Admin can remove Bangla QR images.');
  }
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BANGLA_QR_ACCOUNT', 'Invalid Bangla QR account.');
  }
  const { id } = parsed.data;
  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));

  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  const { data: account, error: accountError } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .select('id, qr_code, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message);
  if (!account) return walletFail(404, 'BANGLA_QR_ACCOUNT_NOT_FOUND', 'Bangla QR account not found.');

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bangla_qr_removed',
    targetType: 'payment_bangla_qr_account',
    targetId: id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'AUDIT_UNAVAILABLE', 'The security audit trail is unavailable, so nothing was changed.');
  }
  const { data: updated, error } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    // An account without instructions must stop accepting new payment requests.
    .update({ qr_code: null, active: false })
    .eq('id', id)
    .eq('updated_at', account.updated_at)
    .select('id')
    .maybeSingle();
  if (error || !updated) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return error
      ? storageFailure(error.message)
      : walletFail(409, 'ACCOUNT_CHANGED', 'This Bangla QR account changed. Refresh and try again.');
  }
  const previous = banglaQrPaymentAsset(account.qr_code);
  if (previous) await destroyAsset(previous.publicId);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ removed: true });
}
