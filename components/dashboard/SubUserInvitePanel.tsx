'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Loader2, Mail, X } from 'lucide-react';

import {
  inviteSubUser,
  revokeSubUserInvite,
  type SubUserActionResult,
} from '@/app/(dashboard)/dashboard/agency-users/actions';

export type PendingSubUserInvite = {
  id: string;
  email: string;
  createdAt: number;
};

/**
 * Invites staff into the signed-in partner's own agency.
 *
 * Deliberately barer than the admin's InvitePanel: **there is no role picker
 * and no agency picker.** A sub user is the only role a partner can create, and
 * their own agency is the only place it can go — so both are decided by the
 * server from the session, and neither appears in the form or the payload.
 */
export default function SubUserInvitePanel({
  agencyCode,
  pending,
}: {
  agencyCode: string;
  pending: PendingSubUserInvite[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<SubUserActionResult | null>(null);

  function run(
    action: () => Promise<SubUserActionResult>,
    onDone?: () => void
  ) {
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
        <h2 className="text-sm font-semibold text-navy-950">Invite a sub user</h2>
        <p className="mt-1 text-xs text-navy-700/70">
          They receive an email and set their own password. They join{' '}
          <span className="font-mono font-semibold text-navy-900">
            {agencyCode}
          </span>{' '}
          and get the same dashboard as you, without this page.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => inviteSubUser(email),
            () => setEmail('')
          );
        }}
      >
        <label className="min-w-[220px] flex-1">
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

        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-60"
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
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => revokeSubUserInvite(invite.id))}
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
