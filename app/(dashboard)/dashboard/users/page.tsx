import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { clerkClient } from '@clerk/nextjs/server';

import CreateUserPanel from '@/components/dashboard/CreateUserPanel';
import InvitePanel, {
  type PendingInvite,
} from '@/components/dashboard/InvitePanel';
import UsersFilterBar from '@/components/dashboard/UsersFilterBar';
import UsersTable, { type UserRow } from '@/components/dashboard/UsersTable';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  loadRoster,
  resolveDate,
  resolveRoleFilter,
  resolveSort,
  resolveStatusFilter,
  type RosterFilters,
} from '@/lib/dashboard/user-roster';
import { listAgencies, membershipsFor } from '@/lib/db/agencies';
import { pendingUpgradesFor } from '@/lib/db/upgrade-requests';
import { agencyOptionLabel, isAgencyCode } from '@/lib/agency';
import {
  assignableRoles,
  canManageUsers,
  canManageUserProfile,
  resolveRole,
  userActionBlockedReason,
  userDeleteBlockedReason,
} from '@/lib/roles';

export const metadata: Metadata = {
  title: 'Users & Roles — Kaliganj Travels',
};

const PAGE_SIZE = 20;

/** One count in the header strip. */
function SummaryTile({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-baseline gap-2 rounded-lg border px-3 py-1.5 ${
        strong
          ? 'border-white/20 bg-white/10'
          : 'border-white/10 bg-white/[0.04]'
      }`}
    >
      <span className="text-xs text-black/75">{label}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </span>
  );
}

/**
 * The whole-application roster. Admin and Super Admin only — the same check
 * the nav makes, repeated here so a direct URL 404s for everyone else.
 *
 * Clerk is the source of the list, not the `app_users` mirror: someone who has
 * signed up but never opened the dashboard has no mirror row yet, and leaving
 * them off the roster would make them unmanageable.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (!canManageUsers(session.role)) notFound();

  const params = await searchParams;
  const single = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const filters: RosterFilters = {
    query: (single('q') ?? '').trim(),
    role: resolveRoleFilter(single('role')),
    status: resolveStatusFilter(single('status')),
    from: resolveDate(single('from')),
    to: resolveDate(single('to')),
    sort: resolveSort(single('sort')),
    page: Math.max(1, Number(single('page')) || 1),
  };

  const client = await clerkClient();
  const [roster, invitations, agencies] = await Promise.all([
    loadRoster(client, filters, PAGE_SIZE),
    client.invitations.getInvitationList({ status: 'pending', limit: 25 }),
    listAgencies(),
  ]);

  const listedIds = roster.entries.map((entry) => entry.clerkId);

  // Both read from the database rather than from Clerk metadata — the metadata
  // is only a mirror — and both are one query for the page, not one per row:
  // the agency each listed person belongs to, and who has an upgrade
  // application waiting.
  const [memberships, pendingUpgrades] = await Promise.all([
    membershipsFor(listedIds),
    pendingUpgradesFor(listedIds),
  ]);

  const agencyLabels = new Map(
    agencies.map((agency) => [agency.agencyCode, agencyOptionLabel(agency)])
  );
  /** An agency no longer in the table still shows its code rather than blank. */
  const labelFor = (code: string | undefined) =>
    code ? (agencyLabels.get(code) ?? code) : '';

  const actor = { role: session.role, clerkId: session.clerkId };

  const rows: UserRow[] = roster.entries.map((entry) => {
    const { clerkId, role } = entry;

    return {
      clerkId,
      // The display name — a partner's agency, everyone else's own — is
      // resolved in `loadRoster()`, so what is searched and sorted is what
      // appears here.
      name: entry.name,
      email: entry.email,
      imageUrl: entry.imageUrl,
      role,
      active: entry.active,
      isSelf: clerkId === session.clerkId,
      createdAt: entry.createdAt,
      lastSignInAt: entry.lastSignInAt,
      // A partner's agency name is this row's name already, so only the code
      // is repeated here — the old "NAME — CODE" was the widest text in the
      // table and said nothing the row had not said. A sub user's row is named
      // after the person, so theirs still needs the agency spelled out.
      agencyLabel:
        role === 'b2b'
          ? (memberships.get(clerkId) ?? '')
          : labelFor(memberships.get(clerkId)),
      // Only ever flagged on a customer. A pending row belonging to someone who
      // has since been given another role by hand is stale — the action would
      // refuse it anyway, so advertising it would only invite a click that
      // fails.
      upgradeRequestedAt:
        role === 'customer' ? (pendingUpgrades.get(clerkId) ?? null) : null,
      blockedReason: userActionBlockedReason(actor, { role, clerkId }),
      deleteBlockedReason: userDeleteBlockedReason(actor, { role, clerkId }),
      canViewDetails: canManageUserProfile(session.role, role),
    };
  });

  const pending: PendingInvite[] = invitations.data.map((invite) => {
    const metadata = invite.publicMetadata as {
      role?: unknown;
      agencyCode?: unknown;
    } | null;
    // An invitation is the one place the code legitimately lives outside the
    // database, since the invitee has no row yet.
    const invitedAgency = metadata?.agencyCode;

    return {
      id: invite.id,
      email: invite.emailAddress,
      role: resolveRole(metadata?.role),
      agencyCode: isAgencyCode(invitedAgency) ? invitedAgency : null,
      createdAt: invite.createdAt,
    };
  });

  const assignable = assignableRoles(session.role);
  const summary = roster.summary;
  const totalPages = Math.max(1, Math.ceil(roster.matched / PAGE_SIZE));

  /** Paging keeps the filters — otherwise page 2 is page 2 of something else. */
  const pageHref = (n: number) => {
    const next = new URLSearchParams();
    if (filters.query) next.set('q', filters.query);
    if (filters.role !== 'all') next.set('role', filters.role);
    if (filters.status !== 'all') next.set('status', filters.status);
    if (filters.from) next.set('from', filters.from);
    if (filters.to) next.set('to', filters.to);
    if (filters.sort !== 'newest') next.set('sort', filters.sort);
    next.set('page', String(n));
    return `/dashboard/users?${next}`;
  };

  return (
    // Same measure as a booking: a roster read left to right across a 27-inch
    // screen is a roster nobody can follow.
    <div className="mx-auto w-full max-w-[1116px] space-y-4">
      {/* The brand banner the other control pages open with — Account Ledger,
          Company Profile — so this one stops looking like a bare table. */}
      <section className="relative overflow-hidden rounded-2xl bg-brand-orange px-6 py-6 text-black shadow-sm">
        <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full border-[32px] border-black/10" />
        <div className="absolute bottom-0 left-0 h-1 w-full bg-brand-orange" />
        <div className="relative">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-black">
            Access control
          </p>
          <h1 className="mt-1.5 text-2xl font-bold">Users &amp; Roles</h1>
          <p className="mt-2 max-w-2xl text-sm text-black">
            {session.role === 'superadmin'
              ? 'Every account in the application. You can grant any role, including Super Admin, and yours is the only role that can delete an account.'
              : 'Every account in the application. You can change roles and correct details; Super Admin accounts and deleting an account are a Super Admin’s.'}
          </p>

          {/* Counts for the whole application, not the page below: searching
              or paging the roster does not move these. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <SummaryTile label="All accounts" value={summary.total} strong />
            <SummaryTile label="Active" value={summary.active} />
            <SummaryTile label="Deactivated" value={summary.deactivated} />
            <span className="mx-1 hidden w-px self-stretch bg-white/10 sm:block" />
            {summary.groups.map((group) => (
              <SummaryTile
                key={group.label}
                label={group.label}
                value={group.count}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Roster left, the two ways of adding somebody in a rail on the right —
          the same split the booking page uses for its quick actions. Below
          `lg` the rail drops underneath, where a 264px column would be
          unusable. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_264px]">
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg border border-navy-100 bg-white">
            <UsersFilterBar filters={filters} matched={roster.matched} />

            {roster.truncated && (
              <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                The roster is larger than this page reads in one go — filters
                and sorting cover the most recent accounts only.
              </p>
            )}

            <UsersTable
              rows={rows}
              assignable={assignable}
              agencies={agencies}
            />
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-navy-700/70">
                Page {filters.page} of {totalPages}
              </span>
              <div className="flex gap-2">
                {filters.page > 1 && (
                  <Link
                    href={pageHref(filters.page - 1)}
                    className="rounded-md border border-navy-100 bg-white px-3 py-2 font-medium text-navy-900 transition hover:border-brand-orange hover:text-brand-orange"
                  >
                    Previous
                  </Link>
                )}
                {filters.page < totalPages && (
                  <Link
                    href={pageHref(filters.page + 1)}
                    className="rounded-md border border-navy-100 bg-white px-3 py-2 font-medium text-navy-900 transition hover:border-brand-orange hover:text-brand-orange"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <CreateUserPanel assignable={assignable} agencies={agencies} />
          <InvitePanel
            assignable={assignable}
            pending={pending}
            agencies={agencies}
          />
        </aside>
      </div>
    </div>
  );
}
