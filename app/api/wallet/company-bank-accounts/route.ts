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

export const dynamic = 'force-dynamic';

const accountFields = {
  bankName: z.string().trim().min(2).max(150),
  accountName: z.string().trim().min(2).max(150),
  accountNumber: z.string().trim().min(3).max(100),
  branchName: z.string().trim().max(150).optional(),
  branchCode: z.string().trim().max(100).optional(),
  routingNumber: z.string().trim().max(100).optional(),
  swiftCode: z.string().trim().max(50).optional(),
};

const createSchema = z.object(accountFields);
const updateSchema = z.object({
  id: z.string().uuid(),
  ...accountFields,
  active: z.boolean(),
});

type BankAccountRow = {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch_name: string | null;
  branch_code: string | null;
  routing_number: string | null;
  swift_code: string | null;
  logo: unknown;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

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

function serialize(row: BankAccountRow) {
  const logo = bankLogo(row.logo);
  return {
    id: row.id,
    bankName: row.bank_name,
    accountName: row.account_name,
    accountNumber: row.account_number,
    branchName: row.branch_name,
    branchCode: row.branch_code,
    routingNumber: row.routing_number,
    swiftCode: row.swift_code,
    logoUrl: logo ? publicUrl(logo.publicId, logo.version) : null,
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'Payment bank-account storage is not ready. Apply migration 0023 to enable this tool.'
    );
  }
  return walletFail(
    503,
    'STORAGE_ERROR',
    'Payment bank accounts could not be loaded.'
  );
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
      'Only a Super Admin can manage payment bank accounts.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_company_bank_accounts')
    .select('*')
    .order('active', { ascending: false })
    .order('sort_order')
    .order('bank_name');

  if (error) return storageFailure(error.message);
  return walletOk({
    accounts: ((data ?? []) as BankAccountRow[]).map(serialize),
  });
}

export async function POST(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can add payment bank accounts.'
    );
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
      'INVALID_BANK_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the bank account details.'
    );
  }

  const targetId = securitySubjectHash(parsed.data.accountNumber);
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bank_account_created',
    targetType: 'payment_bank_account',
    targetId,
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

  const input = parsed.data;
  const { data, error } = await supabase
    .from('wallet_company_bank_accounts')
    .insert({
      bank_name: input.bankName,
      account_name: input.accountName,
      account_number: input.accountNumber,
      branch_name: input.branchName || null,
      branch_code: input.branchCode || null,
      routing_number: input.routingNumber || null,
      swift_code: input.swiftCode?.toUpperCase() || null,
      active: true,
    })
    .select('*')
    .single();

  if (error) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    if (error.code === '23505') {
      return walletFail(
        409,
        'DUPLICATE_ACCOUNT',
        'That bank account number is already configured.'
      );
    }
    return storageFailure(error.message);
  }

  await recordSecurityAuditEvent({
    ...audit,
    targetId: String(data.id),
    outcome: 'succeeded',
  });
  return walletOk({ account: serialize(data as BankAccountRow) }, 201);
}

export async function PATCH(request: Request) {
  const session = await requireSuperadmin();
  if (!session) {
    return walletFail(
      403,
      'SUPERADMIN_REQUIRED',
      'Only a Super Admin can update payment bank accounts.'
    );
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
      'INVALID_BANK_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the bank account details.'
    );
  }

  const input = parsed.data;
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.payment_bank_account_updated',
    targetType: 'payment_bank_account',
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
    .from('wallet_company_bank_accounts')
    .update({
      bank_name: input.bankName,
      account_name: input.accountName,
      account_number: input.accountNumber,
      branch_name: input.branchName || null,
      branch_code: input.branchCode || null,
      routing_number: input.routingNumber || null,
      swift_code: input.swiftCode?.toUpperCase() || null,
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
        'DUPLICATE_ACCOUNT',
        'That bank account number is already configured.'
      );
    }
    return storageFailure(error.message);
  }
  if (!data) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed' });
    return walletFail(404, 'ACCOUNT_NOT_FOUND', 'Bank account not found.');
  }

  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded' });
  return walletOk({ account: serialize(data as BankAccountRow) });
}
