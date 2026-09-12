import { z } from 'zod';

import {
  destroyAsset,
  FOLDERS,
  publicUrl,
  uploadAsset,
} from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import {
  inspectLogoBytes,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['logo', 'qr-code']),
});

type AssetKind = z.infer<typeof paramsSchema>['kind'];
type PaymentAsset = {
  publicId: string;
  version: number;
  format: string;
  uploadedAt: string;
};

const assetConfig: Record<
  AssetKind,
  { column: 'logo' | 'qr_code'; label: string; folder: string }
> = {
  logo: { column: 'logo', label: 'MFS logo', folder: FOLDERS.mfsLogos },
  'qr-code': {
    column: 'qr_code',
    label: 'MFS QR code',
    folder: FOLDERS.mfsQrCodes,
  },
};

function paymentAsset(value: unknown): PaymentAsset | null {
  if (!value || typeof value !== 'object') return null;
  const asset = value as Partial<PaymentAsset>;
  if (
    typeof asset.publicId !== 'string' ||
    typeof asset.version !== 'number' ||
    typeof asset.format !== 'string'
  ) {
    return null;
  }
  return {
    publicId: asset.publicId,
    version: asset.version,
    format: asset.format,
    uploadedAt: typeof asset.uploadedAt === 'string' ? asset.uploadedAt : '',
  };
}

async function routeParams(context: {
  params: Promise<{ id: string; kind: string }>;
}) {
  return paramsSchema.safeParse(await context.params);
}

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

function storageFailure(message: string, label: string) {
  if (/schema cache|could not find the table|wallet_company_mfs/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'MFS asset storage is not ready. Apply migration 0023 to enable uploads.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', `${label} could not be saved.`);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; kind: string }> }
) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can upload MFS payment assets.'
    );
  }

  const parsed = await routeParams(context);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_MFS_ASSET', 'Invalid MFS account or asset type.');
  }
  const { id, kind } = parsed.data;
  const config = assetConfig[kind];

  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  const contentLength = Number(request.headers.get('content-length')) || 0;
  if (contentLength > LOGO_MAX_BYTES + 128 * 1024) {
    return walletFail(413, 'ASSET_TOO_LARGE', `${config.label} is over 512 KB.`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return walletFail(400, 'INVALID_BODY', `Expected a ${config.label} upload.`);
  }

  const file = form.get('asset');
  if (!(file instanceof File) || file.size === 0) {
    return walletFail(400, 'ASSET_REQUIRED', `Choose a ${config.label} first.`);
  }
  if (!LOGO_EXTENSIONS[file.type]) {
    return walletFail(
      400,
      'INVALID_ASSET_TYPE',
      `Use an SVG, PNG, WebP or JPEG ${config.label}.`
    );
  }
  if (file.size > LOGO_MAX_BYTES) {
    return walletFail(413, 'ASSET_TOO_LARGE', `${config.label} is over 512 KB.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectLogoBytes(bytes, file.type);
  if (!inspection.ok) {
    return walletFail(400, 'INVALID_ASSET', inspection.reason);
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data: account, error: accountError } = await supabase
    .from('wallet_company_mfs_accounts')
    .select(`id, ${config.column}`)
    .eq('id', id)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message, config.label);
  if (!account) {
    return walletFail(404, 'MFS_ACCOUNT_NOT_FOUND', 'MFS account not found.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `wallet.payment_mfs_${kind.replace('-', '_')}_uploaded`,
    targetType: 'payment_mfs_account',
    targetId: id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: config.folder,
  });
  if (!stored.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(400, 'ASSET_UPLOAD_FAILED', stored.message);
  }

  const asset: PaymentAsset = {
    publicId: stored.asset.publicId,
    version: stored.asset.version,
    format: stored.asset.format,
    uploadedAt: stored.asset.createdAt ?? new Date().toISOString(),
  };
  const { error: updateError } = await supabase
    .from('wallet_company_mfs_accounts')
    .update({ [config.column]: asset })
    .eq('id', id);

  if (updateError) {
    await destroyAsset(stored.asset.publicId);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return storageFailure(updateError.message, config.label);
  }

  const previous = paymentAsset(
    (account as Record<string, unknown>)[config.column]
  );
  if (previous && previous.publicId !== asset.publicId) {
    await destroyAsset(previous.publicId);
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

  return walletOk({
    assetUrl: publicUrl(asset.publicId, asset.version) ?? stored.asset.url,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; kind: string }> }
) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can remove MFS payment assets.'
    );
  }

  const parsed = await routeParams(context);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_MFS_ASSET', 'Invalid MFS account or asset type.');
  }
  const { id, kind } = parsed.data;
  const config = assetConfig[kind];

  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  const { data: account, error: accountError } = await supabase
    .from('wallet_company_mfs_accounts')
    .select(`id, ${config.column}`)
    .eq('id', id)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message, config.label);
  if (!account) {
    return walletFail(404, 'MFS_ACCOUNT_NOT_FOUND', 'MFS account not found.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `wallet.payment_mfs_${kind.replace('-', '_')}_removed`,
    targetType: 'payment_mfs_account',
    targetId: id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const { error } = await supabase
    .from('wallet_company_mfs_accounts')
    .update({ [config.column]: null })
    .eq('id', id);
  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return storageFailure(error.message, config.label);
  }

  const previous = paymentAsset(
    (account as Record<string, unknown>)[config.column]
  );
  if (previous) await destroyAsset(previous.publicId);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ removed: true });
}
