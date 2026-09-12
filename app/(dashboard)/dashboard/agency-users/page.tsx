import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { clerkClient } from '@clerk/nextjs/server';
import { AlertTriangle } from 'lucide-react';

import SubUserInvitePanel, {
  type PendingSubUserInvite,
} from '@/components/dashboard/SubUserInvitePanel';
import SubUsersTable, {
  type SubUserRow,
} from '@/components/dashboard/SubUsersTable';
import { isUserActive } from '@/lib/account-access';
import { getDashboardSession } from '@/lib/dashboard/session';
import { agencyMemberIds, MAX_AGENCY_MEMBERS } from '@/lib/db/sub-users';
import { canManageSubUsers, resolveRole, SUB_USER_ROLE } from '@/lib/roles';

export const metadata: Metadata = {
  title: 'Sub Users — Kaliganj Travels',
};

/**
 * Shown when the signed-in partner holds the role but the database cannot
 * confirm they own an agency — an unreachable database, or an account that has
 * not been issued one yet.
 *
 * The page refuses rather than showing an empty list. An empty roster would
 * read as "you have no sub users", and the invite form beside it would send
 * invitations into an agency nobody could verify.
 */
function AgencyUnavailable() {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-amber-900">
            Your agency could not be confirmed
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            Sub users are managed per agency, and yours could not be read just
            now — so this page is hidden rather than shown empty, which would
            look like having none. Nothing has been changed. Reload to try
            again, and contact support if it keeps happening.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * A B2B partner's own staff accounts.
 *
 * Deliberately **not** the Users & Roles pattern of listing from Clerk. Clerk
 * cannot filter a user list by public metadata, so "everyone in this agency"
 * would mean paging every account in the installation. The database answers
 * who belongs here; Clerk is then asked, in one batched call, what state those
 * accounts are in.
 */
export default async function AgencyUsersPage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');

  // The same check the nav makes, repeated so a direct URL 404s for a sub user
  // rather than rendering. Their nav entry omits this segment; this is what
  // makes the omission enforcement.
  if (!canManageSubUsers(session.role)) notFound();

  if (!session.isAgencyOwner || !session.agencyCode) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-navy-950">Sub Users</h1>
        <AgencyUnavailable />
      </div>
    );
  }

  const agencyCode = session.agencyCode;
  const memberIds = await agencyMemberIds(agencyCode);

  const client = await clerkClient();
  const [members, invitations] = await Promise.all([
    memberIds.length
      ? client.users.getUserList({
          userId: memberIds,
          limit: MAX_AGENCY_MEMBERS,
        })
      : Promise.resolve({ data: [], totalCount: 0 }),
    client.invitations.getInvitationList({ status: 'pending', limit: 100 }),
  ]);

  // Clerk's role is the authority, and filtering on it here also drops the
  // owner — they belong to the agency too, but they are not their own staff.
  const rows: SubUserRow[] = members.data
    .filter(
      (user) => resolveRole(user.publicMetadata?.role) === SUB_USER_ROLE
    )
    .map((user) => ({
      clerkId: user.id,
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      name:
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.username ||
        '—',
      email: user.emailAddresses[0]?.emailAddress ?? '—',
      imageUrl: user.imageUrl,
      disabled: !isUserActive(user),
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
    }));

  // Pending invitations are listed application-wide, so they are narrowed to
  // this agency here — and again in the revoke action, which is what actually
  // protects them.
  const pending: PendingSubUserInvite[] = invitations.data
    .filter((invite) => {
      const metadata = invite.publicMetadata as {
        role?: unknown;
        agencyCode?: unknown;
      } | null;
      return (
        resolveRole(metadata?.role) === SUB_USER_ROLE &&
        metadata?.agencyCode === agencyCode
      );
    })
    .map((invite) => ({
      id: invite.id,
      email: invite.emailAddress,
      createdAt: invite.createdAt,
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-navy-950">Sub Users</h1>
        <p className="mt-1 text-sm text-navy-700/70">
          Staff accounts inside your agency. They see the same dashboard you do,
          apart from this page — a sub user cannot invite or manage other sub
          users.
        </p>
      </div>

      <SubUserInvitePanel agencyCode={agencyCode} pending={pending} />

      <div className="rounded-lg border border-navy-100 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-navy-100 px-4 py-3">
          <p className="text-sm font-semibold text-navy-950">
            {rows.length} {rows.length === 1 ? 'sub user' : 'sub users'}
          </p>
          <p className="text-xs text-navy-700/70">
            Agency{' '}
            <span className="font-mono font-semibold tracking-wider text-navy-900">
              {agencyCode}
            </span>
          </p>
        </div>

        <SubUsersTable rows={rows} />
      </div>
    </div>
  );
}
