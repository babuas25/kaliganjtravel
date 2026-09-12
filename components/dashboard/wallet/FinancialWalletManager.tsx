'use client';

import {
  Activity,
  Building2,
  Check,
  ChevronsUpDown,
  Inbox,
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  WalletCards,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import CompanyBankAccountManager from '@/components/dashboard/wallet/CompanyBankAccountManager';
import CompanyMfsAccountManager from '@/components/dashboard/wallet/CompanyMfsAccountManager';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import type { UserBankAccountSnapshot } from '@/lib/wallet/payment-options';

type WalletRow = {
  walletId: string;
  accountId: string;
  ownerType: 'user' | 'agency';
  ownerKey: string;
  ownerName: string;
  status: 'active' | 'frozen';
  currency: string;
  availableBalance: number;
  holdBalance: number;
  totalBalance: number;
};

type QueueRow = {
  id: string;
  public_ref?: string;
  wallet_account_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: string;
  requested_at: string;
  reviewed_at?: string | null;
  reviewed_by_user_id?: string | null;
  review_remarks?: string | null;
  adjustment_type?: 'credit' | 'debit';
  reason?: string;
  requested_by_role?: string;
  method?: string;
  reference_number?: string | null;
  deposit_date?: string | null;
  attachment_url?: string | null;
  user_bank_account?: UserBankAccountSnapshot | null;
  company_bank_account?: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    branchName: string | null;
    branchCode: string | null;
    routingNumber: string | null;
    swiftCode: string | null;
  } | null;
  requester?: {
    name: string | null;
    agencyCode: string | null;
    agencyName: string | null;
  };
  /** The wallet owner receiving an internal adjustment. */
  target?: {
    type: 'agency' | 'user';
    name: string | null;
    agencyCode: string | null;
  };
  reviewer?: { name: string | null } | null;
};

type LedgerRow = {
  id: string;
  ownerType?: string;
  ownerKey?: string;
  ownerName?: string | null;
  transactionType: string;
  amount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  holdBefore: number;
  holdAfter: number;
  bookingReference: string | null;
  createdByUserId: string;
  createdAt: string;
  deposit?: {
    method: 'cash' | 'bank' | 'bank_transfer' | 'mobile' | 'cheque';
    publicRef: string;
  } | null;
  adjustment?: {
    publicRef: string;
  } | null;
  processedBy?: {
    name: string | null;
    role: string | null;
  } | null;
};

type QueueKind = 'deposits' | 'adjustments';

type TabDefinition = {
  value: string;
  label: string;
  icon: LucideIcon;
  count?: number;
};

