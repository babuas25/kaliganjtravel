import WalletDashboard, { type WalletTab } from '@/components/dashboard/wallet/WalletDashboard';
import { isCloudinaryConfigured } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import { listWalletOwnerBankAccounts } from '@/lib/db/wallet-owner-bank-accounts';
import type { UserBankAccountOption } from '@/lib/wallet/payment-options';
import { listDepositPaymentOptions } from '@/lib/wallet/payment-options.server';
import { walletOwnerForSession } from '@/lib/wallet/permissions';

type Props = {
  initialTab?: WalletTab;
};

/** Server-side bridge for owner-scoped, multi-account sender bank details. */
export default async function UserWalletDashboard({
  initialTab,
}: Props) {
  const session = await getDashboardSession();
  const owner = session ? walletOwnerForSession(session) : null;
  let savedBankAccounts: UserBankAccountOption[] = [];
  let savedBankAccountsUnavailable = false;
  const paymentOptions = await listDepositPaymentOptions();

  try {
    savedBankAccounts = owner ? await listWalletOwnerBankAccounts(owner) : [];
  } catch {
    savedBankAccountsUnavailable = true;
  }

  return (
    <WalletDashboard
      initialTab={initialTab}
      savedBankAccounts={savedBankAccounts}
      savedBankAccountsUnavailable={savedBankAccountsUnavailable}
      agencyWallet={owner?.ownerType === 'agency'}
      paymentOptions={paymentOptions}
      attachmentsConfigured={isCloudinaryConfigured()}
    />
  );
}
