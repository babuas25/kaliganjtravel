'use client';

import Image from 'next/image';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  ImageIcon,
  Pencil,
  Plus,
  Power,
  QrCode,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';

import {
  LOGO_ACCEPT,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';
import {
  MFS_PROVIDERS,
  MFS_PAYMENT_TYPES,
  mfsPaymentTypeLabel,
  type MfsPaymentType,
} from '@/lib/wallet/payment-options';

type MfsAccount = {
  id: string;
  mfsName: string;
  accountNumber: string;
  paymentType: MfsPaymentType;
  chargePercent: number;
  logoUrl: string | null;
  qrCodeUrl: string | null;
  active: boolean;
};

type Draft = {
  mfsName: string;
  accountNumber: string;
  paymentType: MfsPaymentType;
  chargePercent: string;
};

type AssetKind = 'logo' | 'qr-code';

const EMPTY_DRAFT: Draft = {
  mfsName: '',
  accountNumber: '',
  paymentType: 'merchant',
  chargePercent: '0',
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100';

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const text = await response.text();
  let body: {
    success?: boolean;
    data?: { accounts?: MfsAccount[]; account?: MfsAccount };
    error?: { errorMessage?: string };
  };

  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('The MFS account service returned an invalid response.');
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.error?.errorMessage || 'The MFS account operation failed.');
  }
  return body.data ?? {};
}

function draftFrom(account: MfsAccount): Draft {
  return {
    mfsName: account.mfsName,
    accountNumber: account.accountNumber,
    paymentType: account.paymentType,
    chargePercent: String(account.chargePercent),
  };
}

