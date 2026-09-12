import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { listAgencies } from '@/lib/db/agencies';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { listWallets, setWalletStatus } from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canManageWallet, canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

const schema = z.object({
  walletId: z.string().uuid(),
  status: z.enum(['active', 'frozen']),
  reason: z.string().trim().max(1000).optional(),
});

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canReadWallet(session.role)) {
    return walletFail(403, 'FORBIDDEN', 'Wallet read access is required.');
  }
  let wallets;
  let agencies;
  try {
    [wallets, agencies] = await Promise.all([listWallets(), listAgencies()]);
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  const agencyNames = new Map(
    agencies.map((agency) => [agency.agencyCode, agency.label] as const)
  );

  return walletOk({
    wallets: wallets.map((wallet) => ({
      ...wallet,
      ownerName:
        wallet.ownerType === 'agency'
          ? agencyNames.get(wallet.ownerKey) || 'Unnamed agency'
          : 'B2C customer',
    })),
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
