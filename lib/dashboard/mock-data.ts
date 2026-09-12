import type { Role, TileKey } from '@/lib/roles';
import { TILE_ACCESS } from '@/lib/roles';

/**
 * Placeholder dashboard data.
 *
 * This is the seam a real API replaces: swap the bodies of getSummary() and
 * getRecentActivity() for fetches and nothing above them has to change. Values
 * are deterministic (no Math.random) so server and client render the same
 * markup and hydration stays clean.
 */

export type SummaryTile = {
  key: TileKey;
  value: number;
  /** Percentage change vs. the previous period; omitted when not meaningful. */
  delta?: number;
};

/** Org-wide figures for admin/staff, own-record figures for b2b/customer. */
const VALUES: Record<Role, Record<TileKey, { value: number; delta?: number }>> =
  {
    superadmin: {
      onHold: { value: 148, delta: 12 },
      pendingDeposit: { value: 37, delta: -4 },
      pendingB2bUsers: { value: 23, delta: 8 },
      coTravelers: { value: 4821, delta: 6 },
      tickets: { value: 12904, delta: 15 },
    },
    admin: {
      onHold: { value: 148, delta: 12 },
      pendingDeposit: { value: 37, delta: -4 },
      pendingB2bUsers: { value: 23, delta: 8 },
      coTravelers: { value: 4821, delta: 6 },
      tickets: { value: 12904, delta: 15 },
    },
    staff_support: {
      onHold: { value: 148, delta: 12 },
      pendingDeposit: { value: 0 },
      pendingB2bUsers: { value: 23, delta: 8 },
      coTravelers: { value: 4821, delta: 6 },
      tickets: { value: 12904, delta: 15 },
    },
    staff_account: {
      onHold: { value: 148, delta: 12 },
      pendingDeposit: { value: 37, delta: -4 },
      pendingB2bUsers: { value: 0 },
      coTravelers: { value: 0 },
      tickets: { value: 12904, delta: 15 },
    },
    staff_media: {
      onHold: { value: 0 },
      pendingDeposit: { value: 0 },
      pendingB2bUsers: { value: 0 },
      coTravelers: { value: 0 },
      tickets: { value: 12904, delta: 15 },
    },
    b2b: {
      onHold: { value: 9, delta: 3 },
      pendingDeposit: { value: 2 },
      pendingB2bUsers: { value: 0 },
      coTravelers: { value: 64, delta: 11 },
      tickets: { value: 312, delta: 7 },
    },
    // The agency's figures, not the individual's — a sub user works the same
    // book of business, so the numbers match the partner's.
    b2b_sub: {
      onHold: { value: 9, delta: 3 },
      pendingDeposit: { value: 2 },
      pendingB2bUsers: { value: 0 },
      coTravelers: { value: 64, delta: 11 },
      tickets: { value: 312, delta: 7 },
    },
    customer: {
      onHold: { value: 1 },
      pendingDeposit: { value: 0 },
      pendingB2bUsers: { value: 0 },
      coTravelers: { value: 4 },
      tickets: { value: 11, delta: 2 },
    },
  };

/** Returns only the tiles this role is allowed to see, in a stable order. */
export function getSummary(role: Role): SummaryTile[] {
  return TILE_ACCESS[role].map((key) => ({ key, ...VALUES[role][key] }));
}

export type ActivityItem = {
  id: string;
  title: string;
  meta: string;
  status: 'on-hold' | 'confirmed' | 'pending' | 'cancelled';
};

const ADMIN_ACTIVITY: ActivityItem[] = [
  {
    id: 'BK-10482',
    title: 'DAC → CXB · Novoair VQ-921',
    meta: 'Skyline Tours · 2 pax · held until 18:40',
    status: 'on-hold',
  },
  {
    id: 'DP-2210',
    title: 'Deposit request · ৳150,000',
    meta: 'Bengal Travels · bKash · submitted 2h ago',
    status: 'pending',
  },
  {
    id: 'BK-10479',
    title: 'DAC → DXB · US-Bangla BS-341',
    meta: 'Rahim Uddin · 1 pax · ticketed',
    status: 'confirmed',
  },
  {
    id: 'B2B-0087',
    title: 'New agency signup · Padma Air Services',
    meta: 'Trade licence uploaded · awaiting review',
    status: 'pending',
  },
  {
    id: 'BK-10465',
    title: 'CGP → DAC · Air Astra 2A-403',
    meta: 'Refunded to source · 3 pax',
    status: 'cancelled',
  },
];

const OWN_ACTIVITY: ActivityItem[] = [
  {
    id: 'BK-10482',
    title: 'DAC → CXB · Novoair VQ-921',
    meta: '2 pax · held until 18:40 today',
    status: 'on-hold',
  },
  {
    id: 'BK-10402',
    title: 'DAC → KUL · Malaysia Airlines MH-197',
    meta: '1 pax · departs 14 Aug',
    status: 'confirmed',
  },
  {
    id: 'BK-10388',
    title: 'DAC → JSR · US-Bangla BS-521',
    meta: '1 pax · flown 02 Jul',
    status: 'confirmed',
  },
];

/** Own-record activity for an agency or a customer; org-wide for everyone else. */
const OWN_ACTIVITY_ROLES: readonly Role[] = ['b2b', 'b2b_sub', 'customer'];

export function getRecentActivity(role: Role): ActivityItem[] {
  return OWN_ACTIVITY_ROLES.includes(role) ? OWN_ACTIVITY : ADMIN_ACTIVITY;
}