function money(value: number, currency = 'BDT') {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function moneyAmount(value: number) {
  return new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

function queueMethodLabel(row: QueueRow) {
  if (row.adjustment_type) return row.adjustment_type;
  if (row.method === 'bank_transfer') return 'Bank transfer';
  if (row.method === 'bank') return 'Bank deposit';
  return row.method ?? 'Request';
}

function depositMethodLabel(method: NonNullable<LedgerRow['deposit']>['method']) {
  switch (method) {
    case 'cash':
      return 'Cash Deposit';
    case 'bank':
      return 'Bank Deposit';
    case 'bank_transfer':
      return 'Bank Transfer';
    case 'mobile':
      return 'Mobile Banking';
    case 'cheque':
      return 'Cheque Deposit';
  }
}

function activityTypeLabel(transactionType: string) {
  if (transactionType === 'booking_confirm') return 'Ticketed';
  if (transactionType === 'superadmin_resolution_credit') {
    return 'Super Admin Resolution Credit';
  }
  if (transactionType === 'superadmin_resolution_debit') {
    return 'Super Admin Resolution Debit';
  }
  if (transactionType === 'superadmin_resolution_hold_release') {
    return 'Super Admin Hold Release';
  }
  if (transactionType === 'superadmin_resolution_hold_capture') {
    return 'Super Admin Hold Capture';
  }
  return transactionType.replaceAll('_', ' ');
}

function activityAmountClass(entry: LedgerRow) {
  if (
    entry.transactionType === 'deposit' ||
    entry.transactionType === 'manual_credit' ||
    entry.transactionType === 'superadmin_resolution_credit' ||
    entry.transactionType === 'superadmin_resolution_hold_release' ||
    entry.transactionType === 'refund'
  ) {
    return 'text-green-600';
  }
  if (
    entry.transactionType === 'booking_confirm' ||
    entry.transactionType === 'manual_debit' ||
    entry.transactionType === 'superadmin_resolution_debit' ||
    entry.transactionType === 'superadmin_resolution_hold_capture'
  ) {
    return 'text-red-600';
  }
  const totalBefore = entry.availableBefore + entry.holdBefore;
  const totalAfter = entry.availableAfter + entry.holdAfter;
  if (totalAfter > totalBefore) return 'text-green-600';
  if (totalAfter < totalBefore) return 'text-red-600';
  return 'text-navy-950';
}

function bankAccountLabel(account: {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchName?: string | null;
}) {
  return [
    account.bankName,
    account.accountName,
    account.accountNumber,
    account.branchName,
  ]
    .filter(Boolean)
    .join(' · ');
}

function requesterLabel(row: QueueRow) {
  return row.requester?.name || row.requested_by_user_id;
}

function reviewerLabel(row: QueueRow) {
  return row.reviewer?.name || row.reviewed_by_user_id || '—';
}

function dateTimeParts(value: string | null | undefined) {
  if (!value) return { date: '—', time: '' };
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

function displayDateTime(value: string | null | undefined) {
  const { date, time } = dateTimeParts(value);
  return time ? `${date}, ${time}` : date;
}

function agencyLabel(row: QueueRow, accountOwner: (accountId: string) => string) {
  const agencyName = row.requester?.agencyName;
  const agencyCode = row.requester?.agencyCode;
  if (agencyName && agencyCode) return `Agency: ${agencyName} (${agencyCode})`;
  if (agencyName) return `Agency: ${agencyName}`;
  if (agencyCode) return `Agency: ${agencyCode}`;
  return accountOwner(row.wallet_account_id);
}

function requestTarget(
  row: QueueRow,
  accountOwner: (accountId: string) => string
) {
  if (row.target) {
    return {
      label: row.target.name || 'Unnamed wallet',
      type: row.target.type === 'agency' ? 'Agency wallet' : 'Customer wallet',
      agencyCode: row.target.agencyCode,
    };
  }

  const agencyName = row.requester?.agencyName;
  const agencyCode = row.requester?.agencyCode;
  if (agencyName || agencyCode) {
    return {
      label: agencyName || 'Agency name not set',
      type: 'Agency wallet',
      agencyCode,
    };
  }

  return {
    label: accountOwner(row.wallet_account_id),
    type: 'Customer wallet',
    agencyCode: null,
  };
}

function financialRoleLabel(role: string | undefined) {
  switch (role) {
    case 'superadmin':
      return 'Super Admin';
    case 'admin':
      return 'Admin';
    case 'staff':
      return 'Staff';
    default:
      return null;
  }
}

function WalletPicker({
  wallets,
  value,
  onValueChange,
}: {
  wallets: WalletRow[];
  value: string;
  onValueChange: (accountId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = wallets.find((wallet) => wallet.accountId === value);

  return (
    <>
      <input type="hidden" name="accountId" value={value} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label="Select wallet"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm outline-none transition hover:bg-neutral-50 focus:ring-2 focus:ring-navy-200"
          >
            {selected ? (
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-navy-950">
                  {selected.ownerName}
                </span>
                <span className="block truncate text-xs text-neutral-500">
                  ID: {selected.ownerKey}
                </span>
                <span className="block text-xs font-semibold tabular-nums text-navy-700">
                  {money(selected.availableBalance, selected.currency)}
                </span>
              </span>
            ) : (
              <span className="text-neutral-500">Select wallet</span>
            )}
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-neutral-400" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command>
            <CommandInput placeholder="Search agency name or ID..." />
            <CommandList>
              <CommandEmpty>No wallet found.</CommandEmpty>
              {wallets.map((wallet) => (
                <CommandItem
                  key={wallet.accountId}
                  value={`${wallet.ownerName} ${wallet.ownerKey}`}
                  onSelect={() => {
                    onValueChange(wallet.accountId);
                    setOpen(false);
                  }}
                  className="items-start gap-2 px-3 py-2.5 data-[selected=true]:!bg-navy-50 data-[selected=true]:!text-navy-950"
                >
                  <Check
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      value === wallet.accountId ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-navy-950">
                      {wallet.ownerName}
                    </span>
                    <span className="block break-all text-xs text-neutral-500">
                      ID: {wallet.ownerKey}
                    </span>
                    <span className="mt-0.5 block text-xs font-semibold tabular-nums text-navy-700">
                      {money(wallet.availableBalance, wallet.currency)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const text = await response.text();
  let body: {
    success?: boolean;
    data?: Record<string, unknown>;
    error?: { errorMessage?: string };
  };

  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('The Accounts service returned an invalid response.');
  }

  if (!response.ok || body.success === false) {
    throw new Error(body.error?.errorMessage || 'Wallet operation failed.');
  }
  return body.data ?? {};
}

function QueuePanel({
  title,
  hint,
  emptyMessage,
  rows,
  kind,
  busy,
  accountOwner,
  onReview,
  canReview = true,
}: {
  title: string;
  hint: string;
  emptyMessage: string;
  rows: QueueRow[];
  kind: QueueKind;
  busy: string | null;
  accountOwner: (accountId: string) => string;
  onReview: (
    kind: QueueKind,
    id: string,
    decision: 'approved' | 'rejected',
    remarks?: string
  ) => Promise<boolean>;
  canReview?: boolean;
}) {
  const [rejecting, setRejecting] = useState<QueueRow | null>(null);
  const [rejectionCause, setRejectionCause] = useState('');

  function closeRejection() {
    setRejecting(null);
    setRejectionCause('');
  }

  async function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rejecting) return;
    const saved = await onReview(
      kind,
      rejecting.id,
      'rejected',
      rejectionCause.trim()
    );
    if (saved) closeRejection();
  }

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 className="font-bold text-navy-950">{title}</h2>
            <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>
          </div>
          <span className="rounded-full bg-navy-50 px-2.5 py-1 text-xs font-bold text-navy-950">
            {rows.length} pending
          </span>
        </div>

        <div className="space-y-4 bg-neutral-50/70 p-4 sm:p-5">
          {rows.length === 0 ? (
            <p className="rounded-lg bg-white px-5 py-12 text-center text-sm text-neutral-500">
              {emptyMessage}
            </p>
          ) : (
            rows.map((row) => {
              const target = requestTarget(row, accountOwner);
              const requesterRole = financialRoleLabel(row.requested_by_role);
              return (
                <article
                key={row.id}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm transition hover:border-navy-200 hover:shadow-md"
              >
                <div className="p-3.5 sm:px-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                          {target.type}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-bold text-navy-950">
                            {target.label}
                          </h3>
                          {target.agencyCode && (
                            <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-600">
                              {target.agencyCode}
                            </span>
                          )}
                          <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-navy-700">
                            {queueMethodLabel(row)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-neutral-600">
                          <span className="font-medium text-neutral-500">Requested by:</span>{' '}
                          <span className="font-semibold text-navy-950">
                            {requesterLabel(row)}
                          </span>
                          {requesterRole && (
                            <span className="text-neutral-500"> · {requesterRole}</span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 xl:justify-end">
                      <div className="mr-1 xl:text-right">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                          Amount
                        </p>
                        <p className="whitespace-nowrap text-base font-bold tabular-nums text-navy-950">
                          {money(row.amount, row.currency)}
                        </p>
                      </div>
                      {canReview ? (
                        <>
                          <button
                            type="button"
                            disabled={busy === row.id}
                            onClick={() => void onReview(kind, row.id, 'approved')}
                            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy === row.id}
                            onClick={() => setRejecting(row)}
                            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-950 transition hover:bg-neutral-50 disabled:opacity-60"
                          >
                            Reject
                          </button>
                        </>
                      ) : (
                        <span className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-500">
                          Read only
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-neutral-100 pt-2.5 text-xs text-neutral-600">
                    <span className="whitespace-nowrap">
                      <span className="font-medium text-neutral-400">Request:</span>{' '}
                      <span className="font-mono font-bold text-navy-950">
                        {row.public_ref ?? '—'}
                      </span>
                    </span>
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-neutral-400">Ref:</span>{' '}
                      <span className="font-semibold text-navy-950">
                        {row.reference_number ?? '—'}
                      </span>
                    </span>
                    {row.deposit_date && (
                      <span className="whitespace-nowrap">
                        <span className="font-medium text-neutral-400">Date:</span>{' '}
                        <span className="font-semibold text-navy-950">{row.deposit_date}</span>
                      </span>
                    )}
                    {(row.method === 'bank' || row.method === 'bank_transfer') && (
                      <>
                        <span className="min-w-0 truncate rounded-md bg-neutral-50 px-2 py-1">
                          <span className="font-bold text-neutral-500">From:</span>{' '}
                          <span className="font-semibold text-navy-950">
                            {row.user_bank_account
                              ? bankAccountLabel(row.user_bank_account)
                              : row.method === 'bank'
                                ? 'Cash deposit'
                                : 'Not available'}
                          </span>
                        </span>
                        <span className="min-w-0 truncate rounded-md bg-navy-50 px-2 py-1">
                          <span className="font-bold text-navy-600">To:</span>{' '}
                          <span className="font-semibold text-navy-950">
                            {row.company_bank_account
                              ? bankAccountLabel(row.company_bank_account)
                              : 'Not available'}
                          </span>
                        </span>
                      </>
                    )}
                    {row.attachment_url ? (
                      <a
                        href={row.attachment_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-bold text-navy-700 underline underline-offset-2 hover:text-navy-950"
                      >
                        View receipt
                      </a>
                    ) : null}
                    {row.reason && (
                      <span className="min-w-0 truncate text-neutral-500">
                        <span className="font-semibold text-neutral-700">Note:</span>{' '}
                        {row.reason}
                      </span>
                    )}
                  </div>
                </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      <Dialog
        open={Boolean(rejecting)}
        onOpenChange={(open) => {
          if (!open && busy !== rejecting?.id) closeRejection();
        }}
      >
        <DialogContent>
          <form onSubmit={reject} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Reject request</DialogTitle>
              <DialogDescription>
                Enter the cause for rejecting{' '}
                <span className="font-semibold text-navy-950">
                  {rejecting?.public_ref ?? 'this request'}
                </span>
                . The user will see this explanation.
              </DialogDescription>
            </DialogHeader>
            <label className="block text-sm font-medium text-navy-950">
              Rejection cause <span className="text-brand-orange">*</span>
              <textarea
                autoFocus
                required
                minLength={3}
                maxLength={1000}
                value={rejectionCause}
                onChange={(event) => setRejectionCause(event.target.value)}
                placeholder="Explain why this request is being rejected"
                className="mt-1.5 min-h-28 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-navy-400 focus:ring-2 focus:ring-navy-100"
              />
              <span className="mt-1 block text-right text-xs text-neutral-400">
                {rejectionCause.length}/1000
              </span>
            </label>
            <DialogFooter className="gap-2 sm:space-x-0">
              <button
                type="button"
                disabled={busy === rejecting?.id}
                onClick={closeRejection}
                className="rounded-lg border border-neutral-200 px-4 py-2.5 text-sm font-semibold text-navy-950 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                disabled={
                  busy === rejecting?.id || rejectionCause.trim().length < 3
                }
                className="rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 disabled:opacity-60"
              >
                {busy === rejecting?.id ? 'Rejecting...' : 'Reject Request'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DepositHistoryPanel({
  rows,
  status,
  accountOwner,
  busy,
  onResendDecisionEmail,
  canResend = true,
}: {
  rows: QueueRow[];
  status: 'approved' | 'rejected';
  accountOwner: (accountId: string) => string;
  busy: string | null;
  onResendDecisionEmail: (id: string) => Promise<void>;
  canResend?: boolean;
}) {
  const approved = status === 'approved';
  const title = approved ? 'Approved deposit requests' : 'Rejected deposit requests';
  const emptyMessage = approved
    ? 'No approved deposit requests yet.'
    : 'No rejected deposit requests yet.';

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
        <div>
          <h2 className="font-bold text-navy-950">{title}</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Historical requests remain available with their receipt, bank details, and review record.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            approved
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {rows.length} {approved ? 'approved' : 'rejected'}
        </span>
      </div>

      <div className="divide-y divide-neutral-100">
        {rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-neutral-500">{emptyMessage}</p>
        ) : (
          rows.map((row) => (
            <article key={row.id} className="p-4 sm:px-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      approved
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-red-50 text-red-700'
                    }`}
                  >
                    <Building2 className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-bold text-navy-950">
                        {agencyLabel(row, accountOwner)}
                      </h3>
                      <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-navy-700">
                        {queueMethodLabel(row)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-600">
                      <span className="font-medium text-neutral-500">Requested by:</span>{' '}
                      <span className="font-semibold text-navy-950">{requesterLabel(row)}</span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 lg:justify-end">
                  <div className="lg:text-right">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400">Amount</p>
                    <p className="whitespace-nowrap text-base font-bold tabular-nums text-navy-950">
                      {money(row.amount, row.currency)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${
                      approved
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-red-50 text-red-700'
                    }`}
                  >
                    {status}
                  </span>
                  {canResend && (
                    <button
                      type="button"
                      disabled={busy === `email:${row.id}`}
                      onClick={() => void onResendDecisionEmail(row.id)}
                      className="rounded-md border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-700 transition hover:bg-navy-50 hover:text-navy-950 disabled:opacity-60"
                    >
                      {busy === `email:${row.id}` ? 'Sending…' : 'Resend email'}
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-neutral-100 pt-2.5 text-xs text-neutral-600">
                <span className="whitespace-nowrap">
                  <span className="font-medium text-neutral-400">Request:</span>{' '}
                  <span className="font-mono font-bold text-navy-950">{row.public_ref ?? '—'}</span>
                </span>
                <span className="min-w-0 truncate">
                  <span className="font-medium text-neutral-400">Ref:</span>{' '}
                  <span className="font-semibold text-navy-950">{row.reference_number ?? '—'}</span>
                </span>
                {row.deposit_date && (
                  <span className="whitespace-nowrap">
                    <span className="font-medium text-neutral-400">Deposit date:</span>{' '}
                    <span className="font-semibold text-navy-950">{row.deposit_date}</span>
                  </span>
                )}
                <span className="whitespace-nowrap">
                  <span className="font-medium text-neutral-400">Reviewed:</span>{' '}
                  <span className="font-semibold text-navy-950">{displayDateTime(row.reviewed_at)}</span>
                </span>
                <span className="min-w-0 truncate">
                  <span className="font-medium text-neutral-400">By:</span>{' '}
                  <span className="font-semibold text-navy-950">{reviewerLabel(row)}</span>
                </span>
                {(row.method === 'bank' || row.method === 'bank_transfer') && (
                  <>
                    <span className="min-w-0 truncate rounded-md bg-neutral-50 px-2 py-1">
                      <span className="font-bold text-neutral-500">From:</span>{' '}
                      <span className="font-semibold text-navy-950">
                        {row.user_bank_account
                          ? bankAccountLabel(row.user_bank_account)
                          : row.method === 'bank'
                            ? 'Cash deposit'
                            : 'Not available'}
                      </span>
                    </span>
                    <span className="min-w-0 truncate rounded-md bg-navy-50 px-2 py-1">
                      <span className="font-bold text-navy-600">To:</span>{' '}
                      <span className="font-semibold text-navy-950">
                        {row.company_bank_account
                          ? bankAccountLabel(row.company_bank_account)
                          : 'Not available'}
                      </span>
                    </span>
                  </>
                )}
                {row.attachment_url ? (
                  <a
                    href={row.attachment_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-bold text-navy-700 underline underline-offset-2 hover:text-navy-950"
                  >
                    View receipt
                  </a>
                ) : null}
              </div>

              {row.review_remarks && (
                <p
                  className={`mt-2 rounded-md px-2.5 py-2 text-xs leading-5 ${
                    approved
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-red-50 text-red-800'
                  }`}
                >
                  <span className="font-bold">{approved ? 'Review note:' : 'Rejection reason:'}</span>{' '}
                  {row.review_remarks}
                </p>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export default function FinancialWalletManager({
  canManageBankAccounts = false,
  canMutateWallets = true,
  canRefundBookings = false,
}: {
  canManageBankAccounts?: boolean;
  canMutateWallets?: boolean;
  canRefundBookings?: boolean;
}) {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [deposits, setDeposits] = useState<QueueRow[]>([]);
  const [adjustments, setAdjustments] = useState<QueueRow[]>([]);
  const [transactions, setTransactions] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [walletData, depositData, adjustmentData, reportData] =
        await Promise.all([
          api('/api/wallet/admin'),
          api('/api/wallet/deposits'),
          api('/api/wallet/adjustments'),
          api('/api/wallet/reports'),
        ]);
      setWallets((walletData.wallets as WalletRow[] | undefined) ?? []);
      setDeposits((depositData.requests as QueueRow[] | undefined) ?? []);
      setAdjustments(
        (adjustmentData.requests as QueueRow[] | undefined) ?? []
      );
      setTransactions(
        (reportData.transactions as LedgerRow[] | undefined) ?? []
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Wallet data could not be loaded.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      wallets.reduce(
        (sum, wallet) => ({
          available: sum.available + wallet.availableBalance,
          hold: sum.hold + wallet.holdBalance,
          total: sum.total + wallet.totalBalance,
        }),
        { available: 0, hold: 0, total: 0 }
      ),
    [wallets]
  );

  const pendingDeposits = deposits.filter((row) => row.status === 'pending');
  const approvedDeposits = deposits.filter((row) => row.status === 'approved');
  const rejectedDeposits = deposits.filter((row) => row.status === 'rejected');
  const completedActivity = transactions.filter(
    (entry) => entry.transactionType !== 'booking_hold'
  );
  const pendingAdjustments = adjustments.filter(
    (row) => row.status === 'pending'
  );

  async function createAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy('new-adjustment');
    setNotice(null);
    try {
      await api('/api/wallet/adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: String(form.get('accountId')),
          adjustmentType: form.get('adjustmentType'),
          amount: form.get('amount'),
          reason: form.get('reason'),
        }),
      });
      formElement.reset();
      setSelectedAccountId('');
      setNotice(
        'Adjustment submitted. A different financial operator must approve it.'
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Adjustment failed.');
    } finally {
      setBusy(null);
    }
  }

  async function refundBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy('refund-booking');
    setNotice(null);
    try {
      await api('/api/wallet/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingReference: String(form.get('bookingReference'))
            .trim()
            .toUpperCase(),
          amount: form.get('amount'),
          requestId: crypto.randomUUID(),
          remarks: form.get('remarks'),
        }),
      });
      formElement.reset();
      setNotice(
        'Refund credited to the wallet originally charged for this booking.'
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Refund failed.');
    } finally {
      setBusy(null);
    }
  }

  async function review(
    kind: QueueKind,
    id: string,
    decision: 'approved' | 'rejected',
    remarks?: string
  ): Promise<boolean> {
    setBusy(id);
    setNotice(null);
    try {
      await api(`/api/wallet/${kind}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, remarks }),
      });
      setNotice(
        kind === 'deposits'
          ? `Deposit ${decision}. You can verify it from the ${decision} list.`
          : `Adjustment ${decision}.`
      );
      await load();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Review failed.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function resendDecisionEmail(id: string): Promise<void> {
    setBusy(`email:${id}`);
    setNotice(null);
    try {
      await api(`/api/wallet/deposits/${id}/decision-email`, { method: 'POST' });
      setNotice('Decision email sent to the requester.');
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The decision email could not be sent.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggleWallet(wallet: WalletRow) {
    const next = wallet.status === 'active' ? 'frozen' : 'active';
    const reason =
      next === 'frozen'
        ? window.prompt('Reason for freezing this wallet:')
        : undefined;
    if (next === 'frozen' && !reason) return;

    setBusy(wallet.walletId);
    setNotice(null);
    try {
      await api('/api/wallet/admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId: wallet.walletId,
          status: next,
          reason,
        }),
      });
      setNotice(`Wallet ${next}.`);
      await load();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Wallet update failed.'
      );
    } finally {
      setBusy(null);
    }
  }

  const accountOwner = (accountId: string) => {
    const wallet = wallets.find((item) => item.accountId === accountId);
    return wallet ? `${wallet.ownerType}: ${wallet.ownerKey}` : accountId;
  };

  const tabs: TabDefinition[] = [
    { value: 'overview', label: 'Overview', icon: LayoutDashboard },
    ...(canManageBankAccounts
      ? [{ value: 'bank-accounts', label: 'Add Bank & MFS', icon: Building2 }]
      : []),
    {
      value: 'deposits',
      label: 'Deposit Requests',
      icon: Inbox,
      count: pendingDeposits.length,
    },
    {
      value: 'adjustments',
      label: 'Adjustments',
      icon: SlidersHorizontal,
      count: pendingAdjustments.length,
    },
    { value: 'wallets', label: 'Wallets', icon: WalletCards },
    ...(canRefundBookings
      ? [{ value: 'refunds', label: 'Refunds', icon: RotateCcw }]
      : []),
    { value: 'activity', label: 'Activity', icon: Activity },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-950">Wallet Accounts</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {canMutateWallets
              ? 'Manage balances through approved, fully audited operations.'
              : 'Read-only wallet balances, queues, and financial activity.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <div className="overflow-x-auto rounded-xl border border-navy-100 bg-white shadow-sm">
          <TabsList className="h-auto min-w-max justify-start rounded-none bg-transparent p-0">
            {tabs.map(({ value, label, icon: Icon, count }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="gap-2 rounded-none border-b-2 border-transparent px-4 py-3.5 text-sm font-semibold text-neutral-600 shadow-none transition hover:bg-navy-50 hover:text-navy-950 data-[state=active]:border-brand-orange data-[state=active]:bg-navy-50 data-[state=active]:text-navy-950 data-[state=active]:shadow-none"
              >
                <Icon className="h-4 w-4" />
                {label}
                {typeof count === 'number' && count > 0 && (
                  <span className="rounded-full bg-brand-orange px-1.5 py-0.5 text-[10px] font-bold leading-none text-navy-950">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {notice && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {notice}
          </p>
        )}

        <TabsContent value="overview" className="mt-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              ['Available Balance', totals.available],
              ['Hold Balance', totals.hold],
              ['Total Wallet Balance', totals.total],
            ].map(([label, value]) => (
              <article
                key={String(label)}
                className="rounded-xl bg-brand-orange p-5 text-black shadow-sm"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-black/75">
                  {String(label)}
                </p>
                <p className="mt-2 text-2xl font-bold tabular-nums">
                  {money(Number(value))}
                </p>
              </article>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Total wallets', wallets.length],
              [
                'Active wallets',
                wallets.filter((wallet) => wallet.status === 'active').length,
              ],
              [
                'Frozen wallets',
                wallets.filter((wallet) => wallet.status === 'frozen').length,
              ],
              [
                'Pending reviews',
                pendingDeposits.length + pendingAdjustments.length,
              ],
            ].map(([label, value]) => (
              <article
                key={String(label)}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-3.5 shadow-sm"
              >
                <p className="text-xs text-neutral-500">{String(label)}</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-navy-950">
                  {Number(value)}
                </p>
              </article>
            ))}
          </div>
        </TabsContent>

        {canManageBankAccounts && (
          <TabsContent value="bank-accounts" className="mt-0">
            <Tabs defaultValue="bank" className="space-y-4">
              <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1 shadow-sm">
                <TabsList className="h-auto bg-transparent p-0">
                  <TabsTrigger
                    value="bank"
                    className="gap-2 px-4 py-2 text-sm data-[state=active]:bg-brand-orange data-[state=active]:text-black"
                  >
                    <Building2 className="h-4 w-4" /> Bank Accounts
                  </TabsTrigger>
                  <TabsTrigger
                    value="mfs"
                    className="gap-2 px-4 py-2 text-sm data-[state=active]:bg-brand-orange data-[state=active]:text-black"
                  >
                    <Smartphone className="h-4 w-4" /> MFS Account
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="bank" className="mt-0">
                <CompanyBankAccountManager />
              </TabsContent>
              <TabsContent value="mfs" className="mt-0">
                <CompanyMfsAccountManager />
              </TabsContent>
            </Tabs>
          </TabsContent>
        )}

        <TabsContent value="deposits" className="mt-0">
          <Tabs defaultValue="pending" className="space-y-4">
            <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-sm">
              <TabsList className="h-auto min-w-max justify-start bg-transparent p-0">
                <TabsTrigger
                  value="pending"
                  className="gap-2 px-3 py-2 text-sm data-[state=active]:bg-brand-orange data-[state=active]:text-black"
                >
                  Pending
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 data-[state=active]:bg-white/20 data-[state=active]:text-black">
                    {pendingDeposits.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="approved"
                  className="gap-2 px-3 py-2 text-sm data-[state=active]:bg-brand-orange data-[state=active]:text-black"
                >
                  Approved
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 data-[state=active]:bg-white/20 data-[state=active]:text-black">
                    {approvedDeposits.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="rejected"
                  className="gap-2 px-3 py-2 text-sm data-[state=active]:bg-brand-orange data-[state=active]:text-black"
                >
                  Rejected
                  <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-800 data-[state=active]:bg-white/20 data-[state=active]:text-black">
                    {rejectedDeposits.length}
                  </span>
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="pending" className="mt-0">
              <QueuePanel
                title="Deposit requests awaiting approval"
                hint="Balances remain unchanged until a request is approved."
                emptyMessage="No deposit request is awaiting review."
                rows={pendingDeposits}
                kind="deposits"
                busy={busy}
                accountOwner={accountOwner}
                onReview={review}
                canReview={canMutateWallets}
              />
            </TabsContent>
            <TabsContent value="approved" className="mt-0">
              <DepositHistoryPanel
                rows={approvedDeposits}
                status="approved"
                accountOwner={accountOwner}
                busy={busy}
                onResendDecisionEmail={resendDecisionEmail}
                canResend={canMutateWallets}
              />
            </TabsContent>
            <TabsContent value="rejected" className="mt-0">
              <DepositHistoryPanel
                rows={rejectedDeposits}
                status="rejected"
                accountOwner={accountOwner}
                busy={busy}
                onResendDecisionEmail={resendDecisionEmail}
                canResend={canMutateWallets}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="adjustments" className="mt-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_380px]">
            <QueuePanel
              title="Adjustments awaiting approval"
              hint="A different financial operator must review each request."
              emptyMessage="No adjustment is awaiting review."
              rows={pendingAdjustments}
              kind="adjustments"
              busy={busy}
              accountOwner={accountOwner}
              onReview={review}
              canReview={canMutateWallets}
            />

            {canMutateWallets ? (
              <form
                onSubmit={createAdjustment}
                className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
              >
              <div>
                <h2 className="font-bold text-navy-950">Manual adjustment</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  The requester cannot approve their own entry.
                </p>
              </div>
              <WalletPicker
                wallets={wallets}
                value={selectedAccountId}
                onValueChange={setSelectedAccountId}
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  name="adjustmentType"
                  className="rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
                >
                  <option value="credit">Credit</option>
                  <option value="debit">Debit</option>
                </select>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="Amount"
                  className="rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
                />
              </div>
              <textarea
                name="reason"
                required
                minLength={3}
                maxLength={1000}
                placeholder="Reason"
                className="min-h-24 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
              />
              <button
                disabled={
                  busy === 'new-adjustment' || selectedAccountId.length === 0
                }
                className="w-full rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 disabled:opacity-60"
              >
                Submit for approval
              </button>
              </form>
            ) : (
              <aside className="rounded-xl border border-neutral-200 bg-white p-5 text-sm text-neutral-600 shadow-sm">
                Manual adjustments require Accounts, Admin, or Super Admin authority.
              </aside>
            )}
          </div>
        </TabsContent>

        <TabsContent value="wallets" className="mt-0">
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
              <div>
                <h2 className="font-bold text-navy-950">Wallets</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Review balances and control wallet availability.
                </p>
              </div>
              <span className="rounded-full bg-navy-50 px-2.5 py-1 text-xs font-bold text-navy-700">
                {wallets.length} total
              </span>
            </div>
            <div className="max-h-[620px] overflow-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="sticky top-0 bg-navy-50 text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-4 py-3">Owner</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Available</th>
                    <th className="px-4 py-3 text-right">Hold</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((wallet) => (
                    <tr
                      key={wallet.accountId}
                      className="border-t border-neutral-100"
                    >
                      <td className="px-4 py-3">
                        <span className="font-semibold capitalize">
                          {wallet.ownerType === 'agency'
                            ? wallet.ownerName
                            : 'User'}
                        </span>
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {wallet.ownerKey}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${
                            wallet.status === 'active'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-cyan-50 text-cyan-700'
                          }`}
                        >
                          {wallet.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {money(wallet.availableBalance, wallet.currency)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {money(wallet.holdBalance, wallet.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {money(wallet.totalBalance, wallet.currency)}
                      </td>
                      <td className="px-4 py-3">
                        {canMutateWallets ? (
                          <button
                            type="button"
                            disabled={busy === wallet.walletId}
                            onClick={() => void toggleWallet(wallet)}
                            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                          >
                            {wallet.status === 'active' ? 'Freeze' : 'Activate'}
                          </button>
                        ) : (
                          <span className="text-xs font-medium text-neutral-400">Read only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!loading && wallets.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-12 text-center text-neutral-500"
                      >
                        No wallets have been opened yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        {canRefundBookings ? (
          <TabsContent value="refunds" className="mt-0">
          <form
            onSubmit={refundBooking}
            className="max-w-xl space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
          >
            <div>
              <h2 className="font-bold text-navy-950">Booking refund</h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Credits only the wallet originally charged, up to the captured
                amount.
              </p>
            </div>
            <input
              name="bookingReference"
              required
              pattern="(STR[0-9]{12}|KTT[A-Z0-9]{1,100})"
              placeholder="Booking reference (KTT...)"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm uppercase"
            />
            <input
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              required
              placeholder="Refund amount"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
            />
            <textarea
              name="remarks"
              required
              minLength={3}
              maxLength={1000}
              placeholder="Refund reason"
              className="min-h-24 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm"
            />
            <button
              disabled={busy === 'refund-booking'}
              className="w-full rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-black disabled:opacity-60"
            >
              Process refund
            </button>
          </form>
          </TabsContent>
        ) : null}

        <TabsContent value="activity" className="mt-0">
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="font-bold text-navy-950">
                Recent financial activity
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                The latest 100 completed wallet transactions.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-navy-50 text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Owner</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Processed by</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {completedActivity.slice(0, 100).map((entry) => {
                    const timestamp = dateTimeParts(entry.createdAt);
                    const activityReference =
                      entry.bookingReference ?? entry.adjustment?.publicRef;
                    return (
                    <tr key={entry.id} className="border-t border-neutral-100">
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="block text-navy-950">{timestamp.date}</span>
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {timestamp.time}
                        </span>
                      </td>
                      <td className="px-4 py-3 capitalize">
                        {entry.ownerType === 'agency' ? (
                          <>
                            <span className="block font-semibold text-navy-950">
                              Agency: {entry.ownerName || 'Unnamed agency'}
                            </span>
                            <span className="mt-0.5 block text-xs normal-case text-neutral-500">
                              ID: {entry.ownerKey || '—'}
                            </span>
                          </>
                        ) : (
                          `${entry.ownerType ?? 'wallet'}: ${entry.ownerKey ?? '—'}`
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {entry.deposit ? (
                          <>
                            <span className="block font-semibold text-navy-950">
                              {depositMethodLabel(entry.deposit.method)}
                            </span>
                            <span className="mt-0.5 block font-mono text-xs text-neutral-500">
                              {entry.deposit.publicRef}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="block capitalize">
                              {activityTypeLabel(entry.transactionType)}
                            </span>
                            {activityReference ? (
                              entry.transactionType === 'booking_confirm' &&
                              entry.bookingReference ? (
                                <Link
                                  href={`/dashboard/bookings/${encodeURIComponent(entry.bookingReference)}`}
                                  className="mt-0.5 block w-fit font-mono text-xs text-brand-blue underline decoration-brand-blue/40 underline-offset-2 transition hover:text-navy-950 hover:decoration-navy-950"
                                >
                                  {entry.bookingReference}
                                </Link>
                              ) : (
                                <span className="mt-0.5 block font-mono text-xs text-neutral-500">
                                  {activityReference}
                                </span>
                              )
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {entry.processedBy?.name || 'System'}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-navy-950">
                        <span>{entry.currency}</span>{' '}
                        <span className={activityAmountClass(entry)}>
                          {moneyAmount(entry.amount)}
                        </span>
                      </td>
                    </tr>
                    );
                  })}
                  {!loading && completedActivity.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-12 text-center text-neutral-500"
                      >
                        No financial activity yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
