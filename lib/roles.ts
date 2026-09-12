import {
  Activity,
  BadgeDollarSign,
  BarChart3,
  Building2,
  CalendarClock,
  CreditCard,
  FileText,
  Gauge,
  Image as ImageIcon,
  Import,
  LayoutDashboard,
  Megaphone,
  Palette,
  PlaneTakeoff,
  Settings2,
  Percent,
  Ticket,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every role in the system. Flat slugs (rather than role + department) keep
 * permission lookups to a single map read.
 */
export const ROLES = [
  'superadmin',
  'admin',
  'staff_support',
  'staff_account',
  'staff_media',
  'b2b',
  'b2b_sub',
  'customer',
] as const;

export type Role = (typeof ROLES)[number];

/** New sign-ups have no role metadata yet, so customer is the safe default. */
export const DEFAULT_ROLE: Role = 'customer';

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  staff_support: 'Support Staff',
  staff_account: 'Accounts Staff',
  staff_media: 'Media Staff',
  b2b: 'B2B Partner',
  b2b_sub: 'Sub User',
  customer: 'Customer',
};

/** Staff account created by a B2B partner, inside that partner's agency. */
export const SUB_USER_ROLE: Role = 'b2b_sub';

/** Narrows an unknown value (Clerk metadata, a cookie) to a Role. */
export function resolveRole(value: unknown): Role {
  return ROLES.includes(value as Role) ? (value as Role) : DEFAULT_ROLE;
}

/* ── Summary tiles ─────────────────────────────────────────────── */

export const TILE_KEYS = [
  'onHold',
  'pendingDeposit',
  'pendingB2bUsers',
  'coTravelers',
  'tickets',
] as const;

export type TileKey = (typeof TILE_KEYS)[number];

export const TILE_META: Record<
  TileKey,
  { label: string; icon: LucideIcon; hint: string }
> = {
  onHold: {
    label: 'Total On Hold',
    icon: CalendarClock,
    hint: 'Booked but not yet ticketed',
  },
  pendingDeposit: {
    label: 'Total Pending Deposit',
    icon: Wallet,
    hint: 'Deposit requests awaiting approval',
  },
  pendingB2bUsers: {
    label: 'Pending B2B Users',
    icon: UserPlus,
    hint: 'Agency signups awaiting review',
  },
  coTravelers: {
    label: 'Total Co-Traveler',
    icon: Users,
    hint: 'Passengers across bookings',
  },
  tickets: {
    label: 'Total Tickets',
    icon: Ticket,
    hint: 'Issued tickets',
  },
};

/**
 * Which tiles each role sees. Admin/staff figures are org-wide; B2B and
 * customer figures are scoped to their own records.
 */
export const TILE_ACCESS: Record<Role, readonly TileKey[]> = {
  superadmin: TILE_KEYS,
  admin: TILE_KEYS,
  staff_support: ['onHold', 'pendingB2bUsers', 'coTravelers', 'tickets'],
  staff_account: ['onHold', 'pendingDeposit', 'tickets'],
  staff_media: ['tickets'],
  b2b: ['onHold', 'pendingDeposit', 'coTravelers', 'tickets'],
  // A sub user works the same agency's bookings, so they see the same figures.
  b2b_sub: ['onHold', 'pendingDeposit', 'coTravelers', 'tickets'],
  customer: ['onHold', 'coTravelers', 'tickets'],
};

/* ── Navigation ────────────────────────────────────────────────── */

export type NavItem = {
  /** URL segment under /dashboard; empty string is the dashboard home. */
  segment: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /** False while the section is still a placeholder. */
  built?: boolean;
};

const ALL_ROLES = ROLES;
const ADMINS = ['superadmin', 'admin'] as const;
const STAFF = ['staff_support', 'staff_account', 'staff_media'] as const;
const MEDIA_MANAGERS = [...ADMINS, 'staff_media'] as const;
const BOOKING_MANAGERS = [...ADMINS, 'staff_support'] as const;
/**
 * Everyone inside a B2B agency. A sub user's dashboard is the partner's
 * dashboard — same sections, same tiles, same figures — with the single
 * exception of `agency-users` below, which stays the owner's.
 */
