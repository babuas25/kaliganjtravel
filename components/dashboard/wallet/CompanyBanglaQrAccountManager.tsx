'use client';

import Image from 'next/image';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Power, QrCode, Trash2, X } from 'lucide-react';

import { LOGO_ACCEPT, LOGO_EXTENSIONS, LOGO_MAX_BYTES } from '@/lib/upload-verify';

type BanglaQrAccount = {
  id: string;
  merchantName: string;
  bankName: string | null;
  merchantId: string | null;
  qrCodeUrl: string | null;
  active: boolean;
  sortOrder: number;
};

type Draft = {
  merchantName: string;
  bankName: string;
  merchantId: string;
  sortOrder: string;
  active: boolean;
};

type ApiData = {
  accounts?: BanglaQrAccount[];
  account?: BanglaQrAccount;
  uploadConfigured?: boolean;
  assetUrl?: string | null;
};

const EMPTY_DRAFT: Draft = {
  merchantName: '',
  bankName: '',
  merchantId: '',
  sortOrder: '0',
  active: true,
};

const CONTROL =
  'mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-hidden transition placeholder:text-neutral-400 focus:border-navy-400 focus:ring-2 focus:ring-navy-100 disabled:cursor-not-allowed disabled:bg-neutral-100';

async function api(url: string, options?: RequestInit): Promise<ApiData> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const text = await response.text();
  let body: {
    success?: boolean;
    data?: ApiData;
    error?: { errorMessage?: string };
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('The Bangla QR account service returned an invalid response.');
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.error?.errorMessage || 'The Bangla QR account operation failed.');
  }
  return body.data ?? {};
}

function draftFrom(account: BanglaQrAccount): Draft {
  return {
    merchantName: account.merchantName,
    bankName: account.bankName ?? '',
    merchantId: account.merchantId ?? '',
    sortOrder: String(account.sortOrder),
    active: account.active,
  };
}

