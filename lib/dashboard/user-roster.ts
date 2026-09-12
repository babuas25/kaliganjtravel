import type { clerkClient } from '@clerk/nextjs/server';

import { isUserActive } from '@/lib/account-access';
import { membershipsFor } from '@/lib/db/agencies';
import { agencyNamesFor } from '@/lib/db/profiles';
import { resolveRole, ROLES, type Role } from '@/lib/roles';

/**
 * Reading the account roster for Users & Roles: searching, filtering, sorting
 * and paging it.
 *
 * **Why this walks the whole roster instead of asking Clerk for a page.** Two
 * of the three filters cannot be pushed to Clerk at all — the role lives in
 * public metadata, which its user list cannot filter or order by, and the
 * agency name a partner's row is titled with lives in our own database. Asking
 * Clerk for twenty accounts and then discarding the ones that do not match
 * would give pages of four rows and a page count that lies. So the roster is
 * read once, filtered here, and paged here.
 *
 * That is bounded rather than unlimited: see `MAX_SCAN_PAGES`.
 */

/** Clerk's page cap for a user list request. */
const SCAN_PAGE = 100;

/**
 * How far the walk goes before it stops. Ten requests — a thousand accounts —
 * is generous for an install this shape and keeps the page responsive; beyond
 * it the roster is reported as truncated so the screen can say so rather than
 * quietly filtering a slice and calling it the whole.
 */
const MAX_SCAN_PAGES = 10;

export const USER_SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'recent-sign-in', label: 'Recently signed in' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'agency-asc', label: 'Agency ID A–Z' },
  { id: 'agency-desc', label: 'Agency ID Z–A' },
] as const;

export type UserSort = (typeof USER_SORTS)[number]['id'];

export const STATUS_FILTERS = [
  { id: 'all', label: 'Any status' },
  { id: 'active', label: 'Active' },
  { id: 'deactivated', label: 'Deactivated' },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]['id'];

export type RosterFilters = {
  /** Free text over the displayed name, email address and agency ID. */
  query: string;
  /** A single role, or 'all'. */
  role: Role | 'all';
  status: StatusFilter;
  /** Joined on or after this `YYYY-MM-DD`, or '' for no bound. */
  from: string;
  /** Joined on or before this `YYYY-MM-DD`, or '' for no bound. */
  to: string;
  sort: UserSort;
  /** 1-based. */
  page: number;
};

/**
 * How many of the filters are narrowing the list. Zero means the roster is
 * showing everything in its default order, which is what decides whether the
 * filter panel opens on arrival and whether Clear is worth offering.
 */
export function activeFilterCount(filters: RosterFilters): number {
  return [
    filters.query !== '',
    filters.role !== 'all',
    filters.status !== 'all',
    filters.from !== '',
    filters.to !== '',
    filters.sort !== 'newest',
  ].filter(Boolean).length;
}

/** Narrows a query-string value to a sort, falling back to the default. */
export function resolveSort(value: unknown): UserSort {
  return USER_SORTS.some((sort) => sort.id === value)
    ? (value as UserSort)
    : 'newest';
}

export function resolveStatusFilter(value: unknown): StatusFilter {
  return STATUS_FILTERS.some((status) => status.id === value)
    ? (value as StatusFilter)
    : 'all';
}

export function resolveRoleFilter(value: unknown): Role | 'all' {
  return ROLES.includes(value as Role) ? (value as Role) : 'all';
}

/** A `YYYY-MM-DD` value, or '' for anything else — including a stray string. */
export function resolveDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : '';
}

/** One account, flattened to what the roster sorts, filters and renders on. */
export type RosterEntry = {
  clerkId: string;
  agencyCode: string;
  role: Role;
  /**
   * How the account reads in the list: a B2B partner's agency name, everyone
   * else's own. Resolved here rather than in the table so that searching and
   * sorting by name mean the name actually on screen.
   */
  name: string;
  email: string;
  imageUrl: string;
  active: boolean;
  createdAt: number;
  lastSignInAt: number | null;
};

export type RosterSummary = {
  total: number;
  active: number;
  deactivated: number;
  /** Counts per bucket, in the order they are shown. */
  groups: { label: string; count: number }[];
};

export type Roster = {
  /** The accounts on the requested page, already filtered and sorted. */
  entries: RosterEntry[];
  /** How many accounts matched the filters, across every page. */
  matched: number;
  /** Counts over the whole roster, unaffected by the filters. */
  summary: RosterSummary;
  /** True when the roster was longer than the walk — see `MAX_SCAN_PAGES`. */
  truncated: boolean;
};

type Client = Awaited<ReturnType<typeof clerkClient>>;

/** Every account, newest first, up to the scan bound. */
async function scanRoster(client: Client) {
  const users: Awaited<ReturnType<Client['users']['getUserList']>>['data'] = [];
  let truncated = false;

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= MAX_SCAN_PAGES) {
      truncated = true;
      break;
    }

    const { data, totalCount } = await client.users.getUserList({
      limit: SCAN_PAGE,
      offset: pageIndex * SCAN_PAGE,
      orderBy: '-created_at',
    });
    if (!data.length) break;

    users.push(...data);
    if (users.length >= totalCount) break;
  }

  return { users, truncated };
}

