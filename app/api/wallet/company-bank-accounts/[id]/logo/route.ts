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

const idSchema = z.string().uuid();

type BankLogo = {
  publicId: string;
  version: number;
  format: string;
  uploadedAt: string;
};

function bankLogo(value: unknown): BankLogo | null {
  if (!value || typeof value !== 'object') return null;
  const logo = value as Partial<BankLogo>;
  if (
    typeof logo.publicId !== 'string' ||
    typeof logo.version !== 'number' ||
    typeof logo.format !== 'string'
  ) {
    return null;
  }
  return {
    publicId: logo.publicId,
    version: logo.version,
    format: logo.format,
    uploadedAt: typeof logo.uploadedAt === 'string' ? logo.uploadedAt : '',
  };
}

async function contextId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return idSchema.safeParse(id);
}

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table|logo.*column/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'Payment bank-account logo storage is not ready. Apply migration 0023 to enable uploads.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', 'The bank logo could not be saved.');
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can upload bank logos.'
    );
  }

  const parsedId = await contextId(context);
  if (!parsedId.success) {
    return walletFail(400, 'INVALID_ACCOUNT_ID', 'Invalid bank account.');
  }

  const limit = await checkActionLimit(
    'managePaymentAccounts',
    session.clerkId
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds)
    );
  }

  const contentLength = Number(request.headers.get('content-length')) || 0;
  if (contentLength > LOGO_MAX_BYTES + 128 * 1024) {
    return walletFail(
      413,
      'LOGO_TOO_LARGE',
      'The bank logo is over the 512 KB limit.'
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return walletFail(400, 'INVALID_BODY', 'Expected a bank logo upload.');
  }

  const file = form.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    return walletFail(400, 'LOGO_REQUIRED', 'Choose a bank logo first.');
  }
  if (!LOGO_EXTENSIONS[file.type]) {
    return walletFail(
      400,
      'INVALID_LOGO_TYPE',
      'Use an SVG, PNG, WebP or JPEG bank logo.'
    );
  }
  if (file.size > LOGO_MAX_BYTES) {
    return walletFail(
      413,
      'LOGO_TOO_LARGE',
      'The bank logo is over the 512 KB limit.'
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectLogoBytes(bytes, file.type);
  if (!inspection.ok) {
    return walletFail(400, 'INVALID_LOGO', inspection.reason);
  }

  const accountId = parsedId.data;
  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data: account, error: accountError } = await supabase
    .from('wallet_company_bank_accounts')
    .select('id, logo')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message);
  if (!account) {
    return walletFail(404, 'ACCOUNT_NOT_FOUND', 'Bank account not found.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bank_logo_uploaded',
    targetType: 'payment_bank_account',
    targetId: accountId,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: FOLDERS.bankLogos,
  });
  if (!stored.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(400, 'LOGO_UPLOAD_FAILED', stored.message);
  }

  const logo: BankLogo = {
    publicId: stored.asset.publicId,
    version: stored.asset.version,
    format: stored.asset.format,
    uploadedAt: stored.asset.createdAt ?? new Date().toISOString(),
  };
  const { error: updateError } = await supabase
    .from('wallet_company_bank_accounts')
    .update({ logo })
    .eq('id', accountId);

  if (updateError) {
    await destroyAsset(stored.asset.publicId);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return storageFailure(updateError.message);
  }

  const previous = bankLogo(account.logo);
  if (previous && previous.publicId !== logo.publicId) {
    await destroyAsset(previous.publicId);
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });

  return walletOk({
    logoUrl: publicUrl(logo.publicId, logo.version) ?? stored.asset.url,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can remove bank logos.'
    );
  }

  const parsedId = await contextId(context);
  if (!parsedId.success) {
    return walletFail(400, 'INVALID_ACCOUNT_ID', 'Invalid bank account.');
  }

  const limit = await checkActionLimit(
    'managePaymentAccounts',
    session.clerkId
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds)
    );
  }

  const accountId = parsedId.data;
  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data: account, error: accountError } = await supabase
    .from('wallet_company_bank_accounts')
    .select('id, logo')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message);
  if (!account) {
    return walletFail(404, 'ACCOUNT_NOT_FOUND', 'Bank account not found.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bank_logo_removed',
    targetType: 'payment_bank_account',
    targetId: accountId,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const { error } = await supabase
    .from('wallet_company_bank_accounts')
    .update({ logo: null })
    .eq('id', accountId);
  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return storageFailure(error.message);
  }

  const previous = bankLogo(account.logo);
  if (previous) await destroyAsset(previous.publicId);
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ removed: true });
}
