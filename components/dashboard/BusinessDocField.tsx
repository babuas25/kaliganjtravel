'use client';

import { useRef, useState, useTransition } from 'react';
import { ExternalLink, Loader2, Trash2, Upload } from 'lucide-react';

import {
  removeBusinessDocument,
  uploadBusinessDocument,
  type DocumentActionResult,
} from '@/app/(dashboard)/dashboard/profile/actions';
import { cn } from '@/lib/utils';
import { DOC_ACCEPT, DOC_EXTENSIONS, DOC_MAX_BYTES } from '@/lib/upload-verify';
import type { FieldSpec } from '@/lib/profile';

export type SignedDocLink = { url: string; label: string };

interface Props {
  field: FieldSpec;
  /** Signed link to the stored document, or undefined when there is none. */
  link?: SignedDocLink;
  /** Disabled with a reason when Cloudinary is unconfigured. */
  disabledReason?: string;
  /** Hands the refreshed link map back up, so sibling fields stay current. */
  onChanged: (result: DocumentActionResult) => void;
}

/**
 * One business document: upload, view, replace, remove.
 *
 * **It writes on pick, not on Save.** The profile's Save submits every text
 * field at once and a file cannot join that payload; more to the point, a
 * document should not be waiting on a button that also rewrites the passport
 * page. Each field owns its own action, so what is on screen is what is stored.
 *
 * The link is signed and short-lived. `onChanged` carries a fresh map back to
 * the form after every write, which is what keeps the other four fields'
 * links from going stale while this one is being worked on.
 */
export default function BusinessDocField({
  field,
  link,
  disabledReason,
  onChanged,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const disabled = Boolean(disabledReason) || pending;

  function run(action: () => Promise<DocumentActionResult>) {
    startTransition(async () => {
      const result = await action();
      setError(result.ok ? null : result.message);
      setConfirmRemove(false);
      if (result.ok) onChanged(result);
      if (inputRef.current) inputRef.current.value = '';
    });
  }

  /**
   * Checked here as well as on the server. It is the difference between a
   * sentence naming the file and a wait followed by a refusal.
   */
  function select(file: File | undefined) {
    if (!file) return;

    if (!DOC_EXTENSIONS[file.type]) {
      setError('Use a PDF, PNG, JPEG or WebP file.');
      return;
    }
    if (file.size > DOC_MAX_BYTES) {
      setError(`That file is over the ${Math.round(DOC_MAX_BYTES / 1024 / 1024)} MB limit.`);
      return;
    }

    setError(null);
    const data = new FormData();
    data.append('field', field.name);
    data.append('file', file);
    run(() => uploadBusinessDocument(data));
  }

  return (
    <div className={cn('block', field.wide && 'sm:col-span-2')}>
      <span className="text-sm font-medium text-navy-950">{field.label}</span>

      <div
        className={cn(
          'mt-1.5 flex items-center gap-3 rounded-md border border-dashed px-3 py-2.5 transition',
          link ? 'border-navy-200 bg-navy-50/50' : 'border-navy-200',
          disabled && 'opacity-60'
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-navy-700 shadow-sm">
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-navy-950">
            {link ? 'Uploaded' : 'No file yet'}
          </span>
          <span className="block text-xs text-navy-700/60">
            {field.accepts}
          </span>
        </span>

        {link && (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-navy-900 transition hover:text-brand-orange"
          >
            View
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        <button
          type="button"
          disabled={disabled}
          title={disabledReason}
          onClick={() => inputRef.current?.click()}
          className="shrink-0 text-xs font-semibold text-brand-orange transition hover:underline disabled:cursor-not-allowed disabled:no-underline"
        >
          {link ? 'Replace' : 'Browse'}
        </button>

        {link && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              confirmRemove
                ? run(() => removeBusinessDocument(field.name))
                : setConfirmRemove(true)
            }
            onBlur={() => setConfirmRemove(false)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50',
              confirmRemove
                ? 'bg-brand-orange-light text-brand-orange-dark'
                : 'text-navy-700/70 hover:bg-red-50 hover:text-red-600'
            )}
          >
            <Trash2 className="h-3 w-3" />
            {confirmRemove ? 'Confirm' : 'Remove'}
          </button>
        )}

        {/* Deliberately unnamed. It sits inside the profile <form>, but that
            form submits an explicit values object rather than its DOM, so this
            file never reaches `saveProfileAction` — it goes through the
            document action above instead. */}
        <input
          ref={inputRef}
          type="file"
          accept={DOC_ACCEPT}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => select(event.target.files?.[0])}
        />
      </div>

      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}