function summarise(entries: RosterEntry[]): RosterSummary {
  const tally = { admins: 0, staff: 0, b2b: 0, customers: 0 };
  let active = 0;

  for (const entry of entries) {
    if (entry.active) active += 1;
    if (entry.role === 'superadmin' || entry.role === 'admin') tally.admins += 1;
    else if (entry.role.startsWith('staff_')) tally.staff += 1;
    else if (entry.role === 'b2b' || entry.role === 'b2b_sub') tally.b2b += 1;
    else tally.customers += 1;
  }

  return {
    total: entries.length,
    active,
    deactivated: entries.length - active,
    groups: [
      { label: 'Admins', count: tally.admins },
      { label: 'Staff', count: tally.staff },
      { label: 'B2B', count: tally.b2b },
      { label: 'Customers', count: tally.customers },
    ],
  };
}

/** Midnight UTC on a `YYYY-MM-DD`, or null. `end` takes the whole day. */
function dateBound(value: string, end: boolean): number | null {
  if (!value) return null;
  const at = Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00'}Z`);
  return Number.isNaN(at) ? null : at;
}

function matches(entry: RosterEntry, filters: RosterFilters): boolean {
  if (filters.role !== 'all' && entry.role !== filters.role) return false;
  if (filters.status === 'active' && !entry.active) return false;
  if (filters.status === 'deactivated' && entry.active) return false;

  const from = dateBound(filters.from, false);
  if (from !== null && entry.createdAt < from) return false;
  const to = dateBound(filters.to, true);
  if (to !== null && entry.createdAt > to) return false;

  if (filters.query) {
    const needle = filters.query.trim().toLowerCase();
    const haystack = `${entry.name} ${entry.email} ${entry.agencyCode}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

function compare(a: RosterEntry, b: RosterEntry, sort: UserSort): number {
  switch (sort) {
    case 'oldest':
      return a.createdAt - b.createdAt;
    case 'recent-sign-in':
      // Never signed in sorts last rather than first, which is what a null
      // would do if it were treated as zero on a descending sort.
      return (b.lastSignInAt ?? -Infinity) - (a.lastSignInAt ?? -Infinity);
    case 'agency-asc':
    case 'agency-desc': {
      // Unassigned accounts stay last in either direction.
      if (!a.agencyCode && b.agencyCode) return 1;
      if (a.agencyCode && !b.agencyCode) return -1;
      const order = a.agencyCode.localeCompare(b.agencyCode, 'en', { numeric: true });
      return (sort === 'agency-desc' ? -order : order) || a.name.localeCompare(b.name, 'en') || a.clerkId.localeCompare(b.clerkId);
    }
    case 'name':
      return a.name.localeCompare(b.name, 'en');
    case 'newest':
    default:
      return b.createdAt - a.createdAt;
  }
}

/**
 * The roster for one page of Users & Roles.
 *
 * The summary is taken before the filters are applied: the header answers "how
 * many accounts are there", not "how many match what I just typed", and a
 * count that moved every time somebody searched would be answering the wrong
 * question.
 */
export async function loadRoster(
  client: Client,
  filters: RosterFilters,
  pageSize: number
): Promise<Roster> {
  const { users, truncated } = await scanRoster(client);

  // One query for every partner on the roster, not one per page: the agency
  // name is the partner's row title, so sorting and searching by name need it
  // for accounts that are not on screen.
  const partnerIds = users
    .filter((user) => resolveRole(user.publicMetadata?.role) === 'b2b')
    .map((user) => user.id);
  const [agencyNames, memberships] = await Promise.all([
    agencyNamesFor(partnerIds),
    membershipsFor(users.map((user) => user.id)),
  ]);

  const entries: RosterEntry[] = users.map((user) => {
    const role = resolveRole(user.publicMetadata?.role);
    const personName =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.username ||
      '—';

    return {
      clerkId: user.id,
      agencyCode: memberships.get(user.id) ?? '',
      role,
      // A B2B partner's account *is* their agency, and several have no first
      // or last name on file at all. Sub users keep their own: they are people
      // working at an agency, and titling them with it would make every
      // colleague look like the same row.
      name: (role === 'b2b' ? agencyNames.get(user.id) : '') || personName,
      email: user.emailAddresses[0]?.emailAddress ?? '—',
      imageUrl: user.imageUrl,
      // The app-controlled access flag is what "deactivated" means here.
      // Legacy Clerk bans remain inactive too, so old records stay truthful.
      active: isUserActive(user),
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
    };
  });

  const summary = summarise(entries);

  const matched = entries
    .filter((entry) => matches(entry, filters))
    .sort((a, b) => compare(a, b, filters.sort));

  const start = (filters.page - 1) * pageSize;

  return {
    entries: matched.slice(start, start + pageSize),
    matched: matched.length,
    summary,
    truncated,
  };
}
