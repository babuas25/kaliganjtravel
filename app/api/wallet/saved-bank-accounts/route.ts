import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { walletOwnerForSession, type WalletOwner } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

const accountFields = {
  bankName: z.string().trim().min(2).max(150),
  accountName: z.string().trim().min(2).max(150),
  accountNumber: z.string().trim().min(3).max(100),
  branchCode: z.string().trim().max(100).optional(),
  routingNumber: z.string().trim().max(100).optional(),
  swiftCode: z.string().trim().max(50).optional(),
};

const createSchema = z.object(accountFields);
const updateSchema = z.object({ id: z.string().uuid(), ...accountFields });
const deleteSchema = z.object({ id: z.string().uuid() });

type BankAccountRow = {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch_code: string | null;
  routing_number: string | null;
  swift_code: string | null;
  created_at: string;
  updated_at: string;
};

function serialize(account: BankAccountRow) {
  return {
    id: account.id,
    bankName: account.bank_name,
    accountName: account.account_name,
    accountNumber: account.account_number,
    branchCode: account.branch_code ?? '',
    routingNumber: account.routing_number ?? '',
    swiftCode: account.swift_code ?? '',
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

function storageFailure(message: string) {
  if (/schema cache|could not find the table/i.test(message)) {
    return walletFail(
      503,
      'SETUP_REQUIRED',
      'Saved bank-account storage is not ready. Apply migration 0088 to enable this feature.'
    );
  }
  return walletFail(503, 'STORAGE_ERROR', 'Saved bank accounts are unavailable.');
}

async function requireWalletOwner(): Promise<
  { clerkId: string; owner: WalletOwner } | Response
> {
  const session = await getDashboardSession();
  if (!session) {
    return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }

  const owner = walletOwnerForSession(session);
  if (!owner) {
    return walletFail(
      403,
      'WALLET_OWNER_REQUIRED',
      'Only wallet owners can manage saved bank accounts.'
    );
  }

  return { clerkId: session.clerkId, owner };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET() {
  const access = await requireWalletOwner();
  if (isResponse(access)) return access;

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_owner_bank_accounts')
    .select('*')
    .eq('owner_type', access.owner.ownerType)
    .eq('owner_key', access.owner.ownerKey)
    .order('bank_name')
    .order('account_name');

  if (error) return storageFailure(error.message);
  return walletOk({
    accounts: ((data ?? []) as BankAccountRow[]).map(serialize),
  });
}

export async function POST(request: Request) {
  const access = await requireWalletOwner();
  if (isResponse(access)) return access;

  const limit = await checkActionLimit('walletBankAccount', access.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  const parsed = createSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_BANK_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the bank account details.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const input = parsed.data;
  const { data, error } = await supabase
    .from('wallet_owner_bank_accounts')
    .insert({
      owner_type: access.owner.ownerType,
      owner_key: access.owner.ownerKey,
      bank_name: input.bankName,
      account_name: input.accountName,
      account_number: input.accountNumber,
      branch_code: input.branchCode || null,
      routing_number: input.routingNumber || null,
      swift_code: input.swiftCode?.toUpperCase() || null,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return walletFail(
        409,
        'DUPLICATE_ACCOUNT',
        'That bank account is already saved under this wallet.'
      );
    }
    return storageFailure(error.message);
  }

  return walletOk({ account: serialize(data as BankAccountRow) }, 201);
}

export async function PATCH(request: Request) {
  const access = await requireWalletOwner();
  if (isResponse(access)) return access;

  const limit = await checkActionLimit('walletBankAccount', access.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  const parsed = updateSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_BANK_ACCOUNT',
      parsed.error.issues[0]?.message ?? 'Check the bank account details.'
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const input = parsed.data;
  const { data, error } = await supabase
    .from('wallet_owner_bank_accounts')
    .update({
      bank_name: input.bankName,
      account_name: input.accountName,
      account_number: input.accountNumber,
      branch_code: input.branchCode || null,
      routing_number: input.routingNumber || null,
      swift_code: input.swiftCode?.toUpperCase() || null,
    })
    .eq('id', input.id)
    .eq('owner_type', access.owner.ownerType)
    .eq('owner_key', access.owner.ownerKey)
    .select('*')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return walletFail(
        409,
        'DUPLICATE_ACCOUNT',
        'That bank account is already saved under this wallet.'
      );
    }
    return storageFailure(error.message);
  }
  if (!data) {
    return walletFail(404, 'ACCOUNT_NOT_FOUND', 'Saved bank account not found.');
  }

  return walletOk({ account: serialize(data as BankAccountRow) });
}

export async function DELETE(request: Request) {
  const access = await requireWalletOwner();
  if (isResponse(access)) return access;

  const limit = await checkActionLimit('walletBankAccount', access.clerkId);
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  }

  const parsed = deleteSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BANK_ACCOUNT', 'Choose a saved bank account.');
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }

  const { data, error } = await supabase
    .from('wallet_owner_bank_accounts')
    .delete()
    .eq('id', parsed.data.id)
    .eq('owner_type', access.owner.ownerType)
    .eq('owner_key', access.owner.ownerKey)
    .select('id')
    .maybeSingle();

  if (error) return storageFailure(error.message);
  if (!data) {
    return walletFail(404, 'ACCOUNT_NOT_FOUND', 'Saved bank account not found.');
  }

  return walletOk({ removed: true });
}
