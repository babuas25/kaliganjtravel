import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';
import type { UserBankAccountOption } from '@/lib/wallet/payment-options';
import type { WalletOwner } from '@/lib/wallet/permissions';

const TABLE = 'wallet_owner_bank_accounts';

type BankAccountRow = {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch_code: string | null;
  routing_number: string | null;
  swift_code: string | null;
};

function serialize(row: BankAccountRow): UserBankAccountOption {
  return {
    id: row.id,
    bankName: row.bank_name,
    accountName: row.account_name,
    accountNumber: row.account_number,
    branchCode: row.branch_code ?? '',
    routingNumber: row.routing_number ?? '',
    swiftCode: row.swift_code ?? '',
  };
}

/**
 * Saved sender accounts belong to the same owner boundary as the wallet. That
 * means every B2B member sees the agency's accounts, while a B2C customer only
 * sees their own.
 */
export async function listWalletOwnerBankAccounts(
  owner: WalletOwner
): Promise<UserBankAccountOption[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Saved bank accounts are unavailable.');

  const { data, error } = await supabase
    .from(TABLE)
    .select(
      'id, bank_name, account_name, account_number, branch_code, routing_number, swift_code'
    )
    .eq('owner_type', owner.ownerType)
    .eq('owner_key', owner.ownerKey)
    .order('bank_name')
    .order('account_name');

  if (error) {
    console.error('[wallet] saved bank accounts list failed:', error.message);
    throw new Error('Saved bank accounts are unavailable.');
  }

  return ((data ?? []) as BankAccountRow[]).map(serialize);
}

/**
 * Looks up an account through its wallet-owner boundary, rather than trusting
 * an ID supplied by the browser. It is the server-side ownership check used
 * before a bank-transfer deposit is accepted.
 */
export async function findWalletOwnerBankAccount(
  owner: WalletOwner,
  accountId: string
): Promise<UserBankAccountOption | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Saved bank accounts are unavailable.');

  const { data, error } = await supabase
    .from(TABLE)
    .select(
      'id, bank_name, account_name, account_number, branch_code, routing_number, swift_code'
    )
    .eq('id', accountId)
    .eq('owner_type', owner.ownerType)
    .eq('owner_key', owner.ownerKey)
    .maybeSingle();

  if (error) {
    console.error('[wallet] saved bank account lookup failed:', error.message);
    throw new Error('Saved bank accounts are unavailable.');
  }

  return data ? serialize(data as BankAccountRow) : null;
}
