'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  ImageIcon,
  Landmark,
  Pencil,
  Plus,
  Power,
  Trash2,
  X,
} from 'lucide-react';

import {
  LOGO_ACCEPT,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';

type BankAccount = {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchName: string | null;
  branchCode: string | null;
  routingNumber: string | null;
  swiftCode: string | null;
  logoUrl: string | null;
  active: boolean;
};

type Draft = {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchName: string;
  branchCode: string;
  routingNumber: string;
  swiftCode: string;
};

const EMPTY_DRAFT: Draft = {
  bankName: '',
  accountName: '',
  accountNumber: '',
  branchName: '',
  branchCode: '',
  routingNumber: '',
  swiftCode: '',
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100';

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const text = await response.text();
  let body: {
    success?: boolean;
    data?: {
      accounts?: BankAccount[];
      account?: BankAccount;
      logoUrl?: string;
      removed?: boolean;
    };
    error?: { errorMessage?: string };
  };

  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('The payment bank-account service returned an invalid response.');
  }

  if (!response.ok || body.success === false) {
    throw new Error(
      body.error?.errorMessage || 'The payment bank-account operation failed.'
    );
  }
  return body.data ?? {};
}

function draftFrom(account: BankAccount): Draft {
  return {
    bankName: account.bankName,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    branchName: account.branchName ?? '',
    branchCode: account.branchCode ?? '',
    routingNumber: account.routingNumber ?? '',
    swiftCode: account.swiftCode ?? '',
  };
}

