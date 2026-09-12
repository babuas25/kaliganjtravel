import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import {
  createAdjustmentRequest,
  listAdjustmentRequests,
  type AdjustmentRequestRow,
} from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { majorToMinor } from '@/lib/wallet/money';
import { canManageWallet, canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

const schema = z.object({
  accountId: z.string().uuid(),
  adjustmentType: z.enum(['credit', 'debit']),
  amount: z.coerce.number().positive().max(100_000_000),
  reason: z.string().trim().min(3).max(1000),
});

type RequesterRow = {
  clerk_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

type WalletAccountRow = {
  id: string;
  wallet_id: string;
};

type WalletOwnerRow = {
  id: string;
  owner_type: 'agency' | 'user';
  owner_key: string;
};

function requesterName(requester: RequesterRow | undefined): string | null {
  if (!requester) return null;
  const name = [requester.first_name, requester.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || requester.email || null;
}

/**
 * An adjustment can be submitted by an internal operator for any wallet. The
 * requester's agency is therefore not the answer to "which agency is being
 * adjusted"; resolve the owning wallet independently and return both facts to
 * a financial reviewer.
 */
async function serializeFinancialAdjustments(requests: AdjustmentRequestRow[]) {
  const supabase = supabaseAdmin();
  if (!supabase || !requests.length) return requests;

  const requesterIds = Array.from(
    new Set(
      requests
        .map((request) => request.requested_by_user_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  const walletAccountIds = Array.from(
    new Set(requests.map((request) => request.wallet_account_id))
  );

  const [requestersResult, walletAccountsResult] = await Promise.all([
    supabase
      .from('app_users')
      .select('clerk_id, email, first_name, last_name')
      .in('clerk_id', requesterIds),
    supabase
      .from('wallet_accounts')
      .select('id, wallet_id')
      .in('id', walletAccountIds),
  ]);

  if (requestersResult.error || walletAccountsResult.error) {
    throw new Error('Adjustment request details could not be loaded.');
  }

  const requesters = new Map(
    ((requestersResult.data ?? []) as RequesterRow[]).map((requester) => [
      requester.clerk_id,
      requester,
    ])
  );
  const walletAccounts = new Map(
    ((walletAccountsResult.data ?? []) as WalletAccountRow[]).map((account) => [
      account.id,
      account,
    ])
  );
  const walletIds = Array.from(
    new Set(Array.from(walletAccounts.values()).map((account) => account.wallet_id))
  );
  const [walletOwnersResult, agencies] = await Promise.all([
    walletIds.length
      ? supabase
          .from('wallets')
          .select('id, owner_type, owner_key')
          .in('id', walletIds)
      : Promise.resolve({ data: [] as WalletOwnerRow[], error: null }),
    listAgencies(),
  ]);
  if (walletOwnersResult.error) {
    throw new Error('Adjustment wallet details could not be loaded.');
  }
  const walletOwners = new Map(
    ((walletOwnersResult.data ?? []) as WalletOwnerRow[]).map((wallet) => [
      wallet.id,
      wallet,
    ])
  );
  const agencyNames = new Map(
    agencies.map((agency) => [agency.agencyCode, agency.label.trim()] as const)
  );

  return requests.map((request) => {
    const walletAccount = walletAccounts.get(request.wallet_account_id);
    const wallet = walletAccount
      ? walletOwners.get(walletAccount.wallet_id)
      : undefined;
    const agencyCode = wallet?.owner_type === 'agency' ? wallet.owner_key : null;
    return {
      ...request,
      requester: { name: requesterName(requesters.get(request.requested_by_user_id)) },
      target: {
        type: agencyCode ? 'agency' : 'user',
        name: agencyCode
          ? agencyNames.get(agencyCode) || 'Agency name not set'
          : 'B2C customer wallet',
        agencyCode,
      },
    };
  });
}

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canReadWallet(session.role)) return walletFail(403, 'FORBIDDEN', 'Wallet read access is required.');
  try {
    const requests = await listAdjustmentRequests();
    return walletOk({ requests: await serializeFinancialAdjustments(requests) });
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canManageWallet(session.role)) return walletFail(403, 'FORBIDDEN', 'Wallet mutation access is required.');
  const limit = await checkActionLimit('walletManage', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many wallet actions.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return walletFail(400, 'INVALID_ADJUSTMENT', parsed.error.issues[0]?.message ?? 'Invalid adjustment.');
  const created = await createAdjustmentRequest({
    accountId: parsed.data.accountId,
    adjustmentType: parsed.data.adjustmentType,
    amount: majorToMinor(parsed.data.amount),
    reason: parsed.data.reason,
    session,
  });
  return created
    ? walletOk({ request: created }, 201)
    : walletFail(503, 'STORAGE_ERROR', 'The adjustment request could not be saved.');
}
