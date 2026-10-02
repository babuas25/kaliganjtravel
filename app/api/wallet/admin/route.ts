import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { listWallets, setWalletStatus } from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canManageWallet, canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

const schema = z.object({
  walletId: z.string().uuid(),
  status: z.enum(['active', 'frozen']),
  reason: z.string().trim().max(1000).optional(),
});

type WalletOwnerUser = {
  clerk_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

type WalletOwnerAgency = {
  agency_code: string;
  owner_user_id: string | null;
};

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canReadWallet(session.role)) {
    return walletFail(403, 'FORBIDDEN', 'Wallet read access is required.');
  }
  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  let wallets;
  let agencies;
  let agencyOwnerIds: Map<string, string>;
  let users: Map<string, WalletOwnerUser>;
  try {
    [wallets, agencies] = await Promise.all([listWallets(), listAgencies()]);
    const agencyCodes = Array.from(
      new Set(
        wallets
          .filter((wallet) => wallet.ownerType === 'agency')
          .map((wallet) => wallet.ownerKey)
      )
    );
    const agencyOwnersResult = agencyCodes.length
      ? await supabase
          .from('agencies')
          .select('agency_code, owner_user_id')
          .in('agency_code', agencyCodes)
      : { data: [] as WalletOwnerAgency[], error: null };
    if (agencyOwnersResult.error) throw new Error('Wallet agency details could not be loaded.');
    // An agency shares one wallet. Search metadata belongs to its canonical
    // owner, rather than whichever partner or sub user last used the wallet.
    agencyOwnerIds = new Map(
      ((agencyOwnersResult.data ?? []) as WalletOwnerAgency[])
        .filter((agency): agency is WalletOwnerAgency & { owner_user_id: string } =>
          Boolean(agency.owner_user_id)
        )
        .map((agency) => [agency.agency_code, agency.owner_user_id])
    );
    const userIds = Array.from(
      new Set(
        [
          ...wallets
            .filter((wallet) => wallet.ownerType === 'user')
            .map((wallet) => wallet.ownerKey),
          ...Array.from(agencyOwnerIds.values()),
        ]
      )
    );
    const usersResult = userIds.length
      ? await supabase
          .from('app_users')
          .select('clerk_id, email, first_name, last_name')
          .in('clerk_id', userIds)
      : { data: [] as WalletOwnerUser[], error: null };
    if (usersResult.error) throw new Error('Wallet owner details could not be loaded.');
    users = new Map(
      ((usersResult.data ?? []) as WalletOwnerUser[]).map((user) => [user.clerk_id, user])
    );
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  const agencyNames = new Map(
    agencies.map((agency) => [agency.agencyCode, agency.label] as const)
  );

  return walletOk({
    wallets: wallets.map((wallet) => {
      const ownerUserId = wallet.ownerType === 'agency'
        ? agencyOwnerIds.get(wallet.ownerKey)
        : wallet.ownerKey;
      const user = ownerUserId ? users.get(ownerUserId) : undefined;
      const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
      return {
        ...wallet,
        ownerName:
          wallet.ownerType === 'agency'
            ? agencyNames.get(wallet.ownerKey) || 'Unnamed agency'
            : name || user?.email || 'B2C customer',
        ownerEmail: user?.email ?? null,
      };
    }),
  });
}

export async function PATCH(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canManageWallet(session.role)) {
    return walletFail(403, 'FORBIDDEN', 'Wallet mutation access is required.');
  }
  const limit = await checkActionLimit('walletManage', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many wallet actions.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return walletFail(400, 'INVALID_WALLET_STATUS', 'Check the wallet status request.');
  if (parsed.data.status === 'frozen' && !parsed.data.reason) {
    return walletFail(400, 'FREEZE_REASON_REQUIRED', 'A freeze reason is required.');
  }
  const ok = await setWalletStatus(
    parsed.data.walletId,
    parsed.data.status,
    session.clerkId,
    parsed.data.reason
  );
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `wallet.${parsed.data.status}`,
    targetType: 'wallet',
    targetId: parsed.data.walletId,
    outcome: ok ? 'succeeded' : 'failed',
    metadata: parsed.data.reason ? { reason: parsed.data.reason } : {},
  });
  return ok
    ? walletOk({ status: parsed.data.status })
    : walletFail(503, 'STORAGE_ERROR', 'The wallet status could not be changed.');
}
