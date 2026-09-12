'use client';

import { agencyOptionLabel, type AgencyOption } from '@/lib/agency';

/**
 * Picks the agency a Sub User belongs to.
 *
 * Shown only where the choice is genuinely open — an admin in Users & Roles.
 * A B2B partner inviting their own staff never sees this: their agency is the
 * only possible answer, and it is not theirs to change.
 *
 * The empty option is deliberate and is the initial value. There is no sensible
 * default agency, and pre-selecting the newest one invites an admin to send an
 * invitation to the wrong company by not looking. `required` makes the browser
 * stop the submit; the server checks again regardless.
 */
export default function AgencySelect({
  agencies,
  value,
  onChange,
  disabled = false,
  className = '',
}: {
  agencies: AgencyOption[];
  value: string;
  onChange: (agencyCode: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!agencies.length) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        No agencies exist yet. A Sub User belongs to a B2B Partner, so create
        one first — their agency code is issued when they first sign in.
      </p>
    );
  }

  return (
    <select
      required
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange disabled:cursor-not-allowed disabled:bg-navy-50 ${className}`}
    >
      <option value="">Select an agency…</option>
      {agencies.map((agency) => (
        <option key={agency.agencyCode} value={agency.agencyCode}>
          {agencyOptionLabel(agency)}
        </option>
      ))}
    </select>
  );
}
