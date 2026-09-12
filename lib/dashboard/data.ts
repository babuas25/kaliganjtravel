import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { listBookings, type BookingRow, type BookingScope } from '@/lib/db/flight-bookings';
import { resolvePublicBookingStatus } from '@/lib/flights/booking-status';
import type { BookingStatus } from '@/lib/flights/booking-status';
import { TILE_ACCESS, type TileKey } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';
import { bookingUserVisibilitySchemaAvailable } from '@/lib/db/booking-visibility';

export type SummaryTile = { key: TileKey; value: number };
export type ActivityItem = {
  id: string;
  title: string;
  meta: string;
  status: BookingStatus;
};

type SummaryBooking = Pick<BookingRow,
  'status' | 'lifecycle_status' | 'airlines_pnr' | 'ticketing_deadline_at' | 'issued_at' | 'passenger_counts'>;

function applyBookingScope<T extends { eq: (column: string, value: string) => T }>(
  query: T,
  scope: BookingScope
): T {
  if (scope.kind === 'agency') return query.eq('agency_code', scope.agencyCode);
  if (scope.kind === 'user') return query.eq('user_id', scope.clerkId);
  return query;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function summaryBookings(scope: BookingScope): Promise<SummaryBooking[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const visibilityAvailable = await bookingUserVisibilitySchemaAvailable();
  const rows: SummaryBooking[] = [];
  const pageSize = 1000;
  while (true) {
    let query = supabase
      .from('booking_lifecycle_v')
      .select('status, lifecycle_status, airlines_pnr, ticketing_deadline_at, issued_at, passenger_counts');
    query = applyBookingScope(query, scope);
    if (scope.kind !== 'all' && visibilityAvailable) {
      query = query.eq('hidden_from_user', false);
    }
    const { data, error } = await query.range(rows.length, rows.length + pageSize - 1);
    if (error) {
      console.error('[dashboard] booking summary failed:', error.message);
      return [];
    }
    const page = (data ?? []) as unknown as SummaryBooking[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function pendingDepositCount(session: DashboardSession): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) return 0;
  const global = ['superadmin', 'admin', 'staff_account'].includes(session.role);
  if (global) {
    const { count, error } = await supabase.from('wallet_deposit_requests')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (error) console.error('[dashboard] deposit summary failed:', error.message);
    return error ? 0 : count ?? 0;
  }
  const ownerType = session.role === 'b2b' || session.role === 'b2b_sub' ? 'agency' : 'user';
  const ownerKey = ownerType === 'agency' ? session.agencyCode : session.clerkId;
  if (!ownerKey) return 0;
  const { data: wallet, error: walletError } = await supabase.from('wallets')
    .select('id').eq('owner_type', ownerType).eq('owner_key', ownerKey).maybeSingle();
  if (walletError || !wallet) return 0;
  const { data: accounts, error: accountError } = await supabase.from('wallet_accounts')
    .select('id').eq('wallet_id', wallet.id);
  if (accountError || !accounts?.length) return 0;
  const { count, error } = await supabase.from('wallet_deposit_requests')
    .select('id', { count: 'exact', head: true }).eq('status', 'pending')
    .in('wallet_account_id', accounts.map((account) => account.id));
  if (error) console.error('[dashboard] deposit summary failed:', error.message);
  return error ? 0 : count ?? 0;
}

async function pendingB2bCount(): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) return 0;
  const { count, error } = await supabase.from('upgrade_requests')
    .select('user_id', { count: 'exact', head: true }).eq('status', 'pending');
  if (error) console.error('[dashboard] B2B summary failed:', error.message);
  return error ? 0 : count ?? 0;
}

export async function getSummary(session: DashboardSession): Promise<SummaryTile[]> {
  const keys = TILE_ACCESS[session.role];
  const [bookings, deposits, pendingB2b] = await Promise.all([
    summaryBookings(bookingScopeFor(session)),
    keys.includes('pendingDeposit') ? pendingDepositCount(session) : 0,
    keys.includes('pendingB2bUsers') ? pendingB2bCount() : 0,
  ]);
  const values: Record<TileKey, number> = {
    onHold: bookings.filter((row) => resolvePublicBookingStatus({
      lifecycleStatus: row.lifecycle_status,
      status: row.status,
      airlinesPnr: stringArray(row.airlines_pnr),
      ticketingDeadlineAt: row.ticketing_deadline_at,
    }) === 'on-hold').length,
    pendingDeposit: deposits,
    pendingB2bUsers: pendingB2b,
    coTravelers: bookings.reduce((total, row) => total + Object.values(row.passenger_counts ?? {})
      .reduce((sum, count) => sum + (Number(count) || 0), 0), 0),
    tickets: bookings.filter((row) => row.status === 'confirmed' && row.issued_at).length,
  };
  return keys.map((key) => ({ key, value: values[key] }));
}

function activityStatus(row: BookingRow): ActivityItem['status'] {
  return resolvePublicBookingStatus({
    lifecycleStatus: row.lifecycle_status,
    status: row.status,
    airlinesPnr: stringArray(row.airlines_pnr),
    ticketingDeadlineAt: row.ticketing_deadline_at,
  });
}

export async function getRecentActivity(session: DashboardSession): Promise<ActivityItem[]> {
  const { rows } = await listBookings(bookingScopeFor(session), 5);
  return rows.map((row) => {
    const firstLeg = row.itinerary?.legs?.[0];
    const route = firstLeg ? `${firstLeg.from} → ${firstLeg.to}` : 'Flight booking';
    const airline = row.itinerary?.carrierName || row.itinerary?.carrierCode || row.supplier;
    const passengers = Object.values(row.passenger_counts ?? {})
      .reduce((sum, count) => sum + (Number(count) || 0), 0);
    return {
      id: row.public_ref,
      title: `${route} · ${airline}`,
      meta: `${passengers} passenger${passengers === 1 ? '' : 's'} · ${new Date(row.created_at).toLocaleDateString('en-GB')}`,
      status: activityStatus(row),
    };
  });
}
