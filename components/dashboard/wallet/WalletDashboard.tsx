'use client';

import {
  ArrowDownToLine,
  Building2,
  Clock3,
  CreditCard,
  LockKeyhole,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import SavedBankAccountManager from '@/components/dashboard/wallet/SavedBankAccountManager';
import WalletDepositRequestForm from '@/components/dashboard/wallet/WalletDepositRequestForm';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import type {
  DepositPaymentOptions,
  UserBankAccountOption,
} from '@/lib/wallet/payment-options';

type Summary = {
  walletId: string;
  accountId: string;
  ownerType: 'user' | 'agency';
  ownerKey: string;
  status: 'active' | 'frozen';
  currency: string;
  availableBalance: number;
  holdBalance: number;
  totalBalance: number;
};

type Deposit = {
  id: string;
  public_ref: string;
  amount: number;
  currency: string;
  method: string;
  reference_number: string | null;
  attachment_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  review_remarks: string | null;
  requested_at: string;
};

export type WalletTab =
  | 'submit-request'
  | 'transaction'
  | 'bank-accounts'
  | 'partner-bank'
  | 'online-deposit';

type Props = {
  initialTab?: WalletTab;
  savedBankAccounts: UserBankAccountOption[];
  savedBankAccountsUnavailable?: boolean;
  agencyWallet?: boolean;
  paymentOptions: DepositPaymentOptions;
  attachmentsConfigured: boolean;
};

const WALLET_TABS: { value: WalletTab; label: string }[] = [
  { value: 'submit-request', label: 'Submit Request' },
  { value: 'online-deposit', label: 'Online Deposit' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'bank-accounts', label: 'My Bank Accounts' },
  { value: 'partner-bank', label: 'Partner Bank Details' },
];

const ONLINE_DEPOSIT_PROVIDERS = [
  { name: 'bKash', mark: 'b', iconClass: 'bg-[#e2136e] text-white' },
  { name: 'Nagad', mark: 'N', iconClass: 'bg-[#f26522] text-white' },
  { name: 'Upay', mark: 'U', iconClass: 'bg-[#ffd200] text-[#b21f2d]' },
  { name: 'Rocket', mark: 'R', iconClass: 'bg-[#8b2a85] text-white' },
  { name: 'tap', mark: 'tap', iconClass: 'bg-[#112b62] text-[#f9d71c]' },
  { name: 'mCash', mark: 'm', iconClass: 'bg-[#ed1c24] text-white' },
  { name: 'MYCash', mark: 'MY', iconClass: 'bg-[#009688] text-white' },
  { name: 'OK Wallet', mark: 'OK', iconClass: 'bg-[#32a852] text-white' },
  { name: 'LENDEN', mark: 'L', iconClass: 'bg-[#1d4ed8] text-white' },
  { name: 'TeleCash', mark: 'T', iconClass: 'bg-[#ef7d00] text-white' },
  { name: 'Meghna Pay', mark: 'MP', iconClass: 'bg-[#143d70] text-white' },
] as const;

function money(minor: number, currency = 'BDT') {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

function statusClass(status: Deposit['status']) {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-700';
  if (status === 'rejected') return 'bg-red-50 text-red-700';
  return 'bg-amber-50 text-amber-700';
}

function depositDateTime(value: string): { date: string; time: string } {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return { date: value, time: '' };
  return {
    date: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(timestamp),
    time: new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dhaka',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(timestamp),
  };
}

export default function WalletDashboard({
  initialTab = 'submit-request',
  savedBankAccounts,
  savedBankAccountsUnavailable = false,
  agencyWallet = false,
  paymentOptions,
  attachmentsConfigured,
}: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WalletTab>(initialTab);
  const [bankAccounts, setBankAccounts] = useState<UserBankAccountOption[]>(
    savedBankAccounts
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [walletResponse, depositResponse] = await Promise.all([
        fetch('/api/wallet', { cache: 'no-store' }),
        fetch('/api/wallet/deposits', { cache: 'no-store' }),
      ]);
      const walletBody = await walletResponse.json();
      const depositBody = await depositResponse.json();
      if (!walletResponse.ok) {
        throw new Error(
          walletBody.error?.errorMessage || 'Wallet could not be loaded.'
        );
      }
      if (!depositResponse.ok) {
        throw new Error(
          depositBody.error?.errorMessage ||
            'Deposit requests could not be loaded.'
        );
      }
      setSummary(walletBody.data.summary);
      setDeposits(depositBody.data?.requests ?? []);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Wallet could not be loaded.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitDeposit(form: FormData): Promise<boolean> {
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch('/api/wallet/deposits', {
        method: 'POST',
        body: form,
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.errorMessage || 'Deposit request failed.');
      }
      setNotice('Deposit request submitted for approval.');
      await load();
      return true;
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Deposit request failed.'
      );
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !summary) {
    return (
      <p className="rounded-xl bg-white p-8 text-sm text-neutral-500">
        Loading wallet&hellip;
      </p>
    );
  }

  const cards: { label: string; amount: number; icon: LucideIcon }[] = summary
    ? [
        {
          label: 'Available Balance',
          amount: summary.availableBalance,
          icon: Wallet,
        },
        { label: 'Hold Balance', amount: summary.holdBalance, icon: Clock3 },
        {
          label: 'Total Balance',
          amount: summary.totalBalance,
          icon: ArrowDownToLine,
        },
      ]
    : [];

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        <h1 className="sr-only">
          {summary?.ownerType === 'agency' ? 'Payment Request' : 'Wallet'}
        </h1>
        {summary && (
          <div className="grid flex-1 gap-3 sm:grid-cols-3">
            {cards.map(({ label, amount, icon: Icon }) => (
              <div
                key={label}
                className="rounded-xl bg-brand-orange px-4 py-3.5 text-black shadow-sm"
              >
                <div className="flex items-center justify-between text-black/75">
                  <p className="text-[11px] font-semibold uppercase tracking-wide">
                    {label}
                  </p>
                  <Icon className="h-4 w-4" />
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums">
                  {money(amount, summary.currency)}
                </p>
                <p className="mt-1.5 truncate text-[11px] capitalize text-black/75">
                  {summary.ownerType === 'agency'
                    ? `Agency ${summary.ownerKey}`
                    : 'Personal wallet'}{' '}
                  &middot; {summary.status}
                </p>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 self-end rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 transition hover:border-navy-200 hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-60 lg:self-center"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as WalletTab)} className="space-y-5">
        <div className="overflow-x-auto rounded-xl border border-navy-100 bg-white shadow-sm">
          <TabsList className="h-auto min-w-max justify-start rounded-none bg-transparent p-0">
            {WALLET_TABS.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded-none border-b-2 border-transparent px-5 py-4 text-sm font-semibold text-neutral-600 shadow-none transition hover:bg-navy-50 hover:text-navy-950 data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {notice && (
          <p
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {notice}
          </p>
        )}

        <TabsContent value="submit-request" className="mt-0">
          <WalletDepositRequestForm
            options={paymentOptions}
            userBankAccounts={bankAccounts}
            attachmentsConfigured={attachmentsConfigured}
            submitting={submitting}
            onSubmit={submitDeposit}
            onAddBankAccount={() => setActiveTab('bank-accounts')}
          />
        </TabsContent>

        <TabsContent value="transaction" className="mt-0 space-y-5">
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="font-bold text-navy-950">Deposit requests</h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Track submitted payment requests and their approval status.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-navy-50 text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Method</th>
                    <th className="px-4 py-3">Reference</th>
                    <th className="px-4 py-3">Deposit Receipt</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-10 text-center text-neutral-500"
                      >
                        No deposit requests yet.
                      </td>
                    </tr>
                  ) : (
                    deposits.map((deposit) => {
                      const submittedAt = depositDateTime(deposit.requested_at);
                      return (
                      <tr key={deposit.id} className="border-t border-neutral-100">
                        <td className="px-4 py-3">
                          <span className="block text-navy-950">
                            {submittedAt.date}
                          </span>
                          <span className="mt-0.5 block text-xs text-neutral-500">
                            {submittedAt.time}
                          </span>
                        </td>
                        <td className="px-4 py-3 capitalize">
                          {deposit.method === 'bank'
                            ? 'Bank deposit'
                            : deposit.method === 'bank_transfer'
                              ? 'Bank transfer'
                            : deposit.method === 'mobile'
                              ? 'Mobile banking'
                              : deposit.method}
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs font-bold text-navy-950">
                            {deposit.public_ref}
                          </span>
                          {deposit.reference_number && (
                            <span className="mt-1 block text-xs text-neutral-500">
                              Payment: {deposit.reference_number}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {deposit.attachment_url ? (
                            <a
                              href={deposit.attachment_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex rounded-md border border-navy-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-700 transition hover:bg-navy-50 hover:text-navy-950"
                            >
                              View Receipt
                            </a>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {money(deposit.amount, deposit.currency)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusClass(deposit.status)}`}
                          >
                            {deposit.status}
                          </span>
                          {deposit.status === 'rejected' &&
                            deposit.review_remarks && (
                              <p className="mt-2 max-w-64 text-xs leading-5 text-red-700">
                                <span className="font-semibold">Cause:</span>{' '}
                                {deposit.review_remarks}
                              </p>
                            )}
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

        </TabsContent>

        <TabsContent value="bank-accounts" className="mt-0">
          <SavedBankAccountManager
            accounts={bankAccounts}
            agencyWallet={agencyWallet}
            unavailable={savedBankAccountsUnavailable}
            onAccountsChange={setBankAccounts}
          />
        </TabsContent>

        <TabsContent value="partner-bank" className="mt-0">
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
                <Building2 className="h-4 w-4" />
              </span>
              <div>
                <h2 className="font-bold text-navy-950">Partner Bank Details</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Active Kaliganj Travels accounts available for deposits and transfers.
                </p>
              </div>
            </div>

            {paymentOptions.bankAccounts.length ? (
              <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
                {paymentOptions.bankAccounts.map((account) => (
                  <article key={account.id} className="rounded-lg border border-navy-100 bg-navy-50/50 p-4">
                    <div className="flex items-center gap-3">
                      <span
                        role={account.logoUrl ? 'img' : undefined}
                        aria-label={account.logoUrl ? `${account.bankName} logo` : undefined}
                        style={account.logoUrl ? {
                          backgroundImage: `url("${account.logoUrl}")`,
                          backgroundPosition: 'center',
                          backgroundRepeat: 'no-repeat',
                          backgroundSize: 'contain',
                        } : undefined}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-navy-300"
                      >
                        {!account.logoUrl && <Building2 className="h-5 w-5" />}
                      </span>
                      <p className="font-bold text-navy-950">{account.bankName}</p>
                    </div>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div><dt className="text-xs text-neutral-400">Account name</dt><dd className="font-semibold text-navy-950">{account.accountName}</dd></div>
                      <div><dt className="text-xs text-neutral-400">Account number</dt><dd className="font-mono font-semibold text-navy-950">{account.accountNumber}</dd></div>
                      {account.branchName && <div><dt className="text-xs text-neutral-400">Branch</dt><dd>{account.branchName}</dd></div>}
                      {account.branchCode && <div><dt className="text-xs text-neutral-400">Branch code</dt><dd>{account.branchCode}</dd></div>}
                      {account.routingNumber && <div><dt className="text-xs text-neutral-400">Routing number</dt><dd>{account.routingNumber}</dd></div>}
                      {account.swiftCode && <div><dt className="text-xs text-neutral-400">SWIFT code</dt><dd>{account.swiftCode}</dd></div>}
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <div className="px-5 py-12 text-center sm:px-6">
                <Building2 className="mx-auto h-10 w-10 text-navy-200" />
                <p className="mx-auto mt-3 max-w-lg text-sm text-neutral-500">
                  No company bank account is configured yet. Contact the Accounts team before transferring funds.
                </p>
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="online-deposit" className="mt-0">
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
                  <CreditCard className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="font-bold text-navy-950">Online Deposit</h2>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Choose a mobile financial service to deposit directly into
                    your wallet.
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                Coming soon
              </span>
            </div>

            <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-3 xl:grid-cols-4">
              {ONLINE_DEPOSIT_PROVIDERS.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  disabled
                  aria-label={`${provider.name} online deposit is not available yet`}
                  className="flex cursor-not-allowed items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50/70 p-3.5 text-left opacity-70"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-base font-black shadow-sm ${provider.iconClass}`}
                  >
                    {provider.mark}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold text-navy-950">
                      {provider.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-neutral-400">
                      API integration pending
                    </span>
                  </span>
                  <LockKeyhole
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-neutral-300"
                  />
                </button>
              ))}
            </div>

            <p className="border-t border-neutral-100 bg-neutral-50/60 px-5 py-4 text-xs text-neutral-500 sm:px-6">
              All online deposit methods are temporarily disabled. Providers
              will be enabled individually after registration and API approval.
            </p>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
