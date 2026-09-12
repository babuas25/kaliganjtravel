import { redirect } from 'next/navigation';
import { UserProfile } from '@clerk/nextjs';
import { clerkClient, currentUser } from '@clerk/nextjs/server';
import { AlertTriangle, KeyRound } from 'lucide-react';

import ProfileDetailsForm from '@/components/dashboard/ProfileDetailsForm';
import type { StaffEntry } from '@/components/dashboard/StaffPanel';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getProfile } from '@/lib/db/profiles';
import { signDocuments, type SignedDoc } from '@/lib/db/document-uploads';
import { isCloudinaryConfigured } from '@/lib/cloudinary';
import { FILE_FIELDS } from '@/lib/profile';
import { getStaffDetails, staffDetailsFor } from '@/lib/db/staff';
import { agencyMemberIds } from '@/lib/db/sub-users';
import type { ProfileValues } from '@/lib/profile';
import { EMPTY_STAFF, hasStaffValues } from '@/lib/staff';
import { resolveRole, SUB_USER_ROLE } from '@/lib/roles';
import { MAX_AGENCY_MEMBERS } from '@/lib/db/sub-users';
import type { DashboardSession } from '@/lib/dashboard/session';

/**
 * Clerk renders its own self-contained card, which reads as a different app
 * next to the dashboard. These overrides strip its chrome so it sits inside
 * our section card and picks up the navy/orange palette.
 */
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#f68712',
    colorText: '#171717',
    colorTextSecondary: '#525252',
    colorBackground: '#ffffff',
    borderRadius: '0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.875rem',
  },
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full max-w-none border-0 shadow-none rounded-none',
    card: 'shadow-none border-0 rounded-none',
    navbar: 'bg-navy-50/60 border-r border-navy-100',
    navbarButton: 'text-navy-700',
    headerTitle: 'text-navy-950',
    headerSubtitle: 'text-navy-700/70',
    profileSectionTitleText: 'text-navy-950',
    formButtonPrimary:
      'bg-brand-orange hover:bg-brand-orange-dark hover:text-white text-navy-950 normal-case',
  },
};

/**
 * Shown in place of the form when the stored profile could not be read.
 *
 * The form posts every field in one go, so rendering it with blank values
 * after a failed read is not a cosmetic problem: the next save would write
 * NULL over a passport number, a date of birth and a bank account that are
 * still in the table. Refusing to render is the only safe response — an empty
 * form is indistinguishable from an empty profile once it reaches the browser.
 */
function ProfileUnavailable() {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-amber-900">
            Your profile could not be loaded
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            The details on file could not be read just now, so the form is
            hidden rather than shown blank — saving an empty form would
            overwrite what is stored. Nothing has been changed. Reload the page
            to try again, and contact support if it keeps happening.
          </p>
        </div>
      </div>
    </section>
  );
}

type StaffData = {
  entries: StaffEntry[];
  isAdmin: boolean;
  readFailed: boolean;
};

const NO_STAFF: StaffData = { entries: [], isAdmin: false, readFailed: false };

/**
 * Who appears on the Staff tab.
 *
 * An **agency owner** gets their sub users: the database says who belongs to
 * the agency, Clerk names them, matching the Sub Users page. A **sub user**
 * gets exactly one entry — their own — so there is nothing on screen for them
 * to reach that the server would refuse anyway. Every other role gets no tab
 * and never reaches this.
 *
 * A failed read is reported rather than rendered as an empty list: the panel
 * submits every field at once, so a blank form would overwrite stored details
 * on the next save.
 */
