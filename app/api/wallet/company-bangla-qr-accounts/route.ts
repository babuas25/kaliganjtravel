import { z } from 'zod';

import { isCloudinaryConfigured } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent, securitySubjectHash } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { banglaQrAssetUrl } from '@/lib/wallet/bangla-qr';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const dynamic = 'force-dynamic';

const accountFields = {
  merchantName: z.string().trim().min(2).max(150),
  bankName: z.string().trim().max(150).nullable().optional(),
  merchantId: z.string().trim().max(100).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100000).default(0),
};

const createSchema = z.object(accountFields);
const updateSchema = z.object({
  id: z.string().uuid(),
  ...accountFields,
  active: z.boolean(),
});

type BanglaQrAccountRow = {
  id: string;
  merchant_name: string;
  bank_name: string | null;
  merchant_id: string | null;
  qr_code: unknown;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function serialize(row: BanglaQrAccountRow) {
  return {
    id: row.id,
    merchantName: row.merchant_name,
    bankName: row.bank_name,
    merchantId: row.merchant_id,
    qrCodeUrl: banglaQrAssetUrl(row.qr_code),
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table|wallet_company_bangla_qr/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'Bangla QR storage is not ready. Apply the Bangla QR database migration to enable this tool.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', 'Bangla QR accounts could not be saved or loaded.');
}

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

export async function GET() {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(403, 'SUPERADMIN_REQUIRED', 'Only a Super Admin can manage Bangla QR accounts.');
  }

  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');

  const { data, error } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .select('*')
    .order('active', { ascending: false })
    .order('sort_order')
    .order('merchant_name');

  if (error) return storageFailure(error.message);
  return walletOk({
    accounts: ((data ?? []) as BanglaQrAccountRow[]).map(serialize),
    uploadConfigured: isCloudinaryConfigured(),
  });
}

export async function POST(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(403, 'SUPERADMIN_REQUIRED', 'Only a Super Admin can add Bangla QR accounts.');
  }
  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BANGLA_QR_ACCOUNT', parsed.error.issues[0]?.message ?? 'Check the Bangla QR account details.');
  }

  const input = parsed.data;
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bangla_qr_account_created',
    targetType: 'payment_bangla_qr_account',
    targetId: securitySubjectHash(`${input.merchantName}:${input.bankName ?? ''}:${input.merchantId ?? ''}`),
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'AUDIT_UNAVAILABLE', 'The security audit trail is unavailable, so nothing was changed.');
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  const { data, error } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .insert({
      merchant_name: input.merchantName,
      bank_name: input.bankName || null,
      merchant_id: input.merchantId || null,
      sort_order: input.sortOrder,
      // Upload the QR before exposing this account to paying customers.
      active: false,
    })
    .select('*')
    .single();

  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    if (error.code === '23505') {
      return walletFail(409, 'DUPLICATE_BANGLA_QR_ACCOUNT', 'That Bangla QR merchant is already configured.');
    }
    return storageFailure(error.message);
  }
  await recordSecurityAuditEvent({ ...audit, targetId: String(data.id), outcome: 'succeeded' });
  return walletOk({ account: serialize(data as BanglaQrAccountRow) }, 201);
}

export async function PATCH(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(403, 'SUPERADMIN_REQUIRED', 'Only a Super Admin can update Bangla QR accounts.');
  }
  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BANGLA_QR_ACCOUNT', parsed.error.issues[0]?.message ?? 'Check the Bangla QR account details.');
  }

  const input = parsed.data;
  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');

  const { data: account, error: accountError } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .select('id, qr_code, updated_at')
    .eq('id', input.id)
    .maybeSingle();
  if (accountError) return storageFailure(accountError.message);
  if (!account) return walletFail(404, 'BANGLA_QR_ACCOUNT_NOT_FOUND', 'Bangla QR account not found.');
  if (input.active && !banglaQrAssetUrl(account.qr_code)) {
    return walletFail(400, 'QR_REQUIRED', 'Upload a QR code before activating this Bangla QR account.');
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bangla_qr_account_updated',
    targetType: 'payment_bangla_qr_account',
    targetId: input.id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'AUDIT_UNAVAILABLE', 'The security audit trail is unavailable, so nothing was changed.');
  }

  const { data, error } = await supabase
    .from('wallet_company_bangla_qr_accounts')
    .update({
      merchant_name: input.merchantName,
      bank_name: input.bankName || null,
      merchant_id: input.merchantId || null,
      sort_order: input.sortOrder,
      active: input.active,
    })
    .eq('id', input.id)
    .eq('updated_at', account.updated_at)
    .select('*')
    .maybeSingle();

  if (error || !data) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    if (error?.code === '23505') {
      return walletFail(409, 'DUPLICATE_BANGLA_QR_ACCOUNT', 'That Bangla QR merchant is already configured.');
    }
    return error
      ? storageFailure(error.message)
      : walletFail(409, 'ACCOUNT_CHANGED', 'This Bangla QR account changed. Refresh and try again.');
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ account: serialize(data as BanglaQrAccountRow) });
}
