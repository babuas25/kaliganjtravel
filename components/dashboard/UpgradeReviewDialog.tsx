'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Paperclip,
  X,
} from 'lucide-react';

import {
  decideUpgradeRequest,
  loadUpgradeRequest,
  type UpgradeDetail,
  type UserActionResult,
} from '@/app/(dashboard)/dashboard/users/actions';
import {
  BUSINESS_TYPE_LABELS,
  isBusinessType,
  UPGRADE_SECTIONS,
} from '@/lib/upgrade';

/** Fixed locale and zone, matching the roster's dates. */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

interface Props {
  /** Whose application to review. */
  clerkId: string;
  /** Their name, for the dialog heading — the roster already knows it. */
  name: string;
  onClose: () => void;
  /** Called with the outcome so the table can show it and refresh. */
  onDecided: (result: UserActionResult) => void;
}

/**
 * The summary an admin reads before accepting or rejecting an upgrade.
 *
 * The application is fetched when the dialog opens rather than carried in the
 * roster's props: it is somebody's home address and phone number, and the
 * document links are live signatures over their identity papers. Neither has
 * any business being in the HTML of a page opened to do something else.
 */
export default function UpgradeReviewDialog({
  clerkId,
  name,
  onClose,
  onDecided,
}: Props) {
  const [detail, setDetail] = useState<UpgradeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;

    loadUpgradeRequest(clerkId).then((result) => {
      // The dialog may have been closed while the request was in flight.
      if (!live) return;
      if (result.ok) setDetail(result.detail);
      else setError(result.message);
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

  function decide(decision: 'accept' | 'reject') {
    startTransition(async () => {
      onDecided(await decideUpgradeRequest(clerkId, decision, note));
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Upgrade application from ${name}`}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-950/60 p-4 sm:items-center"
    >
      {/* A sibling rather than a parent of the panel: a backdrop wrapping the
          content would swallow clicks meant for the form inside it. */}
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
              Upgrade application — {name}
            </h2>
            <p className="mt-0.5 text-xs text-navy-700/70">
              {detail
                ? `Submitted ${dateFormat.format(new Date(detail.createdAt))}`
                : 'Loading the application…'}
            </p>
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

        {!detail && !error && (
          <p className="flex items-center gap-2 px-5 py-10 text-sm text-navy-700/70">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </p>
        )}

        {detail && (
          <>
            <div className="max-h-[55vh] space-y-5 overflow-y-auto px-5 py-4">
              {UPGRADE_SECTIONS.map((section) => (
                <section key={section.title}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-700/60">
                    {section.title}
                  </h3>
                  <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {section.fields.map((spec) => {
                      const raw = detail.values[spec.name];
                      // The stored slug is not what a reviewer should read.
                      const value =
                        spec.type === 'radio' && isBusinessType(raw)
                          ? BUSINESS_TYPE_LABELS[raw]
                          : raw;

                      return (
                        <div
                          key={spec.name}
                          className={spec.wide ? 'sm:col-span-2' : undefined}
                        >
                          <dt className="text-xs text-navy-700/70">
                            {spec.label}
                          </dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm font-medium text-navy-950">
                            {value || '—'}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              ))}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-700/60">
                  Documents
                </h3>
                {detail.docs.length ? (
                  <>
                    <ul className="mt-2 space-y-1">
                      {detail.docs.map((doc) => (
                        <li key={doc.url}>
                          <a
                            href={doc.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-md bg-navy-50 px-3 py-2 text-sm font-medium text-navy-900 transition hover:bg-navy-100"
                          >
                            <Paperclip className="h-4 w-4" />
                            {doc.label}
                            <ExternalLink className="h-3 w-3 text-navy-700/60" />
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-navy-700/60">
                      These links expire a few minutes after this dialog was
                      opened. Reopen it to get fresh ones.
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-navy-700/70">
                    None attached — documents are optional.
                  </p>
                )}
              </section>

              <label className="block">
                <span className="text-xs font-medium text-navy-700">
                  Note {' '}
                  <span className="font-normal text-navy-700/60">
                    (optional — the applicant sees this on a rejection)
                  </span>
                </span>
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What they should correct before applying again"
                  className="mt-1.5 w-full rounded-md border border-navy-100 px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-navy-100 px-5 py-4">
              <button
                type="button"
                disabled={pending}
                onClick={() => decide('reject')}
                className="inline-flex items-center gap-2 rounded-md border border-navy-100 px-4 py-2 text-sm font-medium text-navy-900 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
              >
                <X className="h-4 w-4" />
                Reject
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => decide('accept')}
                className="inline-flex items-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-black transition hover:bg-brand-orange/90 disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Accept
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