export default function CompanyBankAccountManager() {
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/wallet/company-bank-accounts');
      setAccounts(data.accounts ?? []);
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : 'Payment bank accounts could not be loaded.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  function update(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setLogoFile(null);
    if (logoInputRef.current) logoInputRef.current.value = '';
  }

  function selectLogo(file: File | undefined) {
    if (!file) return;
    if (!LOGO_EXTENSIONS[file.type]) {
      setNotice('Use an SVG, PNG, WebP or JPEG bank logo.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setNotice('The bank logo is over the 512 KB limit.');
      return;
    }
    setNotice(null);
    setLogoFile(file);
  }

  async function uploadLogo(accountId: string, file: File) {
    const form = new FormData();
    form.append('logo', file);
    await api(`/api/wallet/company-bank-accounts/${accountId}/logo`, {
      method: 'POST',
      body: form,
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('form');
    setNotice(null);

    try {
      const data = await api('/api/wallet/company-bank-accounts', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editing
            ? { ...draft, id: editing.id, active: editing.active }
            : draft
        ),
      });
      const savedAccount = data.account;
      let logoError: string | null = null;
      if (logoFile && savedAccount) {
        try {
          await uploadLogo(savedAccount.id, logoFile);
        } catch (reason) {
          logoError =
            reason instanceof Error
              ? reason.message
              : 'The bank logo could not be uploaded.';
        }
      }
      cancelEdit();
      await load();
      setNotice(
        logoError
          ? `Bank account saved, but the logo was not uploaded: ${logoError}`
          : editing
            ? 'Payment bank account updated.'
            : 'Payment bank account added.'
      );
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : 'The bank account could not be saved.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggle(account: BankAccount) {
    setBusy(account.id);
    setNotice(null);
    try {
      await api('/api/wallet/company-bank-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draftFrom(account),
          id: account.id,
          active: !account.active,
        }),
      });
      setNotice(
        `Payment bank account ${account.active ? 'deactivated' : 'activated'}.`
      );
      await load();
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : 'The bank account status could not be changed.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeLogo(account: BankAccount) {
    setBusy(`logo:${account.id}`);
    setNotice(null);
    try {
      await api(`/api/wallet/company-bank-accounts/${account.id}/logo`, {
        method: 'DELETE',
      });
      await load();
      setNotice('Bank logo removed.');
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : 'The bank logo could not be removed.'
      );
    } finally {
      setBusy(null);
    }
  }

  const shownLogo = logoPreviewUrl ?? editing?.logoUrl ?? null;

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
          <Landmark className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">
            Payment Receiving Bank Accounts
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Super Admin controls the accounts offered to B2B and B2C users for
            bank deposits, transfers and cheque payments.
          </p>
        </div>
      </div>

      {notice && (
        <p className="m-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          {notice}
        </p>
      )}

      <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
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

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-navy-950">
              Bank Name <span className="text-brand-orange">*</span>
              <input
                required
                maxLength={150}
                value={draft.bankName}
                onChange={(event) => update('bankName', event.target.value)}
                placeholder="e.g. Dutch-Bangla Bank"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Account Name <span className="text-brand-orange">*</span>
              <input
                required
                maxLength={150}
                value={draft.accountName}
                onChange={(event) => update('accountName', event.target.value)}
                placeholder="Kaliganj Travels"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Account Number <span className="text-brand-orange">*</span>
              <input
                required
                maxLength={100}
                value={draft.accountNumber}
                onChange={(event) => update('accountNumber', event.target.value)}
                placeholder="Account number"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Branch Name
              <input
                maxLength={150}
                value={draft.branchName}
                onChange={(event) => update('branchName', event.target.value)}
                placeholder="Branch name"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Branch Code <span className="font-normal text-neutral-400">(optional)</span>
              <input
                maxLength={100}
                value={draft.branchCode}
                onChange={(event) => update('branchCode', event.target.value)}
                placeholder="Branch code"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Routing Number
              <input
                maxLength={100}
                value={draft.routingNumber}
                onChange={(event) => update('routingNumber', event.target.value)}
                placeholder="Routing number"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              SWIFT Code
              <input
                maxLength={50}
                value={draft.swiftCode}
                onChange={(event) => update('swiftCode', event.target.value)}
                placeholder="SWIFT code"
                className={`${CONTROL} uppercase`}
              />
            </label>
          </div>

          <div className="rounded-xl border border-dashed border-navy-200 bg-navy-50/30 p-4">
            <div className="flex flex-wrap items-center gap-4">
              <span
                role={shownLogo ? 'img' : undefined}
                aria-label={shownLogo ? 'Selected bank logo preview' : undefined}
                style={
                  shownLogo
                    ? {
                        backgroundImage: `url("${shownLogo}")`,
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: 'contain',
                      }
                    : undefined
                }
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-300"
              >
                {!shownLogo && <ImageIcon className="h-6 w-6" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-navy-950">
                  Bank Logo <span className="font-normal text-neutral-400">(optional)</span>
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  SVG, PNG, WebP or JPEG, up to 512 KB.
                </p>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept={LOGO_ACCEPT}
                  disabled={busy === 'form'}
                  onChange={(event) => selectLogo(event.target.files?.[0])}
                  className="mt-2 block w-full text-xs text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-navy-950"
                />
              </div>
              {logoFile && (
                <button
                  type="button"
                  onClick={() => {
                    setLogoFile(null);
                    if (logoInputRef.current) logoInputRef.current.value = '';
                  }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-red-700"
                >
                  <X className="h-3.5 w-3.5" /> Clear
                </button>
              )}
            </div>
          </div>

          <button
            disabled={busy === 'form'}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editing ? 'Save Changes' : 'Add Bank Account'}
          </button>
        </form>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">Configured accounts</h3>
            <span className="rounded-full bg-navy-50 px-2.5 py-1 text-xs font-bold text-navy-700">
              {accounts.length} total
            </span>
          </div>

          <div className="space-y-3">
            {loading && accounts.length === 0 ? (
              <p className="rounded-lg border border-neutral-200 px-4 py-8 text-center text-sm text-neutral-500">
                Loading payment bank accounts&hellip;
              </p>
            ) : accounts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">
                No payment receiving bank account has been added yet.
              </p>
            ) : (
              accounts.map((account) => (
                <article
                  key={account.id}
                  className={`rounded-xl border p-4 ${
                    account.active
                      ? 'border-navy-100 bg-navy-50/40'
                      : 'border-neutral-200 bg-neutral-50 opacity-70'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span
                        role={account.logoUrl ? 'img' : undefined}
                        aria-label={
                          account.logoUrl
                            ? `${account.bankName} logo`
                            : undefined
                        }
                        style={
                          account.logoUrl
                            ? {
                                backgroundImage: `url("${account.logoUrl}")`,
                                backgroundPosition: 'center',
                                backgroundRepeat: 'no-repeat',
                                backgroundSize: 'contain',
                              }
                            : undefined
                        }
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-300"
                      >
                        {!account.logoUrl && <Landmark className="h-5 w-5" />}
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-bold text-navy-950">
                            {account.bankName}
                          </p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              account.active
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-neutral-200 text-neutral-600'
                            }`}
                          >
                            {account.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-navy-950">
                          {account.accountName}
                        </p>
                        <p className="mt-0.5 font-mono text-sm text-neutral-700">
                          {account.accountNumber}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(account);
                          setDraft(draftFrom(account));
                          setLogoFile(null);
                          if (logoInputRef.current) {
                            logoInputRef.current.value = '';
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-950"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy === account.id}
                        onClick={() => void toggle(account)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-950 disabled:opacity-60"
                      >
                        <Power className="h-3.5 w-3.5" />
                        {account.active ? 'Deactivate' : 'Activate'}
                      </button>
                      {account.logoUrl && (
                        <button
                          type="button"
                          disabled={busy === `logo:${account.id}`}
                          onClick={() => void removeLogo(account)}
                          aria-label={`Remove ${account.bankName} logo`}
                          className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-red-700 disabled:opacity-60"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <dl className="mt-3 grid gap-2 border-t border-neutral-200/70 pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <dt className="text-neutral-400">Branch</dt>
                      <dd className="mt-0.5 font-medium text-neutral-700">
                        {account.branchName || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-neutral-400">Branch code</dt>
                      <dd className="mt-0.5 font-medium text-neutral-700">
                        {account.branchCode || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-neutral-400">Routing number</dt>
                      <dd className="mt-0.5 font-medium text-neutral-700">
                        {account.routingNumber || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-neutral-400">SWIFT code</dt>
                      <dd className="mt-0.5 font-medium text-neutral-700">
                        {account.swiftCode || '—'}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
