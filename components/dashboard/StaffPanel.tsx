'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  IdCard,
  Loader2,
  Pencil,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import {
  deleteStaffDetailsAction,
  saveStaffDetailsAction,
  type StaffActionResult,
} from '@/app/(dashboard)/dashboard/profile/staff-actions';
import { cn } from '@/lib/utils';
import {
  EMPTY_STAFF,
  hasStaffValues,
  STAFF_FIELD_SPECS,
  type StaffField,
  type StaffValues,
} from '@/lib/staff';

/** One person the panel can show, with whatever staff record they have. */
export type StaffEntry = {
  userId: string;
  name: string;
  email: string;
  values: StaffValues;
  /** False when this person has no record yet — "create" rather than "edit". */
  hasRecord: boolean;
};

const CONTROL_CLASS =
  'mt-1.5 w-full rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20';

/**
 * The Staff tab on the Company profile.
 *
 * Serves both roles from one component because the difference is only how many
 * people are in the list: a B2B admin gets their agency's sub users, a sub user
 * gets the single entry that is their own. What each may do is decided on the
 * server by `requireStaffAccess()` — the entries handed to a sub user are
 * already just their own, so there is nothing here to tighten.
 *
 * Read-only when `readFailed`: the form submits every field at once, so
 * offering a blank one after a failed read would, on the next save, write NULL
 * over details that are stored.
 */
export default function StaffPanel({
  entries,
  isAdmin,
  readFailed = false,
}: {
  entries: StaffEntry[];
  isAdmin: boolean;
  readFailed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StaffValues>(EMPTY_STAFF);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<StaffActionResult | null>(null);

  function run(userId: string, action: () => Promise<StaffActionResult>) {
    setBusyId(userId);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      setBusyId(null);
      setConfirmId(null);
      if (result.ok) {
        setEditingId(null);
        router.refresh();
      }
    });
  }

  function startEditing(entry: StaffEntry) {
    setEditingId(entry.userId);
    setDraft({ ...entry.values });
    setNotice(null);
  }

  if (readFailed) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-amber-900">
              Staff details could not be loaded
            </h3>
            <p className="mt-1 text-sm text-amber-800">
              They are hidden rather than shown blank — saving an empty form
              would overwrite what is stored. Nothing has been changed. Reload
              to try again.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-navy-100 bg-white">
      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
          <IdCard className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-navy-950">
            {isAdmin ? 'Staff List' : 'My Staff Details'}
          </h3>
          <p className="mt-0.5 text-xs text-navy-700/70">
            {isAdmin
              ? 'Employment details for your sub users. Kept apart from the agency’s own company details, and from each person’s travel profile.'
              : 'Your employment details at this agency. Your agency admin can see and update these too.'}
          </p>
        </div>
      </header>

      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 border-b px-5 py-3 text-sm',
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
          <span>{notice.message}</span>
        </div>
      )}

      {!entries.length ? (
        <p className="px-5 py-10 text-center text-sm text-navy-700/70">
          {isAdmin
            ? 'No sub users yet. Invite one from the Sub User section and their staff details can be filled in here.'
            : 'Your staff details are not set up yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-navy-100">
          {entries.map((entry) => {
            const editing = editingId === entry.userId;
            const busy = pending && busyId === entry.userId;
            const filled = hasStaffValues(entry.values);

            return (
              <li key={entry.userId} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-navy-950">
                      {entry.name}
                      {entry.values.designation && (
                        <span className="ml-2 rounded-full bg-navy-50 px-2 py-0.5 text-xs font-normal text-navy-700">
                          {entry.values.designation}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-navy-700/70">
                      {entry.email}
                    </p>
                  </div>

                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-navy-700/60" />
                  ) : editing ? (
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="inline-flex items-center gap-1 rounded-md border border-navy-100 px-2.5 py-1.5 text-xs font-medium text-navy-900"
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </button>
                  ) : confirmId === entry.userId ? (
                    <span className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          run(entry.userId, () =>
                            deleteStaffDetailsAction(entry.userId)
                          )
                        }
                        className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
                      >
                        Delete details
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded-md border border-navy-100 px-2.5 py-1.5 text-xs font-medium text-navy-900"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEditing(entry)}
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-navy-700 transition hover:bg-navy-50 hover:text-navy-950"
                      >
                        <Pencil className="h-3 w-3" />
                        {entry.hasRecord ? 'Edit' : 'Add details'}
                      </button>
                      {entry.hasRecord && (
                        <button
                          type="button"
                          title="Remove these staff details"
                          onClick={() => setConfirmId(entry.userId)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-navy-700/70 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  )}
                </div>

                {editing ? (
                  <div className="mt-4 grid gap-x-4 gap-y-4 sm:grid-cols-2">
                    {STAFF_FIELD_SPECS.map((field) => (
                      <div
                        key={field.name}
                        className={cn(field.wide && 'sm:col-span-2')}
                      >
                        <label
                          htmlFor={`${entry.userId}-${field.name}`}
                          className="text-sm font-medium text-navy-950"
                        >
                          {field.label}
                        </label>
                        {field.type === 'textarea' ? (
                          <textarea
                            id={`${entry.userId}-${field.name}`}
                            rows={3}
                            value={draft[field.name]}
                            placeholder={field.placeholder}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                [field.name as StaffField]: event.target.value,
                              }))
                            }
                            className={cn(CONTROL_CLASS, 'resize-y')}
                          />
                        ) : (
                          <input
                            id={`${entry.userId}-${field.name}`}
                            type={field.type}
                            value={draft[field.name]}
                            placeholder={field.placeholder}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                [field.name as StaffField]: event.target.value,
                              }))
                            }
                            className={CONTROL_CLASS}
                          />
                        )}
                      </div>
                    ))}

                    <div className="sm:col-span-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(entry.userId, () =>
                            saveStaffDetailsAction(entry.userId, draft)
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-full bg-brand-orange px-5 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Save className="h-4 w-4" />
                        {busy ? 'Saving…' : 'Save staff details'}
                      </button>
                    </div>
                  </div>
                ) : (
                  filled && (
                    <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                      {STAFF_FIELD_SPECS.filter(
                        (field) =>
                          field.name !== 'designation' && entry.values[field.name]
                      ).map((field) => (
                        <div key={field.name} className="flex gap-2">
                          <dt className="shrink-0 text-navy-700/60">
                            {field.label}
                          </dt>
                          <dd className="min-w-0 break-words font-medium text-navy-900">
                            {entry.values[field.name]}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
