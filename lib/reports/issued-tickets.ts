import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import type { BookingPassengerType, BookingTraveller, BookedItinerary } from '@/lib/flights/booking';
import type { BookingDraftPricing } from '@/lib/flights/booking';
import { supabaseAdmin } from '@/lib/supabase/server';
import { bookingUserVisibilitySchemaAvailable } from '@/lib/db/booking-visibility';
import { isAgencyCode } from '@/lib/agency';

export type IssuedTicketFilters = {
  from?: string;
  to?: string;
  bookedBy?: string;
  airline?: string;
  search?: string;
};

export type IssuedTicketScope = {
  agencyCode: string;
  /** Agency users must not see records an administrator hid from them. */
  excludeHiddenFromAgency: boolean;
};

const CROSS_AGENCY_REPORT_ROLES = new Set([
  'superadmin',
  'admin',
  'staff_account',
]);

/**
 * Resolves the one agency a ticket report may read. B2B users are always
 * pinned to their database-backed membership; only finance/admin roles may
 * choose an agency from the report picker.
 */
export function issuedTicketScopeFor(
  session: DashboardSession,
  requestedAgencyCode?: string
): IssuedTicketScope | null {
  if (session.role === 'b2b' || session.role === 'b2b_sub') {
    if (!session.agencyCode) return null;
    if (requestedAgencyCode && requestedAgencyCode !== session.agencyCode) return null;
    return {
      agencyCode: session.agencyCode,
      excludeHiddenFromAgency: true,
    };
  }

  if (
    !CROSS_AGENCY_REPORT_ROLES.has(session.role) ||
    !isAgencyCode(requestedAgencyCode)
  ) {
    return null;
  }

  return {
    agencyCode: requestedAgencyCode,
    excludeHiddenFromAgency: false,
  };
}

export type IssuedTicketRow = {
  id: string;
  orderReference: string;
  pnr: string;
  airlineCode: string;
  airlineName: string;
  totalSegments: number;
  createdAt: string;
  ticketedAt: string;
  totalPassengers: number;
  mainTravellerName: string;
  currency: string;
  grossFare: number | null;
  payableAmount: number;
  profit: number | null;
  bookedByUserId: string | null;
  bookedByName: string;
};

export type ReportUserOption = { id: string; label: string };
export type ReportAirlineOption = { code: string; label: string };
export type IssuedTicketSummary = {
  totalItems: number;
  totalPassengers: number;
  missingGrossCount: number;
  totalsByCurrency: Array<{
    currency: string;
    totalGross: number;
    totalPayable: number;
    totalProfit: number;
  }>;
};

type ReportBooking = {
  id: string;
  public_ref: string;
  pnr: string | null;
  airlines_pnr: unknown;
  itinerary: BookedItinerary | null;
  passenger_counts: Partial<Record<BookingPassengerType, number>>;
  passengers: unknown;
  currency: string;
  pricing_snapshot: BookingDraftPricing;
  supplier_gross_amount: number | null;
  user_payable_amount: number | null;
  created_at: string;
  issued_at: string;
  booked_by_user_id: string | null;
};

type ReportFinancialBooking = Pick<
  ReportBooking,
  'currency' | 'pricing_snapshot' | 'supplier_gross_amount' | 'user_payable_amount' | 'passenger_counts'
>;

type AppUser = {
  clerk_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

const SELECT = 'id, public_ref, pnr, airlines_pnr, itinerary, passenger_counts, passengers, currency, pricing_snapshot, supplier_gross_amount, user_payable_amount, created_at, issued_at, booked_by_user_id';
const FINANCIAL_SELECT = 'currency, pricing_snapshot, supplier_gross_amount, user_payable_amount, passenger_counts';

function userLabel(user: AppUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
    || user.email
    || 'Unknown user';
}

function travellers(value: unknown): BookingTraveller[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as { travellers?: unknown }).travellers;
  return Array.isArray(list) ? (list as BookingTraveller[]) : [];
}

function displayPnr(row: Pick<ReportBooking, 'pnr' | 'airlines_pnr'>): string {
  const airlinePnrs = Array.isArray(row.airlines_pnr)
    ? row.airlines_pnr
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return airlinePnrs.length > 0
    ? airlinePnrs.join(', ')
    : row.pnr?.trim() || '—';
}

