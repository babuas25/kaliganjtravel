'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { FlaskConical } from 'lucide-react';

import { ROLE_LABELS, ROLES, type Role } from '@/lib/roles';
import { setDevRole } from '@/app/(dashboard)/actions';

/**
 * Dev-only role preview. The parent only renders this outside production, and
 * the server action no-ops there too, so it ships as dead code.
 */
export default function DevRoleSwitcher({ role }: { role: Role }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label
      className="hidden items-center gap-2 rounded-full border border-dashed border-navy-200 bg-navy-50 py-1 pl-3 pr-1 text-xs text-navy-700 sm:flex"
      title="Development only — preview the dashboard as another role"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-brand-orange" />
      <span className="whitespace-nowrap font-medium">View as</span>
      <select
        aria-label="Preview dashboard as role"
        value={role}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(async () => {
            await setDevRole(next);
            router.refresh();
          });
        }}
        className="rounded-full border-0 bg-white px-2 py-1 text-xs font-medium text-navy-900 outline-none ring-1 ring-navy-100 focus:ring-brand-orange disabled:opacity-60"
      >
        {ROLES.map((value) => (
          <option key={value} value={value}>
            {ROLE_LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
