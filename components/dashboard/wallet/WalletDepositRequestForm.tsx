'use client';

import Image from 'next/image';
import { FormEvent, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Banknote,
  Building2,
  Landmark,
  Send,
  Smartphone,
} from 'lucide-react';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { DOC_ACCEPT, DOC_HINT } from '@/lib/upload-verify';
import {
  MFS_PAYMENT_TYPES,
  mfsPaymentTypeLabel,
  type CompanyBankAccountOption,
  type DepositPaymentOptions,
  type MfsPaymentType,
  type UserBankAccountOption,
} from '@/lib/wallet/payment-options';

type Props = {
  options: DepositPaymentOptions;
  userBankAccounts: UserBankAccountOption[];
  attachmentsConfigured: boolean;
  submitting: boolean;
  onSubmit: (form: FormData) => Promise<boolean>;
  onAddBankAccount: () => void;
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500';
const LABEL = 'block text-sm font-medium text-navy-950';

function RequiredLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children} <span className="text-brand-orange">*</span>
    </>
  );
}

function AttachmentField({
  required,
  configured,
}: {
  required: boolean;
  configured: boolean;
}) {
  return (
    <label className={LABEL}>
      Attachment{' '}
      {required ? (
        <span className="text-brand-orange">*</span>
      ) : (
        <span className="font-normal text-neutral-400">(optional)</span>
      )}
      <input
        name="attachment"
        type="file"
        required={required}
        disabled={!configured}
        accept={DOC_ACCEPT}
        className={`${CONTROL} cursor-pointer px-2 py-2 file:mr-3 file:rounded-md file:border-0 file:bg-navy-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-navy-950`}
      />
      <span className="mt-1 block text-xs font-normal text-neutral-400">
        {configured ? DOC_HINT : 'Uploads are not configured on this environment.'}
      </span>
    </label>
  );
}

function BankAccountSelect({
  accounts,
}: {
  accounts: CompanyBankAccountOption[];
}) {
  return (
    <label className={LABEL}>
      <RequiredLabel>Kaliganj Travels A/C</RequiredLabel>
      <select
        name="companyBankAccountId"
        required
        disabled={!accounts.length}
        defaultValue=""
        className={CONTROL}
      >
        <option value="" disabled>
          {accounts.length ? 'Select company bank account' : 'No bank account configured'}
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.bankName} — {account.accountName} — {account.accountNumber}
          </option>
        ))}
      </select>
    </label>
  );
}

function UserBankAccountSelect({
  accounts,
  onAddBankAccount,
}: {
  accounts: UserBankAccountOption[];
  onAddBankAccount: () => void;
}) {
  return (
    <label className={LABEL}>
      <RequiredLabel>From Bank Account</RequiredLabel>
      <select
        name="sourceBankAccountId"
        required
        disabled={!accounts.length}
        defaultValue=""
        className={CONTROL}
      >
        <option value="" disabled>
          {accounts.length
            ? 'Select a saved bank account'
            : 'No saved bank account available'}
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.bankName} — {account.accountName} — {account.accountNumber}
          </option>
        ))}
      </select>
      {!accounts.length && (
        <span className="mt-1 block text-xs font-normal text-amber-700">
          Please add a bank account in My Bank Accounts before submitting a bank
          transfer deposit request.{' '}
          <button
            type="button"
            onClick={onAddBankAccount}
            className="font-semibold underline hover:text-amber-900"
          >
            Add Bank Account
          </button>
        </span>
      )}
    </label>
  );
}

function SubmitBar({ disabled, submitting }: { disabled: boolean; submitting: boolean }) {
  return (
    <div className="flex justify-end border-t border-neutral-100 bg-neutral-50/60 px-5 py-4 sm:px-6">
      <button
        disabled={disabled || submitting}
        className="inline-flex min-w-36 items-center justify-center gap-2 rounded-lg bg-brand-orange px-5 py-2.5 text-sm font-bold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Send className="h-4 w-4" />
        {submitting ? 'Submitting...' : 'Submit Request'}
      </button>
    </div>
  );
}

