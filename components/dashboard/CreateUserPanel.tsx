'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  UserPlus,
} from 'lucide-react';

import {
  createUserAccount,
  type UserActionResult,
} from '@/app/(dashboard)/dashboard/users/actions';
import AgencySelect from '@/components/dashboard/AgencySelect';
import { type AgencyOption } from '@/lib/agency';
import {
  DEFAULT_ROLE,
  ROLE_LABELS,
  roleRequiresAgency,
  type Role,
} from '@/lib/roles';

const INPUT_CLASS =
  'mt-1 w-full rounded-md border border-navy-100 px-3 py-2 text-sm text-navy-950 placeholder:text-navy-700/40 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange';

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  agencyCode: '',
};

/**
 * Creating an account outright, as an alternative to inviting one.
 *
 * Collapsed by default: inviting is still the ordinary path — the person picks
 * their own password and nobody else ever holds it — and this page is read far
 * more often than it is used to add anybody. Opening it is the deliberate act.
 */
export default function CreateUserPanel({
  assignable,
  agencies,
}: {
  assignable: readonly Role[];
  agencies: AgencyOption[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [form, setForm] = useState({ ...EMPTY });
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [notice, setNotice] = useState<UserActionResult | null>(null);

  const needsAgency = roleRequiresAgency(role);
  // Nothing to attach a sub user to. Down rather than letting the server
  // refuse it for a reason the form can see for itself.
  const blocked = needsAgency && !agencies.length;

  function set(field: keyof typeof EMPTY, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit() {
    startTransition(async () => {
      const result = await createUserAccount({
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        role,
        agencyCode: needsAgency ? form.agencyCode : null,
      });
      setNotice(result);
      if (result.ok) {
        // The password does not linger in a field once it has been used.
        setForm({ ...EMPTY });
        setRole(DEFAULT_ROLE);
        router.refresh();
      }
    });
  }

  return (
    <div className="rounded-lg border border-navy-100 bg-white">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-navy-950">
            Create a user
          </span>
          <span className="mt-1 block text-xs text-navy-700/70">
            Set the account up yourself, password and all — for someone who
            cannot be invited by email.
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-navy-700/70 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        // One field per row, like the invite above it: the rail is 264px, so
        // a two-column grid would only squeeze both halves.
        <form
          className="grid gap-3 border-t border-navy-100 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label>
            <span className="text-xs font-medium text-navy-700">
              First name <span className="text-brand-orange">*</span>
            </span>
            <input
              required
              value={form.firstName}
              onChange={(e) => set('firstName', e.target.value)}
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-navy-700">
              Last name{' '}
              <span className="font-normal text-navy-700/60">(optional)</span>
            </span>
            <input
              value={form.lastName}
              onChange={(e) => set('lastName', e.target.value)}
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-navy-700">
              Email <span className="text-brand-orange">*</span>
            </span>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="name@example.com"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-navy-700">
              Password <span className="text-brand-orange">*</span>
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-navy-700">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className={`${INPUT_CLASS} bg-white`}
            >
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          {needsAgency && (
            <label>
              <span className="text-xs font-medium text-navy-700">
                Agency <span className="text-brand-orange">*</span>
              </span>
              <AgencySelect
                agencies={agencies}
                value={form.agencyCode}
                onChange={(code) => set('agencyCode', code)}
                disabled={busy}
                className="mt-1 block w-full"
              />
            </label>
          )}

          <p className="text-xs text-navy-700/60">
            The password is not emailed to them. Pass it on yourself, and tell
            them to change it once they are in.
          </p>

          <div>
            <button
              type="submit"
              disabled={busy || blocked}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              Create account
            </button>
          </div>
        </form>
      )}

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
    </div>
  );
}
