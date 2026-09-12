'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  Check,
  Loader2,
  Paperclip,
  Rocket,
  User,
  X,
} from 'lucide-react';

import { submitUpgradeRequestAction } from '@/app/(dashboard)/dashboard/upgrade/actions';
import { cn } from '@/lib/utils';
import { DOC_ACCEPT, DOC_HINT, DOC_MAX_BYTES } from '@/lib/upload-verify';
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  EMPTY_UPGRADE,
  MAX_UPGRADE_DOCS,
  UPGRADE_SECTIONS,
  upgradeBlockedReason,
  type UpgradeField,
  type UpgradeFieldSpec,
  type UpgradeValues,
} from '@/lib/upgrade';

const CONTROL_CLASS =
  'mt-1.5 w-full rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20';

const LABEL_CLASS = 'text-sm font-medium text-navy-950';

/** One icon per section, in the order `UPGRADE_SECTIONS` declares them. */
const SECTION_ICONS = [Building2, User];

interface Props {
  /**
   * Prefill from the signed-in account and, where they exist, the answers of a
   * rejected application being corrected. Never a pending one — that is not
   * editable, and the page shows its status instead of this form.
   */
  defaults?: Partial<UpgradeValues>;
}

export default function UpgradeRequestForm({ defaults }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<UpgradeValues>({
    ...EMPTY_UPGRADE,
    ...defaults,
  });
  const [docs, setDocs] = useState<File[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [pending, startTransition] = useTransition();
  // Held so the picked files can be cleared from the input itself; dropping
  // them from state alone leaves the native control showing "3 files selected".
  const fileInput = useRef<HTMLInputElement>(null);

  const blocked = upgradeBlockedReason(values);

  function set(field: UpgradeField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setNotice(null);
  }

  /**
   * The server checks all of this again. Doing it here too is what turns "the
   * upload did not complete" into a sentence naming the file, before anybody
   * waits for five megabytes to travel.
   */
  function chooseDocs(files: FileList | null) {
    const chosen = Array.from(files ?? []);
    setNotice(null);

    if (chosen.length > MAX_UPGRADE_DOCS) {
      setNotice({
        ok: false,
        text: `Attach at most ${MAX_UPGRADE_DOCS} documents.`,
      });
      return;
    }

    const tooBig = chosen.find((file) => file.size > DOC_MAX_BYTES);
    if (tooBig) {
      setNotice({ ok: false, text: `“${tooBig.name}” is over the 5 MB limit.` });
      return;
    }

    setDocs(chosen);
  }

  function clearDocs() {
    setDocs([]);
    if (fileInput.current) fileInput.current.value = '';
  }

  function submit() {
    if (blocked) {
      setNotice({ ok: false, text: blocked });
      return;
    }

    const formData = new FormData();
    for (const [field, value] of Object.entries(values)) {
      formData.append(field, value.trim());
    }
    for (const file of docs) formData.append('docs', file);

    startTransition(async () => {
      const result = await submitUpgradeRequestAction(formData);
      setNotice({ ok: result.ok, text: result.message });
      if (result.ok) {
        clearDocs();
        // The page re-renders as the "with our team" panel: the form is gone
        // once there is a pending application, so this is what swaps it out.
        router.refresh();
      }
    });
  }

  function renderField(spec: UpgradeFieldSpec) {
    if (spec.type === 'radio') {
      return (
        <fieldset key={spec.name} className="sm:col-span-2">
          <legend className={LABEL_CLASS}>{spec.label}</legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {BUSINESS_TYPES.map((type) => {
              const active = values[spec.name] === type;
              return (
                <label
                  key={type}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition',
                    active
                      ? 'border-brand-orange bg-brand-orange-light text-brand-orange-dark'
                      : 'border-navy-100 bg-white text-navy-900 hover:border-navy-200'
                  )}
                >
                  <input
                    type="radio"
                    name={spec.name}
                    value={type}
                    checked={active}
                    onChange={() => set(spec.name, type)}
                    className="h-4 w-4 accent-brand-orange"
                  />
                  {BUSINESS_TYPE_LABELS[type]}
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }

    return (
      <label
        key={spec.name}
        className={cn('block', spec.wide && 'sm:col-span-2')}
      >
        <span className={LABEL_CLASS}>{spec.label}</span>
        {spec.type === 'textarea' ? (
          <textarea
            rows={3}
            value={values[spec.name]}
            onChange={(e) => set(spec.name, e.target.value)}
            placeholder={spec.placeholder}
            className={CONTROL_CLASS}
          />
        ) : (
          <input
            type={spec.type}
            value={values[spec.name]}
            onChange={(e) => set(spec.name, e.target.value)}
            placeholder={spec.placeholder}
            className={CONTROL_CLASS}
          />
        )}
      </label>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {UPGRADE_SECTIONS.map((section, index) => {
        const Icon = SECTION_ICONS[index] ?? Building2;

        return (
          <section
            key={section.title}
            className="rounded-lg border border-navy-100 bg-white"
          >
            <div className="flex items-start gap-3 border-b border-navy-100 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-navy-700">
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-navy-950">
                  {section.title}
                </h2>
                <p className="text-xs text-navy-700/70">{section.hint}</p>
              </div>
            </div>

            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              {section.fields.map(renderField)}
            </div>
          </section>
        );
      })}

      {/* Optional, and genuinely so — the submit does not wait on it. */}
      <section className="rounded-lg border border-navy-100 bg-white">
        <div className="flex items-start gap-3 border-b border-navy-100 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-navy-700">
            <Paperclip className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-navy-950">
              Documents{' '}
              <span className="font-normal text-navy-700/70">(optional)</span>
            </h2>
            <p className="text-xs text-navy-700/70">
              Trade licence, TIN certificate, agency licence or NID — up to{' '}
              {MAX_UPGRADE_DOCS}. {DOC_HINT} Only our review team can open
              these.
            </p>
          </div>
        </div>

        <div className="px-4 py-4">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={DOC_ACCEPT}
            onChange={(e) => chooseDocs(e.target.files)}
            className="block w-full text-sm text-navy-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-orange file:px-3 file:py-2 file:text-sm file:font-medium file:text-black hover:file:bg-brand-orange/90"
          />

          {docs.length > 0 && (
            <ul className="mt-3 space-y-1">
              {docs.map((file) => (
                <li
                  key={file.name}
                  className="flex items-center justify-between gap-3 rounded-md bg-navy-50 px-3 py-2 text-sm text-navy-900"
                >
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-navy-700/70">
                    {Math.max(1, Math.round(file.size / 1024))} KB
                  </span>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={clearDocs}
                  className="inline-flex items-center gap-1 text-xs font-medium text-navy-700/70 transition hover:text-brand-orange"
                >
                  <X className="h-3 w-3" />
                  Clear
                </button>
              </li>
            </ul>
          )}
        </div>
      </section>

      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
            notice.ok
              ? 'border-navy-100 bg-navy-50 text-navy-900'
              : 'border-red-100 bg-red-50 text-red-700'
          )}
        >
          {notice.ok ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || blocked !== null}
          title={blocked ?? undefined}
          className="inline-flex items-center gap-2 rounded-full bg-yellow-400 px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Rocket className="h-4 w-4" />
          )}
          Submit application
        </button>

        <p className="text-xs text-navy-700/70">
          {blocked ?? 'Our team reviews applications and replies on this page.'}
        </p>
      </div>
    </form>
  );
}