function AssetPicker({
  label,
  hint,
  file,
  previewUrl,
  inputRef,
  disabled,
  onSelect,
  onClear,
  icon: Icon,
}: {
  label: string;
  hint: string;
  file: File | null;
  previewUrl: string | null;
  inputRef: React.RefObject<HTMLInputElement>;
  disabled: boolean;
  onSelect: (file: File | undefined) => void;
  onClear: () => void;
  icon: typeof ImageIcon;
}) {
  return (
    <div className="rounded-xl border border-dashed border-navy-200 bg-navy-50/30 p-4">
      <div className="flex items-center gap-3">
        <span
          role={previewUrl ? 'img' : undefined}
          aria-label={previewUrl ? `${label} preview` : undefined}
          style={
            previewUrl
              ? {
                  backgroundImage: `url("${previewUrl}")`,
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'contain',
                }
              : undefined
          }
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-300"
        >
          {!previewUrl && <Icon className="h-6 w-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-navy-950">{label}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            disabled={disabled}
            onChange={(event) => onSelect(event.target.files?.[0])}
            className="mt-2 block w-full text-xs text-neutral-600 file:mr-2 file:rounded-md file:border-0 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-navy-950"
          />
        </div>
        {file && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${label}`}
            className="text-neutral-400 hover:text-red-700"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function CompanyMfsAccountManager() {
  const logoInputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<MfsAccount[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<MfsAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [qrPreview, setQrPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/wallet/company-mfs-accounts');
      setAccounts(data.accounts ?? []);
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : 'MFS accounts could not be loaded.'
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
      setLogoPreview(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  useEffect(() => {
    if (!qrFile) {
      setQrPreview(null);
      return;
    }
    const url = URL.createObjectURL(qrFile);
    setQrPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [qrFile]);

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function clearFile(kind: AssetKind) {
    if (kind === 'logo') {
      setLogoFile(null);
      if (logoInputRef.current) logoInputRef.current.value = '';
    } else {
      setQrFile(null);
      if (qrInputRef.current) qrInputRef.current.value = '';
    }
  }

  function selectFile(kind: AssetKind, file: File | undefined) {
    if (!file) return;
    if (!LOGO_EXTENSIONS[file.type]) {
      setNotice('Use an SVG, PNG, WebP or JPEG image.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setNotice('The image is over the 512 KB limit.');
      return;
    }
    setNotice(null);
    if (kind === 'logo') setLogoFile(file);
    else setQrFile(file);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    clearFile('logo');
    clearFile('qr-code');
  }

  async function uploadAsset(accountId: string, kind: AssetKind, file: File) {
    const form = new FormData();
    form.append('asset', file);
    await api(`/api/wallet/company-mfs-accounts/${accountId}/assets/${kind}`, {
      method: 'POST',
      body: form,
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('form');
    setNotice(null);
    const wasEditing = Boolean(editing);

    try {
      const data = await api('/api/wallet/company-mfs-accounts', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editing ? { ...draft, id: editing.id, active: editing.active } : draft
        ),
      });
      const saved = data.account;
      const uploadErrors: string[] = [];
      if (saved && logoFile) {
        try {
          await uploadAsset(saved.id, 'logo', logoFile);
        } catch (reason) {
          uploadErrors.push(reason instanceof Error ? reason.message : 'Logo upload failed.');
        }
      }
      if (saved && qrFile) {
        try {
          await uploadAsset(saved.id, 'qr-code', qrFile);
        } catch (reason) {
          uploadErrors.push(reason instanceof Error ? reason.message : 'QR upload failed.');
        }
      }
      cancelEdit();
      await load();
      setNotice(
        uploadErrors.length
          ? `MFS account saved, but: ${uploadErrors.join(' ')}`
          : wasEditing
            ? 'MFS account updated.'
            : 'MFS account added.'
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'MFS account could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(account: MfsAccount) {
    setBusy(account.id);
    setNotice(null);
    try {
      await api('/api/wallet/company-mfs-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draftFrom(account),
          id: account.id,
          active: !account.active,
        }),
      });
      await load();
      setNotice(`MFS account ${account.active ? 'deactivated' : 'activated'}.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'MFS status could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  async function removeAsset(account: MfsAccount, kind: AssetKind) {
    setBusy(`${kind}:${account.id}`);
    setNotice(null);
    try {
      await api(`/api/wallet/company-mfs-accounts/${account.id}/assets/${kind}`, {
        method: 'DELETE',
      });
      await load();
      setNotice(`${kind === 'logo' ? 'MFS logo' : 'QR code'} removed.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'MFS image could not be removed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
          <Smartphone className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">Payment Receiving MFS Accounts</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Configure mobile payment numbers, customer charges, logos and QR codes.
          </p>
        </div>
      </div>

      {notice && (
        <p className="m-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          {notice}
        </p>
      )}

      <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">
              {editing ? 'Edit MFS account' : 'Add MFS account'}
            </h3>
            {editing && (
              <button type="button" onClick={cancelEdit} className="text-xs font-semibold text-neutral-500">
                Cancel
              </button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-navy-950">
              MFS Name <span className="text-brand-orange">*</span>
              <select
                required
                value={draft.mfsName}
                onChange={(event) => update('mfsName', event.target.value)}
                className={CONTROL}
              >
                <option value="" disabled>Select mobile banking service</option>
                {draft.mfsName &&
                  !MFS_PROVIDERS.some(
                    (provider) => provider.name === draft.mfsName
                  ) && <option value={draft.mfsName}>{draft.mfsName}</option>}
                {MFS_PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.name}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-navy-950">
              Number <span className="text-brand-orange">*</span>
              <input
                required
                maxLength={100}
                value={draft.accountNumber}
                onChange={(event) => update('accountNumber', event.target.value)}
                placeholder="Payment number"
                className={CONTROL}
              />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Payment Type <span className="text-brand-orange">*</span>
              <select
                value={draft.paymentType}
                onChange={(event) => update('paymentType', event.target.value as MfsPaymentType)}
                className={CONTROL}
              >
                {MFS_PAYMENT_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-navy-950">
              Charge (%) <span className="text-brand-orange">*</span>
              <input
                required
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={draft.chargePercent}
                onChange={(event) => update('chargePercent', event.target.value)}
                className={CONTROL}
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <AssetPicker
              label="MFS Logo (optional)"
              hint="SVG, PNG, WebP or JPEG, up to 512 KB."
              file={logoFile}
              previewUrl={logoPreview ?? editing?.logoUrl ?? null}
              inputRef={logoInputRef}
              disabled={busy === 'form'}
              onSelect={(file) => selectFile('logo', file)}
              onClear={() => clearFile('logo')}
              icon={ImageIcon}
            />
            <AssetPicker
              label="QR Code (optional)"
              hint="Shown to users after they choose this payment type."
              file={qrFile}
              previewUrl={qrPreview ?? editing?.qrCodeUrl ?? null}
              inputRef={qrInputRef}
              disabled={busy === 'form'}
              onSelect={(file) => selectFile('qr-code', file)}
              onClear={() => clearFile('qr-code')}
              icon={QrCode}
            />
          </div>

          <button
            disabled={busy === 'form'}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-navy-950 disabled:opacity-60"
          >
            {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editing ? 'Save Changes' : 'Add MFS Account'}
          </button>
        </form>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">Configured MFS accounts</h3>
            <span className="rounded-full bg-navy-50 px-2.5 py-1 text-xs font-bold text-navy-700">
              {accounts.length} total
            </span>
          </div>
          <div className="space-y-3">
            {loading && accounts.length === 0 ? (
              <p className="rounded-lg border border-neutral-200 px-4 py-8 text-center text-sm text-neutral-500">
                Loading MFS accounts&hellip;
              </p>
            ) : accounts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">
                No payment receiving MFS account has been added yet.
              </p>
            ) : (
              accounts.map((account) => (
                <article
                  key={account.id}
                  className={`rounded-xl border p-4 ${
                    account.active ? 'border-navy-100 bg-navy-50/40' : 'border-neutral-200 bg-neutral-50 opacity-70'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        style={account.logoUrl ? {
                          backgroundImage: `url("${account.logoUrl}")`,
                          backgroundPosition: 'center',
                          backgroundRepeat: 'no-repeat',
                          backgroundSize: 'contain',
                        } : undefined}
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-300"
                      >
                        {!account.logoUrl && <Smartphone className="h-5 w-5" />}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-bold text-navy-950">{account.mfsName}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            account.active ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-200 text-neutral-600'
                          }`}>
                            {account.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-sm text-neutral-700">{account.accountNumber}</p>
                        <p className="mt-1 text-xs text-neutral-500">
                          {mfsPaymentTypeLabel(account.paymentType)} · Charge {account.chargePercent.toFixed(2)}%
                        </p>
                      </div>
                    </div>
                    {account.qrCodeUrl && (
                      <a href={account.qrCodeUrl} target="_blank" rel="noreferrer" className="shrink-0">
                        {/* Public payment instruction, intentionally visible to signed-in payers. */}
                        <Image
                          src={account.qrCodeUrl}
                          alt={`${account.mfsName} QR code`}
                          width={64}
                          height={64}
                          unoptimized
                          className="h-16 w-16 rounded-lg border border-neutral-200 bg-white object-contain p-1"
                        />
                      </a>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(account);
                        setDraft(draftFrom(account));
                        clearFile('logo');
                        clearFile('qr-code');
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
                      <Power className="h-3.5 w-3.5" /> {account.active ? 'Deactivate' : 'Activate'}
                    </button>
                    {account.logoUrl && (
                      <button type="button" onClick={() => void removeAsset(account, 'logo')} className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" /> Remove logo
                      </button>
                    )}
                    {account.qrCodeUrl && (
                      <button type="button" onClick={() => void removeAsset(account, 'qr-code')} className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" /> Remove QR
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
