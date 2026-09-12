'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Paperclip,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import {
  loadUserProfile,
  removeUserAgencyLogo,
  saveUserProfile,
  uploadUserAgencyLogo,
  type ProfileDetail,
  type UserActionResult,
} from '@/app/(dashboard)/dashboard/users/actions';
import {
  EMPTY_PROFILE,
  GENDER_OPTIONS,
  isFileField,
  profileTitleFor,
  sectionsFor,
  type FieldSpec,
  type ProfileValues,
} from '@/lib/profile';
import { ROLE_LABELS } from '@/lib/roles';
import {
  LOGO_ACCEPT,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';

interface Props {
  /** Whose profile to open. */
  clerkId: string;
  /** Their name, so the heading is filled in before the fetch lands. */
  name: string;
  onClose: () => void;
  /** Called after a successful save, so the roster can refresh behind us. */
  onSaved: () => void;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-md border border-navy-100 px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:cursor-not-allowed disabled:bg-navy-50';

/**
 * One editable field. File fields never reach here — they render as links.
 */
function Field({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const label = (
    <span className="text-xs text-navy-700/70">{spec.label}</span>
  );

  if (spec.type === 'select') {
    return (
      <label className="block">
        {label}
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Not set</option>
          {GENDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (spec.type === 'textarea') {
    return (
      <label className="block">
        {label}
        <textarea
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input
        type={spec.type}
        value={value}
        disabled={disabled}
        placeholder={spec.placeholder}
        onChange={(e) =>
          onChange(spec.uppercase ? e.target.value.toUpperCase() : e.target.value)
        }
        className={INPUT_CLASS}
      />
    </label>
  );
}

/**
 * One account's profile, opened from the roster by an Admin or Super Admin.
 *
 * The sections come from the **target's** role, not the reader's, which is what
 * makes one dialog cover both cases the roster holds: a B2B partner shows
 * Business Info, Business Docs and the agency's bank account, a customer shows
 * their personal details and their own.
 *
 * Text fields are editable and save through `saveUserProfile()`, which re-reads
 * the stored row and merges over it — so the sections this dialog never showed
 * for a given role cannot be blanked by saving it. Sensitive business
 * documents stay read-only links; the agency logo is the one exception because
 * Admin and Super Admin are allowed to maintain that shared branding.
 */
export default function UserDetailsDialog({
  clerkId,
  name,
  onClose,
  onSaved,
}: Props) {
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [values, setValues] = useState<ProfileValues>({ ...EMPTY_PROFILE });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<UserActionResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmLogoRemove, setConfirmLogoRemove] = useState(false);
  const [saving, startSaving] = useTransition();
  const [logoSaving, startLogoSaving] = useTransition();
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;

    loadUserProfile(clerkId)
      .then((result) => {
        // The dialog may have been closed while the request was in flight.
        if (!live) return;
        if (result.ok) {
          setDetail(result.detail);
          setValues(result.detail.values);
        } else {
          setError(result.message);
        }
      })
      // Without this the dialog sits on "Loading…" forever when the action
      // itself cannot be reached.
      .catch(() => {
        if (live) setError('These details could not be loaded. Try again.');
      });

    return () => {
      live = false;
    };
  }, [clerkId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function edit(field: keyof ProfileValues, next: string) {
    setValues((current) => ({ ...current, [field]: next }));
    setDirty(true);
    setNotice(null);
  }

  function save() {
    startSaving(async () => {
      const result = await saveUserProfile(clerkId, values);
      setNotice(result);
      if (result.ok) {
        setDirty(false);
        onSaved();
      }
    });
  }

  function replaceLogo(file: File | undefined) {
    if (!file) return;
    if (!LOGO_EXTENSIONS[file.type]) {
      setNotice({ ok: false, message: 'Use an SVG, PNG, WebP or JPEG file.' });
      if (logoInputRef.current) logoInputRef.current.value = '';
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setNotice({ ok: false, message: 'That file is over the 512 KB limit.' });
      if (logoInputRef.current) logoInputRef.current.value = '';
      return;
    }

    const data = new FormData();
    data.set('clerkId', clerkId);
    data.set('logo', file);
    setNotice(null);
    setConfirmLogoRemove(false);

    startLogoSaving(async () => {
      const result = await uploadUserAgencyLogo(data);
      setNotice(result);
      if (logoInputRef.current) logoInputRef.current.value = '';
      if (!result.ok) return;

      setDetail((current) => {
        if (!current) return current;
        const docs = { ...current.docs };
        if (result.doc) docs.logo = result.doc;
        else delete docs.logo;
        return { ...current, docs };
      });
      onSaved();
    });
  }

  function removeLogo() {
    setNotice(null);
    startLogoSaving(async () => {
      const result = await removeUserAgencyLogo(clerkId);
      setNotice(result);
      setConfirmLogoRemove(false);
      if (!result.ok) return;

      setDetail((current) => {
        if (!current) return current;
        const docs = { ...current.docs };
        delete docs.logo;
        return { ...current, docs };
      });
      onSaved();
    });
  }

  const sections = detail ? sectionsFor(detail.role) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Account details for ${name}`}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-950/60 p-4 sm:items-center"
    >
      {/* A sibling rather than a parent of the panel, so it cannot swallow
          clicks meant for the fields inside it. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative w-full max-w-2xl rounded-lg border border-navy-100 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-navy-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-navy-950">
              {detail ? profileTitleFor(detail.role) : 'Account details'} —{' '}
              {name}
            </h2>
            <p className="mt-0.5 truncate text-xs text-navy-700/70">
              {detail
                ? `${ROLE_LABELS[detail.role]} · ${detail.email}`
                : 'Loading the details…'}
            </p>
            {detail?.agencyCode && (
              <p className="mt-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-navy-50 px-2.5 py-1 text-xs text-navy-700">
                  Agency ID
                  <span className="font-mono font-semibold tracking-wider text-navy-950">
                    {detail.agencyCode}
                  </span>
                </span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-navy-700/70 transition hover:bg-navy-50 hover:text-navy-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            className={`flex items-start gap-2 border-b px-5 py-3 text-sm ${
              notice.ok
                ? 'border-navy-100 bg-navy-50 text-navy-900'
                : 'border-red-100 bg-red-50 text-red-700'
            }`}
          >
            {notice.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{notice.message}</span>
          </div>
        )}

        {!detail && !error && (
          <p className="flex items-center gap-2 px-5 py-10 text-sm text-navy-700/70">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </p>
        )}

        {detail && (
          <div className="max-h-[60vh] space-y-6 overflow-y-auto px-5 py-4">
            {sections.map((section) => (
              <section key={section.id}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-700/60">
                  {section.title}
                </h3>

                <div className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {section.fields.map((spec) => {
                    // Sensitive documents stay as links. Agency logo is the
                    // explicit manager-editable exception.
                    if (isFileField(spec.name)) {
                      const doc = detail.docs[spec.name];
                      const editableAgencyLogo =
                        spec.name === 'logo' &&
                        (detail.role === 'b2b' || detail.role === 'b2b_sub');

                      if (editableAgencyLogo) {
                        return (
                          <div key={spec.name} className="sm:col-span-2">
                            <span className="text-xs text-navy-700/70">
                              Agency Logo
                            </span>
                            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-navy-200 bg-navy-50/50 px-3 py-2.5">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-navy-700 shadow-sm">
                                {logoSaving ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Upload className="h-4 w-4" />
                                )}
                              </span>
                              <span className="min-w-28 flex-1 text-sm text-navy-950">
                                {doc ? 'Logo uploaded' : 'No agency logo yet'}
                                <span className="block text-xs text-navy-700/60">
                                  SVG, PNG, WebP or JPEG · max 512 KB
                                </span>
                              </span>
                              {doc && (
                                <a
                                  href={doc.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-semibold text-navy-900 transition hover:text-brand-orange"
                                >
                                  View
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                              <button
                                type="button"
                                disabled={logoSaving || saving}
                                onClick={() => logoInputRef.current?.click()}
                                className="text-xs font-semibold text-brand-orange transition hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {doc ? 'Replace' : 'Upload'}
                              </button>
                              {doc && (
                                <button
                                  type="button"
                                  disabled={logoSaving || saving}
                                  onClick={() =>
                                    confirmLogoRemove
                                      ? removeLogo()
                                      : setConfirmLogoRemove(true)
                                  }
                                  onBlur={() => setConfirmLogoRemove(false)}
                                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50 ${
                                    confirmLogoRemove
                                      ? 'bg-brand-orange-light text-brand-orange-dark'
                                      : 'text-navy-700/70 hover:bg-red-50 hover:text-red-600'
                                  }`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                  {confirmLogoRemove ? 'Confirm' : 'Remove'}
                                </button>
                              )}
                              <input
                                ref={logoInputRef}
                                type="file"
                                accept={LOGO_ACCEPT}
                                disabled={logoSaving || saving}
                                className="sr-only"
                                onChange={(event) =>
                                  replaceLogo(event.target.files?.[0])
                                }
                              />
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={spec.name}>
                          <span className="text-xs text-navy-700/70">
                            {spec.label}
                          </span>
                          <p className="mt-1 text-sm font-medium text-navy-950">
                            {doc ? (
                              <a
                                href={doc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 rounded-md bg-navy-50 px-2.5 py-1.5 text-sm font-medium text-navy-900 transition hover:bg-navy-100"
                              >
                                <Paperclip className="h-3.5 w-3.5" />
                                {doc.label}
                                <ExternalLink className="h-3 w-3 text-navy-700/60" />
                              </a>
                            ) : (
                              <span className="text-navy-700/70">
                                Not uploaded
                              </span>
                            )}
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={spec.name}
                        className={spec.wide ? 'sm:col-span-2' : undefined}
                      >
                        <Field
                          spec={spec}
                          value={values[spec.name]}
                          disabled={saving}
                          onChange={(next) => edit(spec.name, next)}
                        />
                      </div>
                    );
                  })}
                </div>

                {section.id === 'documents' && (
                  <p className="mt-2 text-xs text-navy-700/60">
                    Admins can replace the agency logo here. Other documents
                    remain controlled by the account holder. Document links
                    expire a few minutes after this dialog was opened.
                  </p>
                )}
              </section>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-navy-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-navy-100 px-4 py-2 text-sm font-medium text-navy-900 transition hover:border-brand-orange hover:text-brand-orange"
          >
            Close
          </button>
          {detail && (
            <button
              type="button"
              disabled={saving || logoSaving || !dirty}
              onClick={save}
              className="inline-flex items-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
