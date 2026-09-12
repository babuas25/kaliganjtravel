'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Clock, Loader2, Trash2 } from 'lucide-react';

import {
  deleteUserAccount,
  setUserActive,
  setUserRole,
  type UserActionResult,
} from '@/app/(dashboard)/dashboard/users/actions';
import AgencySelect from '@/components/dashboard/AgencySelect';
import UpgradeReviewDialog from '@/components/dashboard/UpgradeReviewDialog';
import UserDetailsDialog from '@/components/dashboard/UserDetailsDialog';
import { type AgencyOption } from '@/lib/agency';
import { ROLE_LABELS, roleRequiresAgency, type Role } from '@/lib/roles';

export type UserRow = {
  clerkId: string;
  /**
   * How the account reads in the list: the agency's name for a B2B partner,
   * the person's own for everyone else. Resolved on the server — see the
   * roster page — so the dialog heading and this column always agree.
   */
  name: string;
  email: string;
  imageUrl: string;
  role: Role;
  /** False once the account has been deactivated and cannot access the dashboard. */
  active: boolean;
  isSelf: boolean;
  createdAt: number;
  lastSignInAt: number | null;
  /** The agency this person belongs to, ready to display; '' for none. */
  agencyLabel: string;
  /** Set when this actor may not change the row's role; doubles as the tooltip. */
  blockedReason: string | null;
  /**
   * Set when this actor may not delete the row. Stricter than `blockedReason`
   * — an Admin may change roles and correct details but never delete — so the
   * two cannot be collapsed into one flag.
   */
  deleteBlockedReason: string | null;
  /**
   * Whether this actor may open and edit the stored profile behind the row.
   * Separate again from `blockedReason`, which refuses your own row — see
   * `canManageUserProfile()`.
   */
  canViewDetails: boolean;
  /**
   * Epoch ms this customer applied to become a B2B partner, or null when there
   * is nothing waiting. The application itself is fetched only when the dialog
   * opens — see `UpgradeReviewDialog`.
   */
  upgradeRequestedAt: number | null;
};

/** Fixed locale and zone: the server and the client must render the same string. */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  // Two digits, not four: this sits in a 132px column beside its own label,
  // and nobody reads a roster to learn the century.
  year: '2-digit',
  timeZone: 'UTC',
});

function formatDate(value: number | null) {
  return value ? dateFormat.format(new Date(value)) : 'Never';
}

/**
 * A role change that cannot be applied on the spot because it needs an agency
 * chosen first. Held per row, so picking Sub User on one row and abandoning it
 * cannot bleed into another.
 */
type PendingGrant = { clerkId: string; role: Role; agencyCode: string };

/**
 * The account's on/off switch.
 *
 * A real `role="switch"`, so it announces its state to a screen reader rather
 * than reading as a button whose label happens to be a verb. Rendered disabled
 * rather than hidden when the actor may not flip it: the state is worth seeing
 * on a row you cannot change, and `title` says why.
 */