const AGENCY = ['b2b', 'b2b_sub'] as const;

export const NAV_ITEMS: readonly NavItem[] = [
  {
    segment: '',
    label: 'Dashboard',
    icon: LayoutDashboard,
    roles: ALL_ROLES,
    built: true,
  },
  // Straight under Dashboard for everyone: the booking engine, served inside
  // the account area so a search never means leaving the dashboard.
  {
    segment: 'flight-search',
    label: 'Flight Search',
    icon: PlaneTakeoff,
    roles: ALL_ROLES,
    built: true,
  },
  {
    segment: 'bookings',
    label: 'Booking Management',
    icon: Ticket,
    roles: BOOKING_MANAGERS,
    built: true,
  },
  {
    segment: 'bookings',
    label: 'My Bookings',
    icon: Ticket,
    roles: ['staff_account', 'staff_media', ...AGENCY, 'customer'],
    built: true,
  },
  {
    segment: 'impexp',
    label: 'IMP/EXP',
    icon: Import,
    roles: BOOKING_MANAGERS,
    built: true,
  },
  // One section, three names: admins manage everyone's "Passengers", a B2B
  // agency sees "My Passengers", and a customer's own saved profiles stay
  // "Co-Travelers". Staff get none. The role sets are disjoint, so
  // navItemsFor never yields more than one.
  {
    segment: 'co-travelers',
    label: 'Passengers',
    icon: Users,
    roles: ADMINS,
    built: true,
  },
  {
    segment: 'co-travelers',
    label: 'My Passengers',
    icon: Users,
    roles: AGENCY,
    built: true,
  },
  {
    segment: 'co-travelers',
    label: 'Co-Travelers',
    icon: Users,
    roles: ['customer'],
    built: true,
  },
  // One section, three names: admins manage it as "Accounts", a B2B agency
  // tops up through "Payment Request", and a customer sees the same balance as
  // "Wallet". Staff get none. The role sets are disjoint, so navItemsFor never
  // yields more than one.
  {
    segment: 'deposits',
    label: 'Accounts',
    icon: BadgeDollarSign,
    roles: [...ADMINS, 'staff_account'],
    built: true,
  },
  {
    segment: 'deposits',
    label: 'Payment Request',
    icon: Wallet,
    roles: AGENCY,
    built: true,
  },
  {
    segment: 'deposits',
    label: 'Wallet',
    icon: Wallet,
    roles: ['customer'],
    built: true,
  },
  // Instalments against a booking. B2B only — retail customers pay in full.
  {
    segment: 'partial-payment',
    label: 'Partial Payment',
    icon: CreditCard,
    roles: AGENCY,
  },
  // One section, two names: admins and agencies work an "Account Ledger", while
  // staff and retail customers see the plain "Statement". The role sets are
  // disjoint, so navItemsFor never yields both.
  {
    segment: 'statement',
    label: 'Account Ledger',
    icon: FileText,
    roles: [...ADMINS, ...AGENCY, 'staff_account'],
    built: true,
  },
  {
    segment: 'statement',
    label: 'Statement',
    icon: FileText,
    roles: ['customer'],
    built: true,
  },
  // Admins get the combined finance/B2B report center. Agencies get the same
  // route labelled for their own narrower, sales-only view.
  {
    segment: 'report',
    label: 'Reports',
    icon: BarChart3,
    roles: [...ADMINS, 'staff_account'],
    built: true,
  },
  {
    segment: 'report',
    label: 'Sales Report',
    icon: BarChart3,
    roles: AGENCY,
    built: true,
  },
  // Pricing adjustments affect every downstream fare, so this control stays
  // with the highest-privilege account.
  {
    segment: 'markup',
    label: 'Markup',
    icon: Percent,
    roles: ['superadmin'],
    built: true,
  },
  {
    segment: 'supplier-control',
    label: 'Supplier Control',
    icon: Settings2,
    roles: ['superadmin'],
    built: true,
  },
  {
    segment: 'search-control',
    label: 'Search Control',
    icon: Gauge,
    roles: ['superadmin'],
    built: true,
  },
  // System-wide booking exceptions belong in a restricted operational report,
  // rather than in the everyday booking list.
  {
    segment: 'system-reports',
    label: 'System Reports',
    icon: Activity,
    roles: ['superadmin'],
    built: true,
  },
  {
    segment: 'b2b-users',
    label: 'B2B Users',
    icon: UserPlus,
    roles: ['staff_support'],
  },
  {
    segment: 'announcements',
    label: 'Announcements',
    icon: Megaphone,
    roles: ALL_ROLES,
    built: true,
  },
  {
    segment: 'media',
    label: 'Media & Banners',
    icon: ImageIcon,
    roles: MEDIA_MANAGERS,
    built: true,
  },
  // Deliberately two different sections, not two labels for one. `users` is
  // the whole-application roster with role control, and only admins reach it;
  // a B2B agency's "User" covers its own logins and never shows anyone else's
  // account, so it gets its own segment.
  {
    segment: 'users',
    label: 'Users & Roles',
    icon: UserCog,
    roles: ADMINS,
    built: true,
  },
  // The one section a sub user does not get. `roles` stays the owner alone,
  // and because `findNavItem()` gates the page, leaving `b2b_sub` off here is
  // also what makes /dashboard/agency-users 404 for them rather than merely
  // hidden. The server actions re-check ownership against the database.
  {
    segment: 'agency-users',
    label: 'Sub User',
    icon: UserCog,
    roles: ['b2b'],
    built: true,
  },
  // Site-wide theming. Superadmin only — plain admins manage content, not the
  // look of the site.
  {
    segment: 'appearance',
    label: 'Appearance',
    icon: Palette,
    roles: ['superadmin'],
    built: true,
  },
  // One section, three names: a B2B partner manages agency details under
  // "Company", staff see "Staff Profile", and admins and customers keep the
  // plain "Profile". The role sets are disjoint, so navItemsFor never yields
  // more than one.
  {
    segment: 'profile',
    label: 'Company',
    icon: Building2,
    roles: AGENCY,
    built: true,
  },
  {
    segment: 'profile',
    label: 'Staff Profile',
    icon: UserCog,
    roles: STAFF,
    built: true,
  },
  {
    segment: 'profile',
    label: 'Profile',
    icon: UserCog,
    roles: [...ADMINS, 'customer'],
    built: true,
  },
];

