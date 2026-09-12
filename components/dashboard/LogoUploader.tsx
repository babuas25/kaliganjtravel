'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, ImageIcon, Trash2, Upload } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  LOGO_ACCEPT,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
} from '@/lib/upload-verify';
// Type-only, so the Cloudinary SDK behind it never reaches this bundle.
import type { SiteLogo } from '@/lib/appearance';
import {
  removeSiteLogo,
  uploadSiteLogo,
  type AppearanceResult,
} from '@/app/(dashboard)/dashboard/appearance/actions';

interface Props {
  logo: SiteLogo | null;
  /** False when the Cloudinary env vars are missing — uploads cannot work. */
  configured: boolean;
}

const MAX_KB = Math.round(LOGO_MAX_BYTES / 1024);
const FORMATS = 'SVG, PNG, WebP or JPEG';

function readableSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Upload, replace and remove the site logo. The same file is used on the
 * public header, the dashboard sidebar, the auth pages and the favicon, so the
 * previews below show it on both a light and a dark background — a mark that
 * only works on one of them is the easiest mistake to make here.
 */
export default function LogoUploader({ logo, configured }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<AppearanceResult | null>(null);

  // Object URLs leak until revoked, and a picker can churn through several.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function clearSelection() {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function select(next: File | undefined) {
    if (!next) return;

    if (!LOGO_EXTENSIONS[next.type]) {
      setNotice({ ok: false, message: `Use a ${FORMATS} file.` });
      return;
    }
    if (next.size > LOGO_MAX_BYTES) {
      setNotice({
        ok: false,
        message: `${readableSize(next.size)} is over the ${MAX_KB} KB limit.`,
      });
      return;
    }

    setNotice(null);
    setConfirmRemove(false);
    setFile(next);
  }

  function save() {
    if (!file) return;

    const data = new FormData();
    data.append('logo', file);

    startTransition(async () => {
      const result = await uploadSiteLogo(data);
      setNotice(result);
      if (result.ok) {
        clearSelection();
        // The action revalidated the tree; pull the new logo into this page.
        router.refresh();
      }
    });
  }

  function remove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }

    startTransition(async () => {
      const result = await removeSiteLogo();
      setNotice(result);
      setConfirmRemove(false);
      if (result.ok) router.refresh();
    });
  }

  // What the site would show right now: the pending pick wins over the saved one.
  const shownUrl = previewUrl ?? logo?.url ?? null;
  const disabled = !configured || pending;

  return (
    <section className="overflow-hidden rounded-lg border border-navy-100 bg-white">
      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
          <ImageIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-navy-950">Website logo</h3>
          <p className="mt-0.5 text-xs text-navy-700/70">
            Shown in the site header, the dashboard sidebar, the sign-in pages
            and the browser tab.
          </p>
        </div>
      </header>

      <div className="space-y-5 px-5 py-5">
        {!configured && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Cloudinary isn&apos;t configured, so uploads are disabled. Set{' '}
              <code className="font-semibold">CLOUDINARY_CLOUD_NAME</code>,{' '}
              <code className="font-semibold">CLOUDINARY_API_KEY</code> and{' '}
              <code className="font-semibold">CLOUDINARY_API_SECRET</code>.
            </span>
          </p>
        )}

        {/* Drop zone */}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!disabled) select(event.dataTransfer.files?.[0]);
          }}
          className={cn(
            'rounded-md border border-dashed px-4 py-6 text-center transition',
            dragging
              ? 'border-brand-orange bg-navy-50/60'
              : 'border-navy-200 bg-navy-50/30',
            disabled && 'opacity-60'
          )}
        >
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-white text-navy-700 shadow-sm">
            <Upload className="h-4 w-4" />
          </span>

          <p className="mt-3 text-sm text-navy-950">
            Drag an image here, or{' '}
            <button
              type="button"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              className="font-semibold text-brand-orange underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60"
            >
              browse your files
            </button>
          </p>
          <p className="mt-1 text-xs text-navy-700/60">
            {FORMATS} · up to {MAX_KB} KB · a wide, transparent mark works best
          </p>

          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            disabled={disabled}
            className="sr-only"
            onChange={(event) => select(event.target.files?.[0])}
          />
        </div>

        {/* Previews */}
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewTile label="On light background" tone="light" url={shownUrl} />
          <PreviewTile label="On dark background" tone="dark" url={shownUrl} />
        </div>

        <p className="text-xs text-navy-700/60">
          {file
            ? `Selected: ${file.name} (${readableSize(file.size)}) — not saved yet.`
            : logo
              ? `Current file: ${logo.filename}`
              : 'No logo uploaded — the site shows its built-in “ST” mark.'}
        </p>

        {notice && (
          <p
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2.5 text-xs',
              notice.ok
                ? 'bg-emerald-50 text-emerald-900'
                : 'bg-brand-orange-light text-brand-orange-dark'
            )}
          >
            {notice.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {notice.message}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={disabled || !file}
            className="inline-flex items-center gap-2 rounded-full bg-brand-orange px-5 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Working…' : logo ? 'Replace logo' : 'Save logo'}
          </button>

          {file && (
            <button
              type="button"
              onClick={() => {
                clearSelection();
                setNotice(null);
              }}
              disabled={pending}
              className="rounded-full px-4 py-2 text-sm font-medium text-navy-700 transition hover:bg-navy-50 disabled:opacity-50"
            >
              Cancel
            </button>
          )}

          {logo && !file && (
            <button
              type="button"
              onClick={remove}
              onBlur={() => setConfirmRemove(false)}
              disabled={disabled}
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50',
                confirmRemove
                  ? 'bg-brand-orange-light text-brand-orange-dark'
                  : 'text-navy-700 hover:bg-navy-50'
              )}
            >
              <Trash2 className="h-4 w-4" />
              {confirmRemove ? 'Click again to confirm' : 'Remove logo'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PreviewTile({
  label,
  tone,
  url,
}: {
  label: string;
  tone: 'light' | 'dark';
  url: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-navy-100">
      <div
        className={cn(
          'flex h-24 items-center justify-center px-4',
          tone === 'light' ? 'bg-white' : 'bg-navy-900'
        )}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={`Logo preview ${label.toLowerCase()}`}
            className="max-h-14 max-w-[70%] object-contain"
          />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-orange text-sm font-bold text-navy-950">
            ST
          </span>
        )}
      </div>
      <p className="border-t border-navy-100 bg-navy-50/50 px-3 py-1.5 text-center text-[11px] text-navy-700/70">
        {label}
      </p>
    </div>
  );
}