async function loadStaff(session: DashboardSession): Promise<StaffData> {
  if (session.role === SUB_USER_ROLE) {
    const record = await getStaffDetails(session.clerkId);
    if (!record.ok) return { entries: [], isAdmin: false, readFailed: true };

    return {
      entries: [
        {
          userId: session.clerkId,
          name: session.name,
          email: session.email,
          values: record.values,
          hasRecord: hasStaffValues(record.values),
        },
      ],
      isAdmin: false,
      readFailed: false,
    };
  }

  // Ownership is the database's answer, not the role's — same gate the staff
  // actions apply, so the list can never show what a save would refuse.
  if (session.role !== 'b2b' || !session.isAgencyOwner || !session.agencyCode) {
    return NO_STAFF;
  }

  const memberIds = (await agencyMemberIds(session.agencyCode)).filter(
    (id) => id !== session.clerkId
  );
  if (!memberIds.length) return { entries: [], isAdmin: true, readFailed: false };

  const client = await clerkClient();
  const { data } = await client.users.getUserList({
    userId: memberIds,
    limit: MAX_AGENCY_MEMBERS,
  });

  // Clerk owns the role, so the filter happens on its answer rather than on
  // the mirror — the same reason the Sub Users page does it this way.
  const subUsers = data.filter(
    (user) => resolveRole(user.publicMetadata?.role) === SUB_USER_ROLE
  );

  const records = await staffDetailsFor(subUsers.map((user) => user.id));
  if (!records) return { entries: [], isAdmin: true, readFailed: true };

  return {
    entries: subUsers.map((user) => {
      const values = records.get(user.id) ?? { ...EMPTY_STAFF };
      return {
        userId: user.id,
        name:
          [user.firstName, user.lastName].filter(Boolean).join(' ') ||
          user.username ||
          '—',
        email: user.emailAddresses[0]?.emailAddress ?? '—',
        values,
        // A row holding nothing reads the same as no row to whoever is
        // looking, so it offers "Add details" rather than a delete.
        hasRecord: hasStaffValues(values),
      };
    }),
    isAdmin: true,
    readFailed: false,
  };
}

export default async function DashboardProfilePage() {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');

  const [user, profile, staff] = await Promise.all([
    currentUser(),
    getProfile(session.clerkId),
    loadStaff(session),
  ]);

  // Only build the form's starting values from a read that actually
  // succeeded. See below for why a failed read must not fall back to blanks.
  let defaults: Partial<ProfileValues> | null = null;
  // Signed on the server, for this render only. They expire in minutes, which
  // is the point — the field component re-signs after every write.
  const documentLinks: Record<string, SignedDoc> = {};

  if (profile.ok) {
    for (const field of FILE_FIELDS) {
      const doc = profile.documents[field];
      if (!doc) continue;
      const [link] = signDocuments([doc], () => 'View');
      if (link) documentLinks[field] = link;
    }
  }

  if (profile.ok) {
    const saved = profile.values;

    // Clerk seeds the first visit; anything already saved wins over it. Blank
    // stored values fall through so the seed still shows.
    defaults = {
      givenName: saved.givenName || (user?.firstName ?? ''),
      surname: saved.surname || (user?.lastName ?? ''),
      email: saved.email || session.email,
    };

    for (const [field, value] of Object.entries(saved)) {
      if (value && !(field in defaults)) {
        defaults[field as keyof ProfileValues] = value;
      }
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* Same required details for every role; B2B partners get the extra
          Business Info and Business Docs sections on top. */}
      {defaults ? (
        <ProfileDetailsForm
          role={session.role}
          defaults={defaults}
          agencyCode={session.agencyCode}
          staffEntries={staff.entries}
          staffIsAdmin={staff.isAdmin}
          staffReadFailed={staff.readFailed}
          documentLinks={documentLinks}
          documentsConfigured={isCloudinaryConfigured()}
        />
      ) : (
        <ProfileUnavailable />
      )}

      <section className="overflow-hidden rounded-lg border border-navy-100 bg-white">
        <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
            <KeyRound className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-navy-950">
              Account &amp; security
            </h3>
            <p className="mt-0.5 text-xs text-navy-700/70">
              Sign-in email, connected accounts and password.
            </p>
          </div>
        </header>

        <UserProfile routing="hash" appearance={CLERK_APPEARANCE} />
      </section>
    </div>
  );
}
