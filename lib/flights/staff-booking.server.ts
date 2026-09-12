import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import {
  pricingPrincipalForSession,
  type PricingPrincipal,
} from '@/lib/flights/pricing-principal';
import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

const STAFF_BOOKING_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_support',
]);
const ASSIGNABLE_ROLES = new Set<Role>(['b2b', 'b2b_sub', 'customer']);

export type StaffBookingAssignee = {
  id: string;
  name: string;
  email: string;
  role: 'b2b' | 'b2b_sub' | 'customer';
  agencyCode: string | null;
  agencyName: string | null;
};

export type BookingActorContext = {
  principal: PricingPrincipal;
  ownerUserId: string;
  createdByUserId: string;
  staffOnBehalf: boolean;
};

export function canCreateBookingOnBehalf(role: Role): boolean {
  return STAFF_BOOKING_ROLES.has(role);
}

type AppUserRow = {
  clerk_id: string;
  role: Role;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  agency_code: string | null;
};

function assigneeFromRow(
  row: AppUserRow,
  agencyNames: Map<string, string>
): StaffBookingAssignee {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    id: row.clerk_id,
    name: name || row.email || row.clerk_id,
    email: row.email || '',
    role: row.role as StaffBookingAssignee['role'],
    agencyCode: row.agency_code,
    agencyName: row.agency_code ? agencyNames.get(row.agency_code) ?? null : null,
  };
}

/** Searches eligible owners in bounded bulk reads; never performs per-user reads. */
export async function searchStaffBookingAssignees(
  query: string,
  limit = 20
): Promise<StaffBookingAssignee[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking storage is unavailable.');
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 30));
  const term = query.trim().slice(0, 80).replace(/[,%_()]/g, ' ');

  let usersQuery = supabase
    .from('app_users')
    .select('clerk_id, role, email, first_name, last_name, agency_code')
    .in('role', ['b2b', 'b2b_sub', 'customer'])
    .order('first_name', { ascending: true })
    .limit(safeLimit);
  if (term) {
    usersQuery = usersQuery.or(
      `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,agency_code.ilike.%${term}%`
    );
  }
  const { data, error } = await usersQuery;
  if (error) throw new Error(`Assignable users could not be loaded: ${error.message}`);
  const rows = (data ?? []) as AppUserRow[];
  const agencyCodes = Array.from(
    new Set(rows.map((row) => row.agency_code).filter((code): code is string => !!code))
  );
  const agencyNames = new Map<string, string>();

  if (agencyCodes.length > 0) {
    const { data: agencies, error: agenciesError } = await supabase
      .from('agencies')
      .select('agency_code, owner_user_id')
      .in('agency_code', agencyCodes);
    if (agenciesError) {
      throw new Error(`Agency identities could not be loaded: ${agenciesError.message}`);
    }
    const ownerIds = Array.from(
      new Set(
        (agencies ?? [])
          .map((agency) => agency.owner_user_id)
          .filter((id): id is string => typeof id === 'string' && !!id)
      )
    );
    if (ownerIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('user_profiles')
        .select('clerk_id, agency_name')
        .in('clerk_id', ownerIds);
      if (profilesError) {
        throw new Error(`Agency identities could not be loaded: ${profilesError.message}`);
      }
      const namesByOwner = new Map(
        (profiles ?? []).map((profile) => [
          String(profile.clerk_id),
          typeof profile.agency_name === 'string' ? profile.agency_name.trim() : '',
        ])
      );
      for (const agency of agencies ?? []) {
        const name = agency.owner_user_id
          ? namesByOwner.get(String(agency.owner_user_id))
          : '';
        if (name) agencyNames.set(String(agency.agency_code), name);
      }
    }
  }

  return rows.map((row) => assigneeFromRow(row, agencyNames));
}

export async function resolveBookingActorContext(
  session: DashboardSession,
  assignedUserId?: string | null
): Promise<BookingActorContext | null> {
  if (!canCreateBookingOnBehalf(session.role)) {
    if (assignedUserId && assignedUserId !== session.clerkId) return null;
    return {
      principal: pricingPrincipalForSession(session),
      ownerUserId: session.clerkId,
      createdByUserId: session.clerkId,
      staffOnBehalf: false,
    };
  }

  if (!assignedUserId) return null;
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('app_users')
    .select('clerk_id, role, agency_code')
    .eq('clerk_id', assignedUserId)
    .maybeSingle();
  if (error || !data || !ASSIGNABLE_ROLES.has(data.role as Role)) return null;
  const agencyRole = data.role === 'b2b' || data.role === 'b2b_sub';
  if (agencyRole && !data.agency_code) return null;

  return {
    principal: {
      userId: data.clerk_id,
      audience: agencyRole ? 'agency' : 'b2c',
      agencyCode: agencyRole ? data.agency_code : null,
    },
    ownerUserId: data.clerk_id,
    createdByUserId: session.clerkId,
    staffOnBehalf: true,
  };
}
