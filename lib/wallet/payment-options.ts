export type DepositBranchOption = {
  id: string;
  name: string;
  address: string | null;
};

export type DepositReceiverOption = {
  id: string;
  name: string;
  roleLabel: string;
};

export type CompanyBankAccountOption = {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchName: string | null;
  branchCode: string | null;
  routingNumber: string | null;
  swiftCode: string | null;
  logoUrl: string | null;
};

export type UserBankAccountOption = {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  routingNumber: string;
  swiftCode: string;
  branchCode: string;
};

export type UserBankAccountSnapshot = Omit<UserBankAccountOption, 'id'>;

export type MfsPaymentType = 'merchant' | 'send_money' | 'cashout';

export type CompanyMfsAccountOption = {
  id: string;
  mfsName: string;
  accountNumber: string;
  paymentType: MfsPaymentType;
  chargeBps: number;
  chargePercent: number;
  logoUrl: string | null;
  qrCodeUrl: string | null;
};

export type DepositPaymentOptions = {
  branches: DepositBranchOption[];
  receivers: DepositReceiverOption[];
  bankAccounts: CompanyBankAccountOption[];
  mfsAccounts: CompanyMfsAccountOption[];
};

export const MFS_PAYMENT_TYPES: readonly {
  value: MfsPaymentType;
  label: string;
}[] = [
  { value: 'merchant', label: 'Merchant' },
  { value: 'send_money', label: 'Send Money' },
  { value: 'cashout', label: 'Cashout' },
] as const;

export function mfsPaymentTypeLabel(value: MfsPaymentType): string {
  return MFS_PAYMENT_TYPES.find((type) => type.value === value)?.label ?? value;
}

/**
 * Bangladesh Bank's current published MFS provider list.
 * https://www.bb.org.bd/en/index.php/financialsystems/paysystems
 */
export const MFS_PROVIDERS = [
  { value: 'bkash', name: 'bKash', label: 'bKash — bKash Ltd.' },
  { value: 'nagad', name: 'Nagad', label: 'Nagad — Bangladesh Post Office' },
  { value: 'upay', name: 'Upay', label: 'Upay — UCB Fintech Company Ltd.' },
  { value: 'rocket', name: 'Rocket', label: 'Rocket — Dutch-Bangla Bank PLC' },
  { value: 'tap', name: 'tap', label: 'tap — Trust And Pay Ltd.' },
  { value: 'ibbl-mcash', name: 'mCash', label: 'mCash — Islami Bank Bangladesh PLC' },
  { value: 'mycash', name: 'MYCash', label: 'MYCash — Mercantile Bank PLC' },
  { value: 'ok-wallet', name: 'OK Wallet', label: 'OK Wallet — One Bank PLC' },
  { value: 'lenden', name: 'LENDEN', label: 'LENDEN — Prime Bank FinTech Limited' },
  { value: 'telecash', name: 'TeleCash', label: 'TeleCash — Southeast Bank PLC' },
  { value: 'meghna-pay', name: 'Meghna Pay', label: 'Meghna Pay — Meghna Bank PLC' },
  { value: 'firstcash', name: 'FirstCash', label: 'FirstCash — First Security Islami Bank PLC' },
  { value: 'rupalicash', name: 'RUPALICASH', label: 'RUPALICASH — Rupali Bank PLC' },
  { value: 'islamic-wallet', name: 'Islamic Wallet', label: 'Islamic Wallet — Al-Arafah Islami Bank PLC' },
] as const;

export const MFS_PROVIDER_VALUES = MFS_PROVIDERS.map(
  (provider) => provider.value
) as [string, ...string[]];

export function mfsProviderLabel(value: string): string {
  return MFS_PROVIDERS.find((provider) => provider.value === value)?.label ?? value;
}