/* ── User management ───────────────────────────────────────────── */

/**
 * Who may open Users & Roles at all. Staff, B2B partners and customers get
 * nothing here — not a filtered list, not a read-only view.
 */
export function canManageUsers(role: Role): boolean {
  return role === 'superadmin' || role === 'admin';
}

/** Site announcement content belongs to administrators and the media team. */
export function canManageMedia(role: Role): boolean {
  return MEDIA_MANAGERS.includes(role as (typeof MEDIA_MANAGERS)[number]);
}

/**
 * The roles an actor is allowed to hand out. A Super Admin can grant anything,
 * including another Super Admin; an Admin can grant everything below that line
 * but cannot mint one.
 */
export function assignableRoles(actor: Role): readonly Role[] {
  if (actor === 'superadmin') return ROLES;
  if (actor === 'admin') return ROLES.filter((r) => r !== 'superadmin');
  return [];
}

/**
 * Whether an actor may open **and edit** another account's stored profile from
 * the roster — their contact details, passport, bank account and, for an
 * agency, its company information.
 *
 * Reading and correcting share one rule because the sensitive part is the same
 * either way: whoever can see a passport number is trusted with it, and an
 * admin who could see but not fix a typo would only end up asking someone else
 * to make the same change.
 *
 * Deliberately **not** `userActionBlockedReason()`. That guards role changes,
 * and so refuses your own row — meaningless here, since correcting your own
 * details is the least remarkable thing on this page. The rule is the
 * seniority line alone: you may open any account whose role you are allowed to
 * grant, so a plain Admin does not reach a Super Admin's identity documents.
 */
