'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';

import {
  removeFlightSearchBackgroundAction,
  uploadFlightSearchBackgroundAction,
  type MediaBackgroundActionResult,
} from '@/app/(dashboard)/dashboard/media/actions';
import type { FlightSearchBackground } from '@/lib/flight-search-background';
import {
  FLIGHT_SEARCH_BACKGROUND_ACCEPT,
  FLIGHT_SEARCH_BACKGROUND_EXTENSIONS,
  FLIGHT_SEARCH_BACKGROUND_HINT,
  FLIGHT_SEARCH_BACKGROUND_MAX_BYTES,
  flightSearchBackgroundDimensionError,
} from '@/lib/upload-verify';

type Props = {
  background: FlightSearchBackground | null;
  configured: boolean;
};

function readableSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function FlightSearchBackgroundManager({
  background,
  configured,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(
    null
  );
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<MediaBackgroundActionResult | null>(null);

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
    setDimensions(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function select(next: File | undefined) {
    if (!next) return;
    if (!FLIGHT_SEARCH_BACKGROUND_EXTENSIONS[next.type]) {
      setNotice({ ok: false, message: 'Use a JPEG, PNG or WebP image.' });
      return;
    }
    if (next.size > FLIGHT_SEARCH_BACKGROUND_MAX_BYTES) {
      setNotice({
        ok: false,
        message: `${readableSize(next.size)} is over the 2 MB limit.`,
      });
      return;
    }

    try {
      const bitmap = await createImageBitmap(next);
      const nextDimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const dimensionError = flightSearchBackgroundDimensionError(
        nextDimensions.width,
        nextDimensions.height
      );
      if (dimensionError) {
        setNotice({ ok: false, message: dimensionError });
        return;
      }
      setDimensions(nextDimensions);
    } catch {
      setNotice({ ok: false, message: 'That image could not be read.' });
      return;
    }

    setFile(next);
    setConfirmRemove(false);
    setNotice(null);
  }

  function upload() {
    if (!file) return;
    const formData = new FormData();
    formData.append('background', file);

    startTransition(async () => {
      const result = await uploadFlightSearchBackgroundAction(formData);
      setNotice(result);
      if (result.ok) {
        clearSelection();
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
      const result = await removeFlightSearchBackgroundAction();
      setNotice(result);
      setConfirmRemove(false);
      if (result.ok) router.refresh();
    });
  }

  const shownUrl = previewUrl ?? background?.url ?? null;
  const disabled = !configured || isPending;

  return (
    <section className="overflow-hidden rounded-2xl border border-navy-100 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-orange/10 text-brand-orange">
          <ImageIcon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-navy-950">
            Flight-search background image
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-navy-700/70">
            Shown behind the booking form on Dashboard → Flight Search. The band’s
            height and full-width layout remain unchanged.
          </p>
        </div>
      </header>

      <div className="space-y-5 p-5">
        {!configured ? (
          <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Cloudinary is not configured, so image uploads are unavailable.
          </p>
        ) : null}

        <div className="rounded-lg border border-navy-100 bg-navy-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-navy-700">
            Image requirements
          </p>
          <p className="mt-2 text-sm font-medium text-navy-950">
            {FLIGHT_SEARCH_BACKGROUND_HINT}
          </p>
          <p className="mt-1 text-xs text-navy-700/70">
            Keep important subjects near the center because the image uses “cover” and
            may crop slightly on different screen widths.
          </p>
          <p className="mt-1 text-xs text-navy-700/70">
            Cloudinary automatically delivers an optimized 1920 × 360 crop in the
            best format supported by each browser; the original upload is retained.
          </p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-navy-950">Preview</p>
            {dimensions ? (
              <span className="text-xs text-navy-700">
                {dimensions.width} × {dimensions.height} px
              </span>
            ) : background?.width && background.height ? (
              <span className="text-xs text-navy-700">
                {background.width} × {background.height} px
              </span>
            ) : null}
          </div>
          <div
            className={`h-36 overflow-hidden rounded-lg border border-navy-100 bg-search-gradient bg-cover bg-center ${
              shownUrl ? '' : 'flex items-center justify-center'
            }`}
            style={shownUrl ? { backgroundImage: `url("${shownUrl}")` } : undefined}
          >
            {!shownUrl ? (
              <p className="px-4 text-center text-sm font-medium text-white">
                No image uploaded — the gradient fallback is active.
              </p>
            ) : null}
          </div>
          {background && !file ? (
            <p className="mt-2 text-xs text-navy-700/70">
              Current file: {background.filename}
            </p>
          ) : null}
        </div>

        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void select(event.dataTransfer.files[0]);
          }}
          className={`rounded-xl border-2 border-dashed p-5 text-center transition ${
            dragging ? 'border-brand-orange bg-brand-orange/5' : 'border-navy-200 bg-white'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept={FLIGHT_SEARCH_BACKGROUND_ACCEPT}
            disabled={disabled}
            onChange={(event) => void select(event.target.files?.[0])}
            className="sr-only"
          />
          <Upload className="mx-auto h-6 w-6 text-navy-700" />
          <p className="mt-2 text-sm font-medium text-navy-950">
            Drop a background image here
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            className="mt-3 rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Choose image
          </button>
        </div>

        {file ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy-50 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-navy-950">{file.name}</p>
              <p className="text-xs text-navy-700/70">
                {readableSize(file.size)}
                {dimensions ? ` · ${dimensions.width} × ${dimensions.height} px` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearSelection}
                disabled={isPending}
                className="rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold text-navy-950 hover:bg-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={upload}
                disabled={disabled}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-50"
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {isPending ? 'Uploading…' : background ? 'Replace image' : 'Upload image'}
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p
            className={`flex items-start gap-2 text-sm ${
              notice.ok ? 'text-emerald-700' : 'text-brand-orange-dark'
            }`}
          >
            {notice.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {notice.message}
          </p>
        ) : null}

        {background && !file ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={remove}
              disabled={disabled}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${
                confirmRemove
                  ? 'bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white'
                  : 'border border-navy-200 text-brand-orange hover:bg-brand-orange/5'
              }`}
            >
              <Trash2 className="h-4 w-4" />
              {confirmRemove ? 'Confirm removal' : 'Remove image'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
