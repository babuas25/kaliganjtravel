'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Loader2, Mail, X } from 'lucide-react';

import {
  inviteUser,
  revokeInvite,
  type UserActionResult,
} from '@/app/(dashboard)/dashboard/users/actions';
import AgencySelect from '@/components/dashboard/AgencySelect';
import { agencyOptionLabel, type AgencyOption } from '@/lib/agency';
import {
  DEFAULT_ROLE,
  ROLE_LABELS,
  roleRequiresAgency,
  type Role,
} from '@/lib/roles';

export type PendingInvite = {
  id: string;
  email: string;
  role: Role;
  /** The agency a pending Sub User will join; null for every other role. */
  agencyCode: string | null;
  createdAt: number;
};

/**
 * Adding a user means inviting one: Clerk emails a sign-up link and the person
 * sets their own password, so no admin ever handles someone else's
 * credentials. The role rides along in the invitation metadata and is already
 * attached the moment they accept.
 */
export default function InvitePanel({
  assignable,
  pending,
  agencies,
}: {
  assignable: readonly Role[];
  pending: PendingInvite[];
  agencies: AgencyOption[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [agencyCode, setAgencyCode] = useState('');
  const [notice, setNotice] = useState<UserActionResult | null>(null);

  const needsAgency = roleRequiresAgency(role);
  // Nothing to attach a sub user to. The button goes down rather than letting
  // the invitation fail on the server for a reason the form could see itself.
  const blocked = needsAgency && !agencies.length;

  const labelFor = (code: string) => {
    const match = agencies.find((agency) => agency.agencyCode === code);
    return match ? agencyOptionLabel(match) : code;
  };

  function run(action: () => Promise<UserActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      if (result.ok) {
        onDone?.();
        router.refresh();
      }
    });
  }

  return (
    <div className="rounded-lg border border-navy-100 bg-white">
      <div className="border-b border-navy-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-navy-950">Invite a user</h2>
        <p className="mt-1 text-xs text-navy-700/70">
          They receive an email, set their own password, and arrive with the
          role you pick here. A Sub User also arrives attached to the agency you
          choose.
        </p>
      </div>

      {/* One field per row: this lives in a 264px rail, so a wrapping flex
          line would only ever wrap. */}
      <form
        className="grid gap-3 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => inviteUser(email, role, needsAgency ? agencyCode : null),
            () => {
              setEmail('');
              setAgencyCode('');
            }
          );
        }}
      >
        <label className="block">
          <span className="text-xs font-medium text-navy-700">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="mt-1 w-full rounded-md border border-navy-100 px-3 py-2 text-sm text-navy-950 placeholder:text-navy-700/40 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-navy-700">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="mt-1 block w-full rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange"
          >
            {assignable.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>

        {needsAgency && (
          <label className="block">
            <span className="text-xs font-medium text-navy-700">
              Agency <span className="text-brand-orange">*</span>
            </span>
            <AgencySelect
              agencies={agencies}
              value={agencyCode}
              onChange={setAgencyCode}
              disabled={busy}
              className="mt-1 block w-full"
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy || blocked}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Mail className="h-4 w-4" />
          )}
          Send invite
        </button>
      </form>

      {notice && (
        <div
          className={`flex items-start gap-2 border-t px-4 py-3 text-sm ${
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

      {pending.length > 0 && (
        <div className="border-t border-navy-100 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-navy-700/60">
            Awaiting acceptance
          </p>
          <ul className="mt-2 space-y-1">
            {pending.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate text-navy-900">
                  {invite.email}
                  <span className="ml-2 text-xs text-navy-700/70">
                    {ROLE_LABELS[invite.role]}
                    {invite.agencyCode && ` · ${labelFor(invite.agencyCode)}`}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => revokeInvite(invite.id))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy-700/70 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                >
                  <X className="h-3 w-3" />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
