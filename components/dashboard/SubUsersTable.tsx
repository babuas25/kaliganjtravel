'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Power,
  Trash2,
} from 'lucide-react';

import {
  removeSubUser,
  renameSubUser,
  setSubUserAccess,
  type SubUserActionResult,
} from '@/app/(dashboard)/dashboard/agency-users/actions';

export type SubUserRow = {
  clerkId: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  imageUrl: string;
  /** False when the account is disabled from the application. */
  disabled: boolean;
  createdAt: number;
  lastSignInAt: number | null;
};

/** Fixed locale and zone: the server and the client must render the same string. */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDate(value: number | null) {
  return value ? dateFormat.format(new Date(value)) : 'Never';
}

type Draft = { clerkId: string; firstName: string; lastName: string };

export default function SubUsersTable({ rows }: { rows: SubUserRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<SubUserActionResult | null>(null);

  function run(clerkId: string, action: () => Promise<SubUserActionResult>) {
    setBusyId(clerkId);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      setBusyId(null);
      setConfirmId(null);
      if (result.ok) {
        setDraft(null);
        router.refresh();
      }
    });
  }

  if (!rows.length) {
    return (
      <p className="px-4 py-10 text-center text-sm text-navy-700/70">
        No sub users yet. Invite one above and they will appear here once they
        accept.
      </p>
    );
  }

  return (
    <div>
      {notice && (
        <div
          className={`flex items-start gap-2 border-b px-4 py-3 text-sm ${
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-navy-100 text-xs uppercase tracking-wide text-navy-700/60">
            <tr>
              <th className="px-4 py-3 font-medium">Sub user</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Joined</th>
              <th className="px-4 py-3 font-medium">Last sign-in</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-navy-100">
            {rows.map((row) => {
              const busy = pending && busyId === row.clerkId;
              const editing = draft?.clerkId === row.clerkId;

              return (
                <tr key={row.clerkId} className="align-middle">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={row.imageUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-full object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        {editing ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={draft.firstName}
                              onChange={(e) =>
                                setDraft({ ...draft, firstName: e.target.value })
                              }
                              placeholder="First name"
                              className="w-28 rounded-md border border-navy-100 px-2 py-1 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange"
                            />
                            <input
                              value={draft.lastName}
                              onChange={(e) =>
                                setDraft({ ...draft, lastName: e.target.value })
                              }
                              placeholder="Last name"
                              className="w-28 rounded-md border border-navy-100 px-2 py-1 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                run(row.clerkId, () =>
                                  renameSubUser(
                                    row.clerkId,
                                    draft.firstName,
                                    draft.lastName
                                  )
                                )
                              }
                              className="rounded-md bg-brand-orange px-2.5 py-1 text-xs font-semibold text-black transition hover:bg-brand-orange/90 disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setDraft(null)}
                              className="rounded-md border border-navy-100 px-2.5 py-1 text-xs font-medium text-navy-900"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <p className="truncate font-medium text-navy-950">
                              {row.name}
                            </p>
                            <p className="truncate text-xs text-navy-700/70">
                              {row.email}
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        row.disabled
                          ? 'bg-red-50 text-red-700'
                          : 'bg-navy-50 text-navy-700'
                      }`}
                    >
                      {row.disabled ? 'Disabled' : 'Active'}
                    </span>
                  </td>

                  <td className="px-4 py-3 text-navy-700/80">
                    {formatDate(row.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-navy-700/80">
                    {formatDate(row.lastSignInAt)}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {busy ? (
                      <Loader2 className="ml-auto h-4 w-4 animate-spin text-navy-700/60" />
                    ) : confirmId === row.clerkId ? (
                      <span className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            run(row.clerkId, () => removeSubUser(row.clerkId))
                          }
                          className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
                        >
                          Remove for good
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
                          title="Rename"
                          onClick={() =>
                            setDraft({
                              clerkId: row.clerkId,
                              firstName: row.firstName,
                              lastName: row.lastName,
                            })
                          }
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-navy-700/70 transition hover:bg-navy-50 hover:text-navy-900"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title={
                            row.disabled
                              ? 'Enable this account'
                              : 'Disable this account'
                          }
                          onClick={() =>
                            run(row.clerkId, () =>
                              setSubUserAccess(row.clerkId, !row.disabled)
                            )
                          }
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition ${
                            row.disabled
                              ? 'text-navy-700/70 hover:bg-navy-50 hover:text-navy-900'
                              : 'text-navy-700/70 hover:bg-amber-50 hover:text-amber-700'
                          }`}
                        >
                          <Power className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title="Remove this account"
                          onClick={() => setConfirmId(row.clerkId)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-navy-700/70 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