export default function CompanyBanglaQrAccountManager() {
  const qrInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<BanglaQrAccount[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<BanglaQrAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadConfigured, setUploadConfigured] = useState(false);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [qrPreview, setQrPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/wallet/company-bangla-qr-accounts');
      const nextAccounts = data.accounts ?? [];
      setAccounts(nextAccounts);
      setUploadConfigured(Boolean(data.uploadConfigured));
      setEditing((current) =>
        current ? nextAccounts.find((account) => account.id === current.id) ?? null : null
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Bangla QR accounts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  function clearFile() {
    setQrFile(null);
    if (qrInputRef.current) qrInputRef.current.value = '';
  }

  function selectFile(file: File | undefined) {
    if (!file) return;
    if (!LOGO_EXTENSIONS[file.type]) {
      setNotice('Use an SVG, PNG, WebP or JPEG QR image.');
      clearFile();
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setNotice('The QR image is over the 512 KB limit.');
      clearFile();
      return;
    }
    setNotice(null);
    setQrFile(file);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    clearFile();
  }

  async function saveAccount(account: BanglaQrAccount, active: boolean) {
    return api('/api/wallet/company-bangla-qr-accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draftFrom(account), id: account.id, active }),
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('form');
    setNotice(null);
    const wasEditing = Boolean(editing);
    let saved: BanglaQrAccount | undefined;
    try {
      const data = await api('/api/wallet/company-bangla-qr-accounts', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editing
            ? { ...draft, id: editing.id, active: draft.active && Boolean(editing.qrCodeUrl) }
            : draft
        ),
      });
      saved = data.account;
      if (!saved) throw new Error('The saved Bangla QR account was not returned.');

      if (qrFile) {
        const form = new FormData();
        form.append('asset', qrFile);
        const upload = await api(`/api/wallet/company-bangla-qr-accounts/${saved.id}/qr-code`, {
          method: 'POST',
          body: form,
        });
        saved = { ...saved, qrCodeUrl: upload.assetUrl ?? null };
      }
      if (draft.active && saved.qrCodeUrl && !saved.active) {
        const activated = await saveAccount(saved, true);
        saved = activated.account ?? saved;
      }

      const needsQr = draft.active && !saved.qrCodeUrl;
      cancelEdit();
      await load();
      setNotice(
        needsQr
          ? 'Bangla QR account saved as inactive. Upload a QR image and activate it to receive payments.'
          : wasEditing ? 'Bangla QR account updated.' : 'Bangla QR account added.'
      );
    } catch (reason) {
      if (saved) {
        setEditing(saved);
        await load();
      }
      const message = reason instanceof Error ? reason.message : 'Bangla QR account could not be saved.';
      setNotice(saved ? `Account details saved. ${message} You can retry from this form.` : message);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(account: BanglaQrAccount) {
    setBusy(account.id);
    setNotice(null);
    try {
      await saveAccount(account, !account.active);
      await load();
      if (editing?.id === account.id) update('active', !account.active);
      setNotice(`Bangla QR account ${account.active ? 'deactivated' : 'activated'}.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Bangla QR status could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  async function removeQr(account: BanglaQrAccount) {
    setBusy(account.id);
    setNotice(null);
    try {
      await api(`/api/wallet/company-bangla-qr-accounts/${account.id}/qr-code`, { method: 'DELETE' });
      await load();
      if (editing?.id === account.id) {
        clearFile();
        update('active', false);
      }
      setNotice('QR code removed and the Bangla QR account deactivated.');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'The QR image could not be removed.');
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || loading;
  const previewUrl = qrPreview ?? editing?.qrCodeUrl ?? null;

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
          <QrCode className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-bold text-navy-950">Payment Receiving Bangla QR Accounts</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Add merchant details and upload the QR code shown to customers making payments.
          </p>
        </div>
      </div>

      {notice && (
        <p role="status" className="m-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          {notice}
        </p>
      )}
      {!loading && !uploadConfigured && (
        <p className="mx-5 mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6">
          QR image uploads are unavailable in this environment. Existing QR codes can still be managed.
        </p>
      )}

      <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">{editing ? 'Edit Bangla QR account' : 'Add Bangla QR account'}</h3>
            {editing && (
              <button type="button" disabled={disabled} onClick={cancelEdit} className="text-xs font-semibold text-neutral-500 disabled:opacity-60">
                Cancel
              </button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-navy-950 sm:col-span-2">
              Merchant Name <span className="text-brand-orange">*</span>
              <input required minLength={2} maxLength={150} disabled={disabled} value={draft.merchantName} onChange={(event) => update('merchantName', event.target.value)} placeholder="Merchant receiving this payment" className={CONTROL} />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Bank Name <span className="font-normal text-neutral-400">(optional)</span>
              <input maxLength={150} disabled={disabled} value={draft.bankName} onChange={(event) => update('bankName', event.target.value)} placeholder="Receiving bank" className={CONTROL} />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Merchant / TID <span className="font-normal text-neutral-400">(optional)</span>
              <input maxLength={100} disabled={disabled} value={draft.merchantId} onChange={(event) => update('merchantId', event.target.value)} placeholder="Merchant or terminal ID" className={CONTROL} />
            </label>
            <label className="text-sm font-medium text-navy-950">
              Display Order
              <input required type="number" min="0" max="100000" step="1" disabled={disabled} value={draft.sortOrder} onChange={(event) => update('sortOrder', event.target.value)} className={CONTROL} />
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-navy-950 sm:pt-7">
              <input type="checkbox" disabled={disabled} checked={draft.active} onChange={(event) => update('active', event.target.checked)} className="h-4 w-4 accent-brand-orange" />
              Active after QR is uploaded
            </label>
          </div>

          <div className="rounded-xl border border-dashed border-navy-200 bg-navy-50/30 p-4">
            <div className="flex flex-wrap items-start gap-4">
              <span
                role={previewUrl ? 'img' : undefined}
                aria-label={previewUrl ? 'Bangla QR image preview' : undefined}
                style={previewUrl ? { backgroundImage: `url("${previewUrl}")`, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'contain' } : undefined}
                className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-300"
              >
                {!previewUrl && <QrCode className="h-10 w-10" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-navy-950">{editing?.qrCodeUrl ? 'Replace QR Code' : 'Upload QR Code'}</p>
                <p className="mt-1 text-xs text-neutral-500">SVG, PNG, WebP or JPEG, up to 512 KB. The account stays inactive until a QR code is available.</p>
                <input ref={qrInputRef} type="file" accept={LOGO_ACCEPT} disabled={disabled || !uploadConfigured} onChange={(event) => selectFile(event.target.files?.[0])} className="mt-3 block w-full text-xs text-neutral-600 file:mr-2 file:rounded-md file:border-0 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-navy-950 disabled:opacity-60" />
                {qrFile && (
                  <button type="button" disabled={disabled} onClick={clearFile} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-red-700 disabled:opacity-60">
                    <X className="h-3.5 w-3.5" /> Clear selected image
                  </button>
                )}
              </div>
            </div>
          </div>

          <button disabled={disabled} className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60">
            {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {busy === 'form' ? 'Saving…' : editing ? 'Save Changes' : 'Add Bangla QR Account'}
          </button>
        </form>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-navy-950">Configured Bangla QR accounts</h3>
            <span className="rounded-full bg-navy-50 px-2.5 py-1 text-xs font-bold text-navy-700">{accounts.length} total</span>
          </div>
          <div className="space-y-3">
            {loading && accounts.length === 0 ? (
              <p className="rounded-lg border border-neutral-200 px-4 py-8 text-center text-sm text-neutral-500">Loading Bangla QR accounts&hellip;</p>
            ) : accounts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">No payment receiving Bangla QR account has been added yet.</p>
            ) : accounts.map((account) => (
              <article key={account.id} className={`rounded-xl border p-4 ${account.active ? 'border-navy-100 bg-navy-50/40' : 'border-neutral-200 bg-neutral-50'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-navy-950">{account.merchantName}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${account.active ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-200 text-neutral-600'}`}>
                        {account.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {account.bankName && <p className="mt-1 text-sm text-neutral-700">{account.bankName}</p>}
                    {account.merchantId && <p className="mt-1 text-xs text-neutral-500">Merchant / TID: {account.merchantId}</p>}
                    {!account.qrCodeUrl && <p className="mt-2 text-xs text-amber-700">Upload a QR code to activate this account.</p>}
                  </div>
                  {account.qrCodeUrl && (
                    <a href={account.qrCodeUrl} target="_blank" rel="noreferrer" className="shrink-0" aria-label={`Open ${account.merchantName} QR code`}>
                      <Image src={account.qrCodeUrl} alt={`${account.merchantName} Bangla QR code`} width={112} height={112} unoptimized className="h-28 w-28 rounded-lg border border-neutral-200 bg-white object-contain p-1" />
                    </a>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={disabled} onClick={() => { setEditing(account); setDraft(draftFrom(account)); clearFile(); setNotice(null); }} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-950 disabled:opacity-60">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button type="button" disabled={disabled || (!account.active && !account.qrCodeUrl)} onClick={() => void toggle(account)} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-950 disabled:opacity-60">
                    <Power className="h-3.5 w-3.5" /> {account.active ? 'Deactivate' : 'Activate'}
                  </button>
                  {account.qrCodeUrl && (
                    <button type="button" disabled={disabled} onClick={() => void removeQr(account)} className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 hover:text-red-700 disabled:opacity-60">
                      <Trash2 className="h-3.5 w-3.5" /> Remove QR
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
