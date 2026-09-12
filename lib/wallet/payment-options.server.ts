import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';

import { publicUrl } from '@/lib/cloudinary';
import { resolveRole, ROLE_LABELS, type Role } from '@/lib/roles';
import { SITE_ADDRESS } from '@/lib/site';
import { supabaseAdmin } from '@/lib/supabase/server';
import type {
  CompanyBankAccountOption,
  CompanyMfsAccountOption,
  DepositBranchOption,
  DepositPaymentOptions,
  DepositReceiverOption,
} from '@/lib/wallet/payment-options';

const DEFAULT_BRANCH: DepositBranchOption = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Head Office',
  address: SITE_ADDRESS,
};

const RECEIVER_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_account',
  'staff_support',
  'staff_media',
]);

function paymentAssetUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const logo = value as { publicId?: unknown; version?: unknown };
  if (
    typeof logo.publicId !== 'string' ||
    typeof logo.version !== 'number'
  ) {
    return null;
  }
  return publicUrl(logo.publicId, logo.version);
}

async function listBranches(): Promise<DepositBranchOption[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [DEFAULT_BRANCH];

  const { data, error } = await supabase
    .from('wallet_payment_branches')
    .select('id, name, address')
    .eq('active', true)
    .order('sort_order')
    .order('name');

  // This fallback keeps development usable before migration 0023 is applied.
  if (error) {
    console.warn('[wallet] payment branches unavailable:', error.message);
    return [DEFAULT_BRANCH];
  }

  return ((data ?? []) as DepositBranchOption[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    address: row.address ? String(row.address) : null,
  }));
}

async function listBankAccounts(): Promise<CompanyBankAccountOption[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('wallet_company_bank_accounts')
    .select(
      'id, bank_name, account_name, account_number, branch_name, branch_code, routing_number, swift_code, logo'
    )
    .eq('active', true)
    .order('sort_order')
    .order('bank_name');

  if (error) {
    console.warn('[wallet] company bank accounts unavailable:', error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    bankName: String(row.bank_name),
    accountName: String(row.account_name),
    accountNumber: String(row.account_number),
    branchName: row.branch_name ? String(row.branch_name) : null,
    branchCode: row.branch_code ? String(row.branch_code) : null,
    routingNumber: row.routing_number ? String(row.routing_number) : null,
    swiftCode: row.swift_code ? String(row.swift_code) : null,
    logoUrl: paymentAssetUrl(row.logo),
  }));
}

async function listMfsAccounts(): Promise<CompanyMfsAccountOption[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('wallet_company_mfs_accounts')
    .select(
      'id, mfs_name, account_number, payment_type, charge_bps, logo, qr_code'
    )
    .eq('active', true)
    .order('sort_order')
    .order('mfs_name');

  if (error) {
    console.warn('[wallet] company MFS accounts unavailable:', error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const chargeBps = Number(row.charge_bps) || 0;
    return {
      id: String(row.id),
      mfsName: String(row.mfs_name),
      accountNumber: String(row.account_number),
      paymentType: row.payment_type as CompanyMfsAccountOption['paymentType'],
      chargeBps,
      chargePercent: chargeBps / 100,
      logoUrl: paymentAssetUrl(row.logo),
      qrCodeUrl: paymentAssetUrl(row.qr_code),
    };
  });
}

async function listReceivers(): Promise<DepositReceiverOption[]> {
  try {
    const client = await clerkClient();
    const receivers: DepositReceiverOption[] = [];
    let offset = 0;
    const limit = 100;

    while (offset < 1000) {
      const page = await client.users.getUserList({ limit, offset });
      for (const user of page.data) {
        const role = resolveRole(user.publicMetadata?.role);
        if (!RECEIVER_ROLES.has(role)) continue;

        const name =
          [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
          user.username ||
          user.primaryEmailAddress?.emailAddress ||
          user.id;

        receivers.push({ id: user.id, name, roleLabel: ROLE_LABELS[role] });
      }

      offset += page.data.length;
      if (!page.data.length || offset >= page.totalCount) break;
    }

    return receivers.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    console.error('[wallet] deposit receivers unavailable:', error);
    return [];
  }
}

export async function listDepositPaymentOptions(): Promise<DepositPaymentOptions> {
  const [branches, receivers, bankAccounts, mfsAccounts] = await Promise.all([
    listBranches(),
    listReceivers(),
    listBankAccounts(),
    listMfsAccounts(),
  ]);

  return { branches, receivers, bankAccounts, mfsAccounts };
}

export async function findDepositBranch(
  id: string
): Promise<DepositBranchOption | null> {
  const branches = await listBranches();
  return branches.find((branch) => branch.id === id) ?? null;
}

export async function findCompanyBankAccount(
  id: string
): Promise<CompanyBankAccountOption | null> {
  const accounts = await listBankAccounts();
  return accounts.find((account) => account.id === id) ?? null;
}

export async function findCompanyMfsAccount(
  id: string
): Promise<CompanyMfsAccountOption | null> {
  const accounts = await listMfsAccounts();
  return accounts.find((account) => account.id === id) ?? null;
}

export async function findDepositReceiver(
  id: string
): Promise<DepositReceiverOption | null> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(id);
    const role = resolveRole(user.publicMetadata?.role);
    if (!RECEIVER_ROLES.has(role)) return null;

    return {
      id: user.id,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
        user.username ||
        user.primaryEmailAddress?.emailAddress ||
        user.id,
      roleLabel: ROLE_LABELS[role],
    };
  } catch {
    return null;
  }
}