function StatusSwitch({
  active,
  disabled,
  reason,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  /** Why it cannot be flipped, or null — becomes the tooltip either way. */
  reason: string | null;
  onToggle: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={active ? 'Deactivate this account' : 'Activate this account'}
        title={
          reason ?? (active ? 'Deactivate this account' : 'Activate this account')
        }
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
          active ? 'bg-emerald-500' : 'bg-navy-200'
        } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90'}`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            active ? 'translate-x-[18px]' : 'translate-x-[2px]'
          }`}
        />
      </button>
      <span
        className={`text-xs font-semibold ${
          active ? 'text-emerald-700' : 'text-navy-700/60'
        }`}
      >
        {active ? 'Active' : 'Off'}
      </span>
    </span>
  );
}

export default function UsersTable({
  rows,
  assignable,
  agencies,
}: {
  rows: UserRow[];
  assignable: readonly Role[];
  agencies: AgencyOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [grant, setGrant] = useState<PendingGrant | null>(null);
  const [notice, setNotice] = useState<UserActionResult | null>(null);
  /** The row whose upgrade application is open in the review dialog. */
  const [reviewing, setReviewing] = useState<UserRow | null>(null);
  /** The row whose stored profile is open in the details dialog. */
  const [viewing, setViewing] = useState<UserRow | null>(null);

  function run(clerkId: string, action: () => Promise<UserActionResult>) {
    setBusyId(clerkId);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      setBusyId(null);
      setConfirmId(null);
      if (result.ok) {
        setGrant(null);
        router.refresh();
      }
    });
  }

  /**
   * Roles that carry nothing else apply straight away, as they always have.
   * Sub User opens the agency picker instead: the grant is incomplete until an
   * agency is named, and sending it early would only earn a refusal.
   */
  function chooseRole(row: UserRow, next: Role) {
    if (roleRequiresAgency(next)) {
      setGrant({ clerkId: row.clerkId, role: next, agencyCode: '' });
      return;
    }
    setGrant(null);
    run(row.clerkId, () => setUserRole(row.clerkId, next));
  }

  if (!rows.length) {
    return (
      <p className="px-4 py-10 text-center text-sm text-navy-700/70">
        No accounts match that search.
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
        {/*
          `table-fixed` is what guarantees no horizontal scrollbar on a
          desktop. Left to itself a table is as wide as its widest content —
          an email address, a long agency label — and no amount of tuning
          min-width settles that. Fixed layout hands each column the width
          named below and makes the content fit it instead, with the user
          column taking whatever is left. The 680px floor is only for phones,
          where the rail has already dropped underneath and scrolling a table
          is the expected thing.
        */}
        <table className="w-full min-w-[680px] table-fixed text-left text-sm">
          <colgroup>
            <col />
            <col className="w-[140px]" />
            <col className="w-[112px]" />
            <col className="w-[132px]" />
            <col className="w-[164px]" />
          </colgroup>
          <thead className="border-b border-navy-100 text-xs uppercase tracking-wide text-navy-700/60">
            <tr>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              {/* Joined and last sign-in share a column, stacked. Two date
                  columns cost ~100px the roster no longer has to spare now
                  that the add-user rail sits beside it. */}
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">
                Activity
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-navy-100">
            {rows.map((row) => {
              const locked = row.blockedReason !== null;
              const busy = pending && busyId === row.clerkId;
              const choosing = grant?.clerkId === row.clerkId;

              // An admin looking at a Super Admin still has to see that role,
              // even though it is not one they can hand out.
              const options = assignable.includes(row.role)
                ? assignable
                : [row.role, ...assignable];

              return (
                <tr key={row.clerkId} className="align-middle">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={row.imageUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-full object-cover"
                      />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-navy-950">
                          {row.name}
                          {row.isSelf && (
                            <span className="ml-2 rounded-full bg-navy-50 px-2 py-0.5 text-xs font-normal text-navy-700">
                              you
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-navy-700/70">
                          {row.email}
                        </p>
                        {/* Yellow, matching the button the customer pressed to
                            get here. Only ever on a customer row: the page
                            drops the flag once the role has moved on, so an
                            application overtaken by a manual role change stops
                            advertising itself. */}
                        {row.upgradeRequestedAt !== null && (
                          <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-900">
                            <Clock className="h-3 w-3" />
                            Waiting for upgrade
                          </p>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 align-top">
                    <select
                      value={choosing ? grant.role : row.role}
                      disabled={locked || busy}
                      title={row.blockedReason ?? undefined}
                      onChange={(e) =>
                        chooseRole(row, e.target.value as Role)
                      }
                      className="w-full rounded-md border border-navy-100 bg-white px-2 py-1.5 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange disabled:cursor-not-allowed disabled:bg-navy-50 disabled:text-navy-700/60"
                    >
                      {options.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>

                    {choosing ? (
                      <div className="mt-2 space-y-2">
                        <AgencySelect
                          agencies={agencies}
                          value={grant.agencyCode}
                          onChange={(agencyCode) =>
                            setGrant({ ...grant, agencyCode })
                          }
                          disabled={busy}
                          className="block w-full"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={!grant.agencyCode || busy}
                            onClick={() =>
                              run(row.clerkId, () =>
                                setUserRole(
                                  row.clerkId,
                                  grant.role,
                                  grant.agencyCode
                                )
                              )
                            }
                            className="rounded-md bg-brand-orange px-2.5 py-1.5 text-xs font-semibold text-black transition hover:bg-brand-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            onClick={() => setGrant(null)}
                            className="rounded-md border border-navy-100 px-2.5 py-1.5 text-xs font-medium text-navy-900"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      row.agencyLabel && (
                        <p className="mt-1.5 flex items-center gap-2 text-xs text-navy-700/70">
                          <span className="truncate">{row.agencyLabel}</span>
                          {/* Re-picking the same option fires no change event,
                              so moving a sub user between agencies needs a way
                              in that is not the role dropdown. */}
                          {roleRequiresAgency(row.role) && !locked && (
                            <button
                              type="button"
                              onClick={() =>
                                setGrant({
                                  clerkId: row.clerkId,
                                  role: row.role,
                                  agencyCode: '',
                                })
                              }
                              className="shrink-0 font-medium text-brand-orange transition hover:underline"
                            >
                              Change
                            </button>
                          )}
                        </p>
                      )
                    )}
                  </td>

                  <td className="px-3 py-2.5 align-top">
                    <StatusSwitch
                      active={row.active}
                      disabled={locked || busy}
                      reason={row.blockedReason}
                      onToggle={() =>
                        run(row.clerkId, () =>
                          setUserActive(row.clerkId, !row.active)
                        )
                      }
                    />
                  </td>

                  <td className="whitespace-nowrap px-3 py-2.5 align-top text-xs text-navy-700/80">
                    <p>
                      <span className="text-navy-700/50">Joined</span>{' '}
                      {formatDate(row.createdAt)}
                    </p>
                    <p className="mt-1">
                      <span className="text-navy-700/50">Seen</span>{' '}
                      {formatDate(row.lastSignInAt)}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 text-right">
                    {busy ? (
                      <Loader2 className="ml-auto h-4 w-4 animate-spin text-navy-700/60" />
                    ) : confirmId === row.clerkId ? (
                      // Stacked: two side-by-side buttons do not fit a fixed
                      // 164px column, and a confirmation that overflows its
                      // cell is not one anybody should be reading in a hurry.
                      <span className="flex flex-col items-stretch gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            run(row.clerkId, () =>
                              deleteUserAccount(row.clerkId)
                            )
                          }
                          className="rounded-md bg-red-600 px-2 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
                        >
                          Delete for good
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-md border border-navy-100 px-2 py-1.5 text-xs font-medium text-navy-900"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      // Wraps rather than overflows: a customer with an upgrade
                      // waiting carries three controls here, which is one more
                      // than a fixed 164px column holds on one line.
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        {row.canViewDetails && (
                          <button
                            type="button"
                            title="See the profile details on file"
                            onClick={() => setViewing(row)}
                            className="whitespace-nowrap rounded-md border border-navy-100 px-2 py-1.5 text-xs font-medium text-navy-900 transition hover:border-brand-orange hover:text-brand-orange"
                          >
                            View Details
                          </button>
                        )}
                        {row.upgradeRequestedAt !== null && (
                          <button
                            type="button"
                            disabled={locked}
                            title={
                              row.blockedReason ??
                              'Review this upgrade application'
                            }
                            onClick={() => setReviewing(row)}
                            className="rounded-md bg-yellow-400 px-2.5 py-1.5 text-xs font-semibold text-black transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            View
                          </button>
                        )}
                        {/* An Admin never gets this: deleting is the Super
                            Admin's alone, so the control is absent rather
                            than disabled — a greyed bin on every row would
                            read as a fault. */}
                        {row.deleteBlockedReason === null && (
                          <button
                            type="button"
                            title="Delete this account"
                            onClick={() => setConfirmId(row.clerkId)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-navy-700/70 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {viewing && (
        <UserDetailsDialog
          clerkId={viewing.clerkId}
          name={viewing.name}
          onClose={() => setViewing(null)}
          // Left open on purpose: an admin correcting several fields should
          // see the confirmation and carry on, not have the panel vanish.
          onSaved={() => router.refresh()}
        />
      )}

      {reviewing && (
        <UpgradeReviewDialog
          clerkId={reviewing.clerkId}
          name={reviewing.name}
          onClose={() => setReviewing(null)}
          onDecided={(result) => {
            setNotice(result);
            if (result.ok) {
              setReviewing(null);
              router.refresh();
            }
          }}
        />
      )}
    </div>
  );
}