function majorAmount(snapshotAmount: unknown, minorAmount: unknown): number | null {
  if (snapshotAmount !== null && snapshotAmount !== undefined && snapshotAmount !== '') {
    const snapshot = Number(snapshotAmount);
    if (Number.isFinite(snapshot) && snapshot >= 0) return snapshot;
  }

  if (minorAmount !== null && minorAmount !== undefined && minorAmount !== '') {
    const minor = Number(minorAmount);
    if (Number.isFinite(minor) && minor >= 0) return minor / 100;
  }
  return null;
}

function difference(left: number, right: number): number {
  return (Math.round(left * 100) - Math.round(right * 100)) / 100;
}

function financials(row: ReportFinancialBooking) {
  const grossFare = majorAmount(
    row.pricing_snapshot?.grossPrice,
    row.supplier_gross_amount
  );
  const payableAmount = majorAmount(
    row.pricing_snapshot?.sellingPrice,
    row.user_payable_amount
  ) ?? 0;
  return {
    grossFare,
    payableAmount,
    profit: grossFare === null ? null : difference(grossFare, payableAmount),
  };
}

function toRow(row: ReportBooking, userNames: Map<string, string>): IssuedTicketRow {
  const itinerary = row.itinerary;
  const lead = travellers(row.passengers)[0];
  const totalPassengers = Object.values(row.passenger_counts ?? {})
    .reduce((sum, count) => sum + (Number(count) || 0), 0);
  const { grossFare, payableAmount, profit } = financials(row);
  return {
    id: row.id,
    orderReference: row.public_ref,
    pnr: displayPnr(row),
    airlineCode: itinerary?.carrierCode || '—',
    airlineName: itinerary?.carrierName || itinerary?.carrierCode || 'Unknown airline',
    totalSegments: itinerary?.legs.reduce((sum, leg) => sum + leg.segments.length, 0) ?? 0,
    createdAt: row.created_at,
    ticketedAt: row.issued_at,
    totalPassengers,
    mainTravellerName: lead
      ? [lead.title, lead.firstName, lead.lastName].filter(Boolean).join(' ').trim().toUpperCase()
      : '—',
    currency: row.currency,
    grossFare,
    payableAmount,
    profit,
    bookedByUserId: row.booked_by_user_id,
    bookedByName: row.booked_by_user_id
      ? userNames.get(row.booked_by_user_id) || 'Unknown user'
      : 'Unknown user',
  };
}

function baseQuery(
  scope: IssuedTicketScope,
  filters: IssuedTicketFilters,
  visibilityAvailable: boolean,
  select = SELECT
) {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  let query = supabase
    .from('flight_bookings')
    .select(select, { count: 'exact' })
    .eq('legacy_operational', false)
    .eq('agency_code', scope.agencyCode)
    .eq('status', 'confirmed')
    .not('issued_at', 'is', null)
    .order('issued_at', { ascending: false });
  if (visibilityAvailable && scope.excludeHiddenFromAgency) {
    query = query.eq('hidden_from_user', false);
  }
  if (filters.from) query = query.gte('issued_at', `${filters.from}T00:00:00.000Z`);
  if (filters.to) query = query.lte('issued_at', `${filters.to}T23:59:59.999Z`);
  if (filters.bookedBy) query = query.eq('booked_by_user_id', filters.bookedBy);
  if (filters.airline) query = query.eq('itinerary->>carrierCode', filters.airline);
  if (filters.search) query = query.ilike('public_ref', `%${filters.search}%`);
  return query;
}

async function agencyUsers(scope: IssuedTicketScope): Promise<AppUser[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('app_users')
    .select('clerk_id, email, first_name, last_name')
    .eq('agency_code', scope.agencyCode)
    .order('first_name');
  if (error) throw new Error(`Agency users could not be loaded: ${error.message}`);
  return (data ?? []) as AppUser[];
}

async function bookingUserNames(
  rows: Array<Pick<ReportBooking, 'booked_by_user_id'>>,
  agencyRoster: AppUser[]
): Promise<Map<string, string>> {
  const users = new Map(agencyRoster.map((user) => [user.clerk_id, userLabel(user)]));
  const missingIds = Array.from(new Set(rows.flatMap((row) => {
    const id = row.booked_by_user_id;
    return id && !users.has(id) ? [id] : [];
  })));
  if (missingIds.length === 0) return users;

  const supabase = supabaseAdmin();
  if (!supabase) return users;
  const { data, error } = await supabase
    .from('app_users')
    .select('clerk_id, email, first_name, last_name')
    .in('clerk_id', missingIds);
  if (error) {
    console.error('[issued-ticket-report] booking user lookup failed:', error.message);
    return users;
  }
  for (const user of (data ?? []) as AppUser[]) {
    users.set(user.clerk_id, userLabel(user));
  }
  return users;
}