export function canManageUserProfile(actor: Role, target: Role): boolean {
  return canManageUsers(actor) && assignableRoles(actor).includes(target);
}

/**
 * Roles that are meaningless without an agency to belong to, and so cannot be
 * granted on their own.
 *
 * Only `b2b_sub`: a sub user is staff *of* an agency, and one without a parent
 * would see an agency dashboard scoped to nothing. `b2b` is absent because a
 * partner's agency is created for them rather than chosen.
 *
 * Whoever grants the role supplies the agency. An admin in Users & Roles picks
 * one; a B2B partner inviting their own staff never sees the field, because
 * there is only one answer and it is not theirs to change.
 */
export function roleRequiresAgency(role: Role): boolean {
  return role === SUB_USER_ROLE;
}

/**
 * Whether a role sees the Sub User section at all — the B2B partner, never
 * their staff.
 *
 * **Presentation only.** Being a B2B partner is not by itself permission to
 * touch a given account: the actor also has to own the agency that account
 * belongs to, and that is a database fact (`isAgencyOwner` on the session,
 * from `lib/db/agencies.ts`), re-read on the way into every write.
 */
export function canManageSubUsers(role: Role): boolean {
  return role === 'b2b';
}

/**
 * Whether this role may ask to be upgraded to a B2B partner — the yellow
 * button at the foot of the sidebar, and the page behind it.
 *
 * Retail customers alone. Everybody else is either already inside an agency
 * (`b2b`, `b2b_sub`) or is our own staff, and neither has anything to apply
 * for. It is also the gate on `/dashboard/upgrade`, so the page 404s for them
 * rather than merely hiding the link.
 *
 * **Presentation and routing, not the grant.** Accepting an application is a
 * role change like any other, made by an admin in Users & Roles and subject to
 * every check that live there.
 */
export function canRequestUpgrade(role: Role): boolean {
  return role === 'customer';
}

/**
 * Why an actor may not change a given account's role, or null when they may.
 * One function so the table (which disables the row) and the server actions
 * (which reject the call) can never disagree.
 */
export function userActionBlockedReason(
  actor: { role: Role; clerkId: string },
  target: { role: Role; clerkId: string }
): string | null {
  if (!canManageUsers(actor.role)) {
    return 'You do not have permission to manage users.';
  }
  // Self-service is deliberately excluded: it is the only way to demote or
  // delete the account you are signed in with and lock yourself out.
  if (actor.clerkId === target.clerkId) {
    return 'You cannot change your own account here.';
  }
  if (actor.role === 'admin' && target.role === 'superadmin') {
    return 'Only a Super Admin can manage a Super Admin.';
  }
  return null;
}

/**
 * Why an actor may not delete a given account, or null when they may.
 *
 * Everything that blocks a role change blocks a deletion too, and one thing
 * more: **deleting is a Super Admin's alone.** An Admin manages accounts —
 * grants roles, corrects details — but removing a person, their bookings and
 * their profile for good is the one action that is not theirs, in either
 * direction and regardless of whose account it is.
 */
export function userDeleteBlockedReason(
  actor: { role: Role; clerkId: string },
  target: { role: Role; clerkId: string }
): string | null {
  const blocked = userActionBlockedReason(actor, target);
  if (blocked) return blocked;

  if (actor.role !== 'superadmin') {
    return 'Only a Super Admin can delete an account.';
  }
  return null;
}

export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Looks up a nav item a role is allowed to reach, or undefined. */
export function findNavItem(role: Role, segment: string): NavItem | undefined {
  return navItemsFor(role).find((item) => item.segment === segment);
}