export default function WalletDepositRequestForm({
  options,
  userBankAccounts,
  attachmentsConfigured,
  submitting,
  onSubmit,
  onAddBankAccount,
}: Props) {
  const [grossAmount, setGrossAmount] = useState('');
  const [mfsName, setMfsName] = useState('');
  const [mfsAccountId, setMfsAccountId] = useState('');
  const [mfsPaymentType, setMfsPaymentType] = useState<
    MfsPaymentType | ''
  >('');

  const mfsNames = useMemo(
    () =>
      Array.from(new Set(options.mfsAccounts.map((account) => account.mfsName))).sort(
        (left, right) => left.localeCompare(right)
      ),
    [options.mfsAccounts]
  );
  const availableMfsTypes = useMemo(
    () =>
      MFS_PAYMENT_TYPES.filter((type) =>
        options.mfsAccounts.some(
          (account) =>
            account.mfsName === mfsName && account.paymentType === type.value
        )
      ),
    [mfsName, options.mfsAccounts]
  );
  const matchingMfsAccounts = options.mfsAccounts.filter(
    (account) =>
      account.mfsName === mfsName && account.paymentType === mfsPaymentType
  );

  const selectedMfsAccount = matchingMfsAccounts.length === 1
    ? matchingMfsAccounts[0]
    : matchingMfsAccounts.find((account) => account.id === mfsAccountId);

  const gross = Number(grossAmount);
  const fee = selectedMfsAccount?.chargePercent ?? 0;
  const depositableAmount =
    Number.isFinite(gross) && gross > 0 && Number.isFinite(fee)
      ? Math.max(0, gross - (gross * fee) / 100).toFixed(2)
      : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const saved = await onSubmit(new FormData(form));
    if (!saved) return;

    form.reset();
    setGrossAmount('');
    setMfsName('');
    setMfsAccountId('');
    setMfsPaymentType('');
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
          <Send className="h-4 w-4" />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">Submit deposit request</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Choose a payment method and provide its receipt details for Accounts approval.
          </p>
        </div>
      </div>

      <Tabs defaultValue="cash">
        <div className="overflow-x-auto border-b border-neutral-200">
          <TabsList className="h-auto min-w-max justify-start rounded-none bg-transparent p-0">
            <TabsTrigger
              value="cash"
              className="rounded-none border-b-2 border-transparent px-5 py-3.5 shadow-none data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
            >
              <Banknote className="mr-2 h-4 w-4" /> Cash
            </TabsTrigger>
            <TabsTrigger
              value="bank-deposit"
              className="rounded-none border-b-2 border-transparent px-5 py-3.5 shadow-none data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
            >
              <Landmark className="mr-2 h-4 w-4" /> Bank Deposit
            </TabsTrigger>
            <TabsTrigger
              value="bank-transfer"
              className="rounded-none border-b-2 border-transparent px-5 py-3.5 shadow-none data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" /> Bank Transfer
            </TabsTrigger>
            <TabsTrigger
              value="cheque"
              className="rounded-none border-b-2 border-transparent px-5 py-3.5 shadow-none data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
            >
              <Building2 className="mr-2 h-4 w-4" /> Cheque
            </TabsTrigger>
            <TabsTrigger
              value="mobile"
              className="rounded-none border-b-2 border-transparent px-5 py-3.5 shadow-none data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
            >
              <Smartphone className="mr-2 h-4 w-4" /> Mobile Banking
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="cash" className="mt-0">
          <form onSubmit={submit}>
            <input type="hidden" name="method" value="cash" />
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
              <label className={LABEL}>
                <RequiredLabel>Branch Name</RequiredLabel>
                <select name="branchId" required defaultValue="" className={CONTROL}>
                  <option value="" disabled>Select Kaliganj Travels branch</option>
                  {options.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}{branch.address ? ` — ${branch.address}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                <RequiredLabel>Received by</RequiredLabel>
                <select
                  name="receivedByUserId"
                  required
                  disabled={!options.receivers.length}
                  defaultValue=""
                  className={CONTROL}
                >
                  <option value="" disabled>
                    {options.receivers.length ? 'Select receiver' : 'No eligible receiver found'}
                  </option>
                  {options.receivers.map((receiver) => (
                    <option key={receiver.id} value={receiver.id}>
                      {receiver.name} — {receiver.roleLabel}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                <RequiredLabel>Amount</RequiredLabel>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="0.00"
                  className={CONTROL}
                />
              </label>

              <AttachmentField required={false} configured={attachmentsConfigured} />
            </div>
            <SubmitBar disabled={!options.receivers.length} submitting={submitting} />
          </form>
        </TabsContent>

        <TabsContent value="bank-deposit" className="mt-0">
          <form onSubmit={submit}>
            <input type="hidden" name="method" value="bank" />
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-5">
              <BankAccountSelect accounts={options.bankAccounts} />

              <label className={LABEL}>
                <RequiredLabel>Deposit Date</RequiredLabel>
                <input name="depositDate" type="date" required className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Reference</RequiredLabel>
                <input
                  name="referenceNumber"
                  required
                  maxLength={255}
                  placeholder="Receipt number"
                  className={CONTROL}
                />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Amount</RequiredLabel>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="0.00"
                  className={CONTROL}
                />
              </label>

              <AttachmentField required configured={attachmentsConfigured} />
            </div>
            <SubmitBar
              disabled={!options.bankAccounts.length || !attachmentsConfigured}
              submitting={submitting}
            />
          </form>
        </TabsContent>

        <TabsContent value="bank-transfer" className="mt-0">
          <form onSubmit={submit}>
            <input type="hidden" name="method" value="bank_transfer" />
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
              <UserBankAccountSelect
                accounts={userBankAccounts}
                onAddBankAccount={onAddBankAccount}
              />
              <BankAccountSelect accounts={options.bankAccounts} />

              <label className={LABEL}>
                <RequiredLabel>Deposit Date</RequiredLabel>
                <input name="depositDate" type="date" required className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Reference</RequiredLabel>
                <input
                  name="referenceNumber"
                  required
                  maxLength={255}
                  placeholder="Transfer receipt number"
                  className={CONTROL}
                />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Amount</RequiredLabel>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="0.00"
                  className={CONTROL}
                />
              </label>

              <AttachmentField required configured={attachmentsConfigured} />
            </div>
            <SubmitBar
              disabled={
                !userBankAccounts.length ||
                !options.bankAccounts.length ||
                !attachmentsConfigured
              }
              submitting={submitting}
            />
          </form>
        </TabsContent>

        <TabsContent value="cheque" className="mt-0">
          <form onSubmit={submit}>
            <input type="hidden" name="method" value="cheque" />
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
              <label className={LABEL}>
                <RequiredLabel>Cheque No</RequiredLabel>
                <input name="chequeNo" required maxLength={255} className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Cheque Issued Date</RequiredLabel>
                <input name="chequeIssuedDate" type="date" required className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Cheque Issued Bank</RequiredLabel>
                <input name="chequeIssuedBank" required maxLength={255} className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Payment Date</RequiredLabel>
                <input name="paymentDate" type="date" required className={CONTROL} />
              </label>

              <BankAccountSelect accounts={options.bankAccounts} />

              <label className={LABEL}>
                <RequiredLabel>Amount</RequiredLabel>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="0.00"
                  className={CONTROL}
                />
              </label>

              <AttachmentField required configured={attachmentsConfigured} />
            </div>
            <SubmitBar
              disabled={!options.bankAccounts.length || !attachmentsConfigured}
              submitting={submitting}
            />
          </form>
        </TabsContent>

        <TabsContent value="mobile" className="mt-0">
          <form onSubmit={submit}>
            <input type="hidden" name="method" value="mobile" />
            <input
              type="hidden"
              name="mfsAccountId"
              value={selectedMfsAccount?.id ?? ''}
            />
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
              <label className={LABEL}>
                <RequiredLabel>MFS Provider</RequiredLabel>
                <select
                  required
                  value={mfsName}
                  disabled={!mfsNames.length}
                  onChange={(event) => {
                    setMfsName(event.target.value);
                    setMfsAccountId('');
                    setMfsPaymentType('');
                  }}
                  className={CONTROL}
                >
                  <option value="" disabled>
                    {mfsNames.length
                      ? 'Select mobile banking service'
                      : 'No MFS account configured'}
                  </option>
                  {mfsNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                <RequiredLabel>Payment Type</RequiredLabel>
                <select
                  required
                  value={mfsPaymentType}
                  disabled={!mfsName || !availableMfsTypes.length}
                  onChange={(event) => {
                    setMfsPaymentType(event.target.value as MfsPaymentType);
                    setMfsAccountId('');
                  }}
                  className={CONTROL}
                >
                  <option value="" disabled>
                    {mfsName ? 'Select payment type' : 'Select MFS provider first'}
                  </option>
                  {availableMfsTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </label>

              {matchingMfsAccounts.length > 1 && (
                <label className={LABEL}>
                  <RequiredLabel>Payment Number</RequiredLabel>
                  <select
                    required
                    value={mfsAccountId}
                    onChange={(event) => setMfsAccountId(event.target.value)}
                    className={CONTROL}
                  >
                    <option value="" disabled>Select payment number</option>
                    {matchingMfsAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.accountNumber}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selectedMfsAccount && (
                <div className="rounded-xl border border-navy-100 bg-navy-50/50 p-4 sm:col-span-2 lg:col-span-2">
                  <div className="flex items-center gap-3">
                    {selectedMfsAccount.logoUrl ? (
                      <Image
                        src={selectedMfsAccount.logoUrl}
                        alt={`${selectedMfsAccount.mfsName} logo`}
                        width={48}
                        height={48}
                        unoptimized
                        className="h-12 w-12 rounded-lg border border-neutral-200 bg-white object-contain p-1"
                      />
                    ) : (
                      <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-400">
                        <Smartphone className="h-5 w-5" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="font-bold text-navy-950">
                        {selectedMfsAccount.mfsName}
                      </p>
                      <p className="text-xs text-neutral-500">
                        {mfsPaymentTypeLabel(selectedMfsAccount.paymentType)}
                      </p>
                      <p className="mt-1 font-mono text-sm font-semibold text-navy-950">
                        {selectedMfsAccount.accountNumber}
                      </p>
                    </div>
                    {selectedMfsAccount.qrCodeUrl && (
                      <a
                        href={selectedMfsAccount.qrCodeUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto shrink-0"
                      >
                        <Image
                          src={selectedMfsAccount.qrCodeUrl}
                          alt={`${selectedMfsAccount.mfsName} ${mfsPaymentTypeLabel(selectedMfsAccount.paymentType)} QR code`}
                          width={88}
                          height={88}
                          unoptimized
                          className="h-20 w-20 rounded-lg border border-neutral-200 bg-white object-contain p-1"
                        />
                      </a>
                    )}
                  </div>
                  {selectedMfsAccount.qrCodeUrl && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Scan the QR code or use the payment number above.
                    </p>
                  )}
                </div>
              )}

              <label className={LABEL}>
                <RequiredLabel>Amount</RequiredLabel>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={grossAmount}
                  onChange={(event) => setGrossAmount(event.target.value)}
                  placeholder="0.00"
                  className={CONTROL}
                />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Transaction ID</RequiredLabel>
                <input name="transactionId" required maxLength={255} className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Deposit Date</RequiredLabel>
                <input name="depositDate" type="date" required className={CONTROL} />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Gateway Fee (%)</RequiredLabel>
                <input
                  name="gatewayFeePercent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  required
                  readOnly
                  value={selectedMfsAccount ? fee.toFixed(2) : ''}
                  placeholder="Select payment type"
                  className={`${CONTROL} bg-navy-50 font-semibold text-navy-950`}
                />
              </label>

              <label className={LABEL}>
                <RequiredLabel>Depositable Amount</RequiredLabel>
                <input
                  name="depositableAmount"
                  readOnly
                  required
                  value={depositableAmount}
                  placeholder="0.00"
                  className={`${CONTROL} bg-navy-50 font-semibold text-navy-950`}
                />
              </label>

              <AttachmentField required configured={attachmentsConfigured} />
            </div>
            <SubmitBar
              disabled={!attachmentsConfigured || !selectedMfsAccount}
              submitting={submitting}
            />
          </form>
        </TabsContent>
      </Tabs>
    </section>
  );
}
