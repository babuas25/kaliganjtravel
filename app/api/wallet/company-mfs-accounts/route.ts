import { z } from 'zod';

import { publicUrl } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { MFS_PAYMENT_TYPES } from '@/lib/wallet/payment-options';

export const dynamic = 'force-dynamic';

const paymentTypes = MFS_PAYMENT_TYPES.map((type) => type.value) as [
  'merchant',
  'send_money',
  'cashout',
];

const accountFields = {
  mfsName: z.string().trim().min(2).max(100),
  accountNumber: z.string().trim().min(3).max(100),
  paymentType: z.enum(paymentTypes),
  chargePercent: z.coerce.number().min(0).max(100),
};

const createSchema = z.object(accountFields);
const updateSchema = z.object({
  id: z.string().uuid(),
  ...accountFields,
  active: z.boolean(),
});

type MfsAccountRow = {
  id: string;
  mfs_name: string;
  account_number: string;
  payment_type: 'merchant' | 'send_money' | 'cashout';
  charge_bps: number;
  logo: unknown;
  qr_code: unknown;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type PaymentAsset = {
  publicId: string;
  version: number;
  format: string;
  uploadedAt: string;
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

function serialize(row: MfsAccountRow) {
  const logo = paymentAsset(row.logo);
  const qrCode = paymentAsset(row.qr_code);
  return {
    id: row.id,
    mfsName: row.mfs_name,
    accountNumber: row.account_number,
    paymentType: row.payment_type,
    chargePercent: row.charge_bps / 100,
    logoUrl: logo ? publicUrl(logo.publicId, logo.version) : null,
    qrCodeUrl: qrCode ? publicUrl(qrCode.publicId, qrCode.version) : null,
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table|wallet_company_mfs/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'MFS account storage is not ready. Apply migration 0023 to enable this tool.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', 'MFS accounts could not be loaded.');
}

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

export async function GET() {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can manage MFS accounts.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_company_mfs_accounts')
    .select('*')
    .order('active', { ascending: false })
    .order('sort_order')
    .order('mfs_name');

  if (error) return storageFailure(error.message);
  return walletOk({
    accounts: ((data ?? []) as MfsAccountRow[]).map(serialize),
  });
}

export async function POST(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can add MFS accounts.'
    );
  }

  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_MFS_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the MFS account details.'
    );
  }

  const input = parsed.data;
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_mfs_account_created',
    targetType: 'payment_mfs_account',
    targetId: securitySubjectHash(`${input.mfsName}:${input.paymentType}:${input.accountNumber}`),
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_company_mfs_accounts')
    .insert({
      mfs_name: input.mfsName,
      account_number: input.accountNumber,
      payment_type: input.paymentType,
      charge_bps: Math.round(input.chargePercent * 100),
      active: true,
    })
    .select('*')
    .single();

  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    if (error.code === '23505') {
      return walletFail(
        409,
        'DUPLICATE_MFS_CHANNEL',
        'That account number is already configured for this MFS provider and payment type.'
      );
    }
    return storageFailure(error.message);
  }

  await recordSecurityAuditEvent({
    ...audit,
    targetId: String(data.id),
    outcome: 'succeeded',
  });
  return walletOk({ account: serialize(data as MfsAccountRow) }, 201);
}

export async function PATCH(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can update MFS accounts.'
    );
  }

  const limit = await checkActionLimit('managePaymentAccounts', session.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_MFS_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the MFS account details.'
    );
  }

  const input = parsed.data;
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_mfs_account_updated',
    targetType: 'payment_mfs_account',
    targetId: input.id,
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'AUDIT_UNAVAILABLE',
      'The security audit trail is unavailable, so nothing was changed.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_company_mfs_accounts')
    .update({
      mfs_name: input.mfsName,
      account_number: input.accountNumber,
      payment_type: input.paymentType,
      charge_bps: Math.round(input.chargePercent * 100),
      active: input.active,
    })
    .eq('id', input.id)
    .select('*')
    .maybeSingle();

  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    if (error.code === '23505') {
      return walletFail(
        409,
        'DUPLICATE_MFS_CHANNEL',
        'That account number is already configured for this MFS provider and payment type.'
      );
    }
    return storageFailure(error.message);
  }
  if (!data) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(404, 'MFS_ACCOUNT_NOT_FOUND', 'MFS account not found.');
  }

  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ account: serialize(data as MfsAccountRow) });
}
