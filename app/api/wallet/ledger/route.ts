import { getDashboardSession } from '@/lib/dashboard/session';
import { signDocuments } from '@/lib/db/document-uploads';
import { listDepositRequests, listWallets } from '@/lib/db/wallet';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

type AppUserRow = {
  clerk_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

type AgencyRow = {
  agency_code: string;
  owner_user_id: string | null;
};

type AgencyProfileRow = {
  clerk_id: string;
  agency_name: string | null;
};

function personLabel(user: AppUserRow | undefined, fallback: string) {
  if (!user) return fallback;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.email || fallback;
}

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canReadWallet(session.role)) {
    return walletFail(403, 'FORBIDDEN', 'Wallet read access is required.');
  }

  const supabase = supabaseAdmin();
  if (!supabase) return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');

  try {
  const [wallets, deposits] = await Promise.all([
    listWallets(null),
    listDepositRequests(undefined, 1000),
  ]);
  const bdtWallets = wallets.filter((wallet) => wallet.currency === 'BDT');
  const frozenWalletIds = new Set(
    bdtWallets
      .filter((wallet) => wallet.status === 'frozen')
      .map((wallet) => wallet.walletId)
  );
  const totals = bdtWallets.reduce(
    (sum, wallet) => ({
      available: sum.available + wallet.availableBalance,
      hold: sum.hold + wallet.holdBalance,
      frozenAmount:
        sum.frozenAmount +
        (wallet.status === 'frozen' ? wallet.totalBalance : 0),
      b2b: sum.b2b + (wallet.ownerType === 'agency' ? wallet.totalBalance : 0),
      b2c: sum.b2c + (wallet.ownerType === 'user' ? wallet.totalBalance : 0),
      system: sum.system + wallet.totalBalance,
    }),
    { available: 0, hold: 0, frozenAmount: 0, b2b: 0, b2c: 0, system: 0 }
  );

  const walletByAccount = new Map(
    wallets.map((wallet) => [wallet.accountId, wallet] as const)
  );
  const agencyCodes = Array.from(
    new Set(
      deposits
        .map((request) => walletByAccount.get(request.wallet_account_id))
        .filter((wallet) => wallet?.ownerType === 'agency')
        .map((wallet) => wallet?.ownerKey as string)
    )
  );
  const agencyResult = agencyCodes.length
    ? await supabase
        .from('agencies')
        .select('agency_code, owner_user_id')
        .in('agency_code', agencyCodes)
    : { data: [] as AgencyRow[], error: null };
  if (agencyResult.error) {
    return walletFail(503, 'STORAGE_ERROR', 'Agency details could not be loaded.');
  }
  const agencies = (agencyResult.data ?? []) as AgencyRow[];
  const agencyByCode = new Map(agencies.map((agency) => [agency.agency_code, agency]));

  const userIds = new Set<string>();
  for (const request of deposits) {
    userIds.add(request.requested_by_user_id);
    if (request.reviewed_by_user_id) userIds.add(request.reviewed_by_user_id);
    const wallet = walletByAccount.get(request.wallet_account_id);
    if (wallet?.ownerType === 'user') userIds.add(wallet.ownerKey);
  }
  for (const agency of agencies) {
    if (agency.owner_user_id) userIds.add(agency.owner_user_id);
  }

  const ids = Array.from(userIds);
  const [usersResult, profilesResult] = ids.length
    ? await Promise.all([
        supabase
          .from('app_users')
          .select('clerk_id, email, first_name, last_name')
          .in('clerk_id', ids),
        supabase
          .from('user_profiles')
          .select('clerk_id, agency_name')
          .in('clerk_id', ids),
      ])
    : [
        { data: [] as AppUserRow[], error: null },
        { data: [] as AgencyProfileRow[], error: null },
      ];
  if (usersResult.error || profilesResult.error) {
    return walletFail(503, 'STORAGE_ERROR', 'User details could not be loaded.');
  }

  const users = new Map(
    ((usersResult.data ?? []) as AppUserRow[]).map((user) => [user.clerk_id, user])
  );
  const profiles = new Map(
    ((profilesResult.data ?? []) as AgencyProfileRow[]).map((profile) => [
      profile.clerk_id,
      profile,
    ])
  );

  const requests = deposits.map((request) => {
    const wallet = walletByAccount.get(request.wallet_account_id);
    let userLabel = wallet?.ownerKey ?? 'Unknown wallet';
    let userSecondary = wallet?.ownerType === 'agency' ? 'B2B agency' : 'B2C customer';
    if (wallet?.ownerType === 'agency') {
      const agency = agencyByCode.get(wallet.ownerKey);
      const ownerId = agency?.owner_user_id ?? undefined;
      userLabel =
        (ownerId ? profiles.get(ownerId)?.agency_name : null) ||
        (ownerId ? personLabel(users.get(ownerId), wallet.ownerKey) : wallet.ownerKey);
      userSecondary = wallet.ownerKey;
    } else if (wallet?.ownerType === 'user') {
      userLabel = personLabel(users.get(wallet.ownerKey), wallet.ownerKey);
      userSecondary = 'B2C customer';
    }
    return {
      id: request.id,
      requestReference: request.public_ref,
      paymentMethod: request.method,
      paymentReference: request.reference_number,
      attachmentUrl: request.attachment
        ? signDocuments([request.attachment], () => 'View attachment')[0]?.url ?? null
        : null,
      userLabel,
      userSecondary,
      requestedBy: personLabel(
        users.get(request.requested_by_user_id),
        request.requested_by_user_id
      ),
      issuedBy: request.reviewed_by_user_id
        ? personLabel(users.get(request.reviewed_by_user_id), request.reviewed_by_user_id)
        : null,
      amount: request.amount,
      currency: request.currency,
      createdAt: request.requested_at,
      updatedAt: request.updated_at,
      status: request.status,
    };
  });

  return walletOk({
    currency: 'BDT',
    totals: { ...totals, frozenCount: frozenWalletIds.size },
    requests,
  });
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'The account ledger is unavailable.');
  }
}