export async function listIssuedTickets(
  scope: IssuedTicketScope,
  filters: IssuedTicketFilters,
  page: number,
  pageSize: number
) {
  const users = await agencyUsers(scope);
  const visibilityAvailable = await bookingUserVisibilitySchemaAvailable();
  const query = baseQuery(scope, filters, visibilityAvailable);
  if (!query) throw new Error('Issued-ticket storage is unavailable.');
  const from = (page - 1) * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`Issued tickets could not be loaded: ${error.message}`);
  const rows = (data ?? []) as unknown as ReportBooking[];
  const userNames = await bookingUserNames(rows, users);
  return {
    rows: rows.map((row) => toRow(row, userNames)),
    total: count ?? 0,
    users: users.map((user) => ({ id: user.clerk_id, label: userLabel(user) })),
  };
}

export async function listAllIssuedTickets(
  scope: IssuedTicketScope,
  filters: IssuedTicketFilters
): Promise<IssuedTicketRow[]> {
  const users = await agencyUsers(scope);
  const visibilityAvailable = await bookingUserVisibilitySchemaAvailable();
  const rows: ReportBooking[] = [];
  const pageSize = 1000;
  while (true) {
    const query = baseQuery(scope, filters, visibilityAvailable);
    if (!query) throw new Error('Issued-ticket storage is unavailable.');
    const { data, error } = await query.range(rows.length, rows.length + pageSize - 1);
    if (error) throw new Error(`Issued tickets could not be loaded: ${error.message}`);
    const page = (data ?? []) as unknown as ReportBooking[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  const userNames = await bookingUserNames(rows, users);
  return rows.map((row) => toRow(row, userNames));
}

export async function summarizeIssuedTickets(
  scope: IssuedTicketScope,
  filters: IssuedTicketFilters
): Promise<IssuedTicketSummary> {
  const visibilityAvailable = await bookingUserVisibilitySchemaAvailable();
  const rows: ReportFinancialBooking[] = [];
  const pageSize = 1000;
  while (true) {
    const query = baseQuery(
      scope,
      filters,
      visibilityAvailable,
      FINANCIAL_SELECT
    );
    if (!query) throw new Error('Issued-ticket storage is unavailable.');
    const { data, error } = await query.range(rows.length, rows.length + pageSize - 1);
    if (error) throw new Error(`Issued-ticket summary could not be loaded: ${error.message}`);
    const page = (data ?? []) as unknown as ReportFinancialBooking[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const totals = new Map<string, {
    grossMinor: number;
    payableMinor: number;
    profitMinor: number;
  }>();
  let missingGrossCount = 0;
  let totalPassengers = 0;
  for (const row of rows) {
    totalPassengers += Object.values(row.passenger_counts ?? {})
      .reduce((sum, count) => sum + (Number(count) || 0), 0);
    const amounts = financials(row);
    const currency = row.currency || 'BDT';
    const currencyTotals = totals.get(currency) ?? {
      grossMinor: 0,
      payableMinor: 0,
      profitMinor: 0,
    };
    currencyTotals.payableMinor += Math.round(amounts.payableAmount * 100);
    if (amounts.grossFare === null || amounts.profit === null) {
      missingGrossCount += 1;
    } else {
      currencyTotals.grossMinor += Math.round(amounts.grossFare * 100);
      currencyTotals.profitMinor += Math.round(amounts.profit * 100);
    }
    totals.set(currency, currencyTotals);
  }

  return {
    totalItems: rows.length,
    totalPassengers,
    missingGrossCount,
    totalsByCurrency: Array.from(totals, ([currency, amounts]) => ({
      currency,
      totalGross: amounts.grossMinor / 100,
      totalPayable: amounts.payableMinor / 100,
      totalProfit: amounts.profitMinor / 100,
    })).sort((left, right) => left.currency.localeCompare(right.currency)),
  };
}

export async function listIssuedTicketAirlines(
  scope: IssuedTicketScope
): Promise<ReportAirlineOption[]> {
  const rows = await listAllIssuedTickets(scope, {});
  return Array.from(new Map(rows.map((row) => [
    row.airlineCode,
    { code: row.airlineCode, label: `${row.airlineCode} — ${row.airlineName}` },
  ])).values()).sort((left, right) => left.label.localeCompare(right.label));
}
