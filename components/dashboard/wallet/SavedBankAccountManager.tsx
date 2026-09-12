'use client';

import { FormEvent, useState } from 'react';
import { Landmark, Pencil, Plus, Trash2, X } from 'lucide-react';

import type { UserBankAccountOption } from '@/lib/wallet/payment-options';

type Props = {
  accounts: UserBankAccountOption[];
  agencyWallet: boolean;
  unavailable: boolean;
  onAccountsChange: (accounts: UserBankAccountOption[]) => void;
};

type Draft = Omit<UserBankAccountOption, 'id'>;

const EMPTY_DRAFT: Draft = {
  bankName: '',
  accountName: '',
  accountNumber: '',
  routingNumber: '',
  swiftCode: '',
  branchCode: '',
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100';

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = (await response.json()) as {
    success?: boolean;
    data?: { account?: UserBankAccountOption; removed?: boolean };
    error?: { errorMessage?: string };
  };
  if (!response.ok || body.success === false) {
    throw new Error(body.error?.errorMessage || 'Saved bank-account operation failed.');
  }
  return body.data ?? {};
}

function accountLabel(account: UserBankAccountOption) {
  return `${account.bankName} · ${account.accountName} · ${account.accountNumber}`;
}

export default function SavedBankAccountManager({
  accounts,
  agencyWallet,
  unavailable,
  onAccountsChange,
}: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<UserBankAccountOption | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function update(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  function beginEdit(account: UserBankAccountOption) {
    setEditing(account);
    setDraft({
      bankName: account.bankName,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      routingNumber: account.routingNumber,
      swiftCode: account.swiftCode,
      branchCode: account.branchCode,
    });
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('form');
    setNotice(null);
    try {
      const data = await api('/api/wallet/saved-bank-accounts', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { ...draft, id: editing.id } : draft),
      });
      if (!data.account) throw new Error('Saved bank account was not returned.');

      const next = editing
        ? accounts.map((account) =>
            account.id === data.account?.id ? data.account : account
          )
        : [...accounts, data.account];
      onAccountsChange(
        next.sort((left, right) => accountLabel(left).localeCompare(accountLabel(right)))
      );
      cancelEdit();
      setNotice(editing ? 'Saved bank account updated.' : 'Bank account added.');
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The bank account could not be saved.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(account: UserBankAccountOption) {
    if (!window.confirm(`Delete ${accountLabel(account)}?`)) return;
    setBusy(account.id);
    setNotice(null);
    try {
      await api('/api/wallet/saved-bank-accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: account.id }),
      });
      onAccountsChange(accounts.filter((item) => item.id !== account.id));
      if (editing?.id === account.id) cancelEdit();
      setNotice('Saved bank account deleted. Existing deposit requests retain their bank snapshot.');
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The bank account could not be deleted.'
      );
    } finally {
      setBusy(null);
    }
  }

  const ownerLabel = agencyWallet ? 'agency' : 'wallet';

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
          <Landmark className="h-4 w-4" />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">My Bank Accounts</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Save one or more sender accounts under this {ownerLabel}. Bank
            transfer deposits must use one of these accounts.
          </p>
        </div>
      </div>

      {notice && (
        <p className="m-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          {notice}
        </p>
      )}
      {unavailable && (
        <p className="m-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          Your saved bank accounts could not be loaded. Refresh the page to try again.
        </p>
      )}

      <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">
              {editing ? 'Edit bank account' : 'Add bank account'}
            </h3>
            {editing && (
              <button
                type="button"
                onClick={cancelEdit}
                className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-navy-950"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            )}
          </div>

          <label className="block text-sm font-medium text-navy-950">
            Bank Name <span className="text-brand-orange">*</span>
            <input
              required
              value={draft.bankName}
              onChange={(event) => update('bankName', event.target.value)}
              maxLength={150}
              className={CONTROL}
            />
          </label>
          <label className="block text-sm font-medium text-navy-950">
            Account Name <span className="text-brand-orange">*</span>
            <input
              required
              value={draft.accountName}
              onChange={(event) => update('accountName', event.target.value)}
              maxLength={150}
              className={CONTROL}
            />
          </label>
          <label className="block text-sm font-medium text-navy-950">
            Account Number <span className="text-brand-orange">*</span>
            <input
              required
              value={draft.accountNumber}
              onChange={(event) => update('accountNumber', event.target.value)}
              maxLength={100}
              className={CONTROL}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-navy-950">
              Routing Number
              <input
                value={draft.routingNumber}
                onChange={(event) => update('routingNumber', event.target.value)}
                maxLength={100}
                className={CONTROL}
              />
            </label>
            <label className="block text-sm font-medium text-navy-950">
              Branch Code
              <input
                value={draft.branchCode}
                onChange={(event) => update('branchCode', event.target.value)}
                maxLength={100}
                className={CONTROL}
              />
            </label>
          </div>
          <label className="block text-sm font-medium text-navy-950">
            SWIFT Code
            <input
              value={draft.swiftCode}
              onChange={(event) => update('swiftCode', event.target.value)}
              maxLength={50}
              className={CONTROL}
            />
          </label>
          <button
            disabled={busy === 'form' || unavailable}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            {busy === 'form'
              ? 'Saving...'
              : editing
                ? 'Save Changes'
                : 'Add Bank Account'}
          </button>
        </form>

        <div className="space-y-3">
          <h3 className="font-semibold text-navy-950">
            Saved Accounts ({accounts.length})
          </h3>
          {accounts.length ? (
            accounts.map((account) => (
              <article
                key={account.id}
                className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-navy-950">{account.bankName}</p>
                    <p className="mt-0.5 text-sm text-neutral-600">{account.accountName}</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-navy-950">
                      {account.accountNumber}
                    </p>
                    {(account.routingNumber || account.branchCode || account.swiftCode) && (
                      <p className="mt-2 text-xs text-neutral-500">
                        {[
                          account.routingNumber && `Routing: ${account.routingNumber}`,
                          account.branchCode && `Branch: ${account.branchCode}`,
                          account.swiftCode && `SWIFT: ${account.swiftCode}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => beginEdit(account)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-navy-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-700 hover:bg-navy-50 disabled:opacity-60"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(account)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center">
              <Landmark className="mx-auto h-8 w-8 text-navy-200" />
              <p className="mt-3 text-sm font-semibold text-navy-950">
                No saved bank accounts yet
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                Add an account to use bank transfer deposit requests.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
