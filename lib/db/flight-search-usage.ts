import 'server-only';

import { createHash } from 'node:crypto';

import type { FlightSearchInput } from '@/lib/flights/types';
import { isFlightReadSupplier, type FlightReadSupplier } from '@/lib/flights/supplier';
import { supabaseAdmin } from '@/lib/supabase/server';

export type FlightSearchUsageOutcome =
  | 'success'
  | 'failed'
  | 'rate_limited'
  | 'busy';

export type FlightSearchUsageClaim = {
  allowed: boolean;
  code:
    | 'ALLOWED'
    | 'USER_SEARCH_DISABLED'
    | 'USER_DAILY_LIMIT_REACHED'
    | 'SUPPLIER_DAILY_LIMIT_REACHED'
    | 'USAGE_CONTROLS_UNAVAILABLE';
  supplierCount: number;
  supplierLimit: number | null;
  userCount: number;
  userLimit: number | null;
};

export type FlightSearchUsageTotals = {
  requestCount: number;
  supplierApiHitCount: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  anonymousCount: number;
  uniqueUserCount: number;
  averageTotalMs: number | null;
};

export type FlightSearchUserUsage = {
  userId: string | null;
  displayName: string | null;
  email: string | null;
  role: string | null;
  agencyCode: string | null;
  agencyName: string | null;
  searchedRoutes: FlightSearchRouteUsage[];
  distinctRouteCount: number;
  requestCount: number;
  supplierApiHitCount: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  lastSearchAt: string | null;
  averageTotalMs: number | null;
  searchEnabled: boolean;
  dailyLimit: number | null;
  controlVersion: number;
  todayHitCount: number;
};

export type FlightSearchRouteUsage = {
  route: string;
  departureDates: string[];
  requestCount: number;
  lastSearchedAt: string | null;
};

export type FlightSearchSupplierUsage = {
  supplier: FlightReadSupplier;
  requestCount: number;
  supplierApiHitCount: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  lastSearchAt: string | null;
  dailyLimit: number | null;
  limitVersion: number;
  todayHitCount: number;
};

export type FlightSearchUsageReport = {
  available: boolean;
  totals: FlightSearchUsageTotals;
  users: FlightSearchUserUsage[];
  suppliers: FlightSearchSupplierUsage[];
};

const EMPTY_TOTALS: FlightSearchUsageTotals = {
  requestCount: 0,
  supplierApiHitCount: 0,
  successCount: 0,
  failedCount: 0,
  blockedCount: 0,
  anonymousCount: 0,
  uniqueUserCount: 0,
  averageTotalMs: null,
};

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function routeUsage(value: unknown): FlightSearchRouteUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FlightSearchRouteUsage[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const route = text(row.route);
    if (!route) return [];
    const departureDates = Array.isArray(row.departureDates)
      ? row.departureDates.flatMap((value): string[] => {
          const date = text(value);
          return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? [date] : [];
        })
      : [];
    return [{
      route,
      departureDates,
      requestCount: integer(row.requestCount),
      lastSearchedAt: text(row.lastSearchedAt),
    }];
  });
}

function usageTableMissing(error: { code?: string | null; message?: string | null }) {
  return error.code === '42P01' || error.code === 'PGRST205' ||
    /flight_search_(?:usage|supplier|user|daily)/i.test(error.message ?? '');
}

/** Starts one validated website-search event before any daily budget is spent. */
export async function beginFlightSearchUsage(input: {
  traceId: string;
  actorUserId: string | null;
  actorKey: string;
  actorRole: string;
  agencyCode: string | null;
  supplier: FlightReadSupplier;
  requestMode: 'stream' | 'json';
  search: FlightSearchInput;
}): Promise<string | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  if (input.actorUserId) {
    const { error: userError } = await supabase.from('app_users').upsert(
      { clerk_id: input.actorUserId },
      { onConflict: 'clerk_id', ignoreDuplicates: true }
    );
    if (userError) {
      console.error('[flight-search-usage] user stub failed:', userError.message);
      return null;
    }
  }
  const actorKeyHash = `sha256:${createHash('sha256')
    .update(input.actorKey, 'utf8')
    .digest('hex')}`;
  const { data, error } = await supabase
    .from('flight_search_usage_events')
    .insert({
      trace_id: input.traceId,
      actor_user_id: input.actorUserId,
      actor_key_hash: actorKeyHash,
      actor_role: input.actorRole,
      agency_code: input.agencyCode,
      supplier_account: input.supplier,
      request_mode: input.requestMode,
      trip_type: input.search.tripType,
      routes: input.search.routes,
      adults: input.search.adults,
      children: input.search.children,
      infants: input.search.infants,
      cabin_class: input.search.cabinClass,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (!usageTableMissing(error)) {
      console.error('[flight-search-usage] event start failed:', error.message);
    }
    return null;
  }
  return text((data as { id?: unknown } | null)?.id);
}

/** Reserves both the supplier and signed-in user's Dhaka-calendar-day budget. */
export async function claimFlightSearchSupplierHit(input: {
  eventId: string | null;
  supplier: FlightReadSupplier;
  userId: string | null;
}): Promise<FlightSearchUsageClaim> {
  if (!input.eventId) {
    return {
      allowed: process.env.NODE_ENV !== 'production',
      code: 'USAGE_CONTROLS_UNAVAILABLE',
      supplierCount: 0,
      supplierLimit: null,
      userCount: 0,
      userLimit: null,
    };
  }
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      allowed: true,
      code: 'USAGE_CONTROLS_UNAVAILABLE',
      supplierCount: 0,
      supplierLimit: null,
      userCount: 0,
      userLimit: null,
    };
  }
  const { data, error } = await supabase.rpc(
    'claim_flight_search_supplier_hit_v1',
    {
      p_event_id: input.eventId,
      p_supplier: input.supplier,
      p_user_id: input.userId,
    }
  );
  if (error) {
    console.error('[flight-search-usage] daily budget claim failed:', error.message);
    return {
      allowed: false,
      code: 'USAGE_CONTROLS_UNAVAILABLE',
      supplierCount: 0,
      supplierLimit: null,
      userCount: 0,
      userLimit: null,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    return {
      allowed: false,
      code: 'USAGE_CONTROLS_UNAVAILABLE',
      supplierCount: 0,
      supplierLimit: null,
      userCount: 0,
      userLimit: null,
    };
  }
  const value = row as Record<string, unknown>;
  const code = text(value.result_code);
  const acceptedCode = code === 'ALLOWED' ||
    code === 'USER_SEARCH_DISABLED' ||
    code === 'USER_DAILY_LIMIT_REACHED' ||
    code === 'SUPPLIER_DAILY_LIMIT_REACHED'
    ? code
    : 'USAGE_CONTROLS_UNAVAILABLE';
  return {
    allowed: value.allowed === true && acceptedCode === 'ALLOWED',
    code: acceptedCode,
    supplierCount: integer(value.supplier_count),
    supplierLimit: nullableInteger(value.supplier_limit),
    userCount: integer(value.user_count),
    userLimit: nullableInteger(value.user_limit),
  };
}

/** Finalizes telemetry without ever affecting the search response. */
export async function finishFlightSearchUsage(input: {
  eventId: string | null;
  outcome: FlightSearchUsageOutcome;
  httpStatus: number;
  errorCode?: string | null;
  itineraryCount?: number | null;
  partial?: boolean | null;
  totalMs?: number | null;
  supplierMs?: number | null;
}): Promise<void> {
  if (!input.eventId) return;
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase
    .from('flight_search_usage_events')
    .update({
      outcome: input.outcome,
      http_status: input.httpStatus,
      error_code: input.errorCode?.slice(0, 80) ?? null,
      itinerary_count: input.itineraryCount ?? null,
      partial: input.partial ?? null,
      total_ms: input.totalMs == null ? null : Math.max(0, Math.round(input.totalMs)),
      supplier_ms: input.supplierMs == null
        ? null
        : Math.max(0, Math.round(input.supplierMs)),
      completed_at: new Date().toISOString(),
    })
    .eq('id', input.eventId);
  if (error && !usageTableMissing(error)) {
    console.error('[flight-search-usage] event finish failed:', error.message);
  }
}

export async function readFlightSearchUsageReport(input: {
  from: string;
  to: string;
}): Promise<FlightSearchUsageReport> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return { available: false, totals: EMPTY_TOTALS, users: [], suppliers: [] };
  }
  const params = { p_from: input.from, p_to: input.to };
  const [totalsResult, usersResult, suppliersResult] = await Promise.all([
    supabase.rpc('flight_search_usage_totals_v1', params),
    supabase.rpc('flight_search_usage_by_actor_v2', params),
    supabase.rpc('flight_search_usage_by_supplier_v1', params),
  ]);
  const error = totalsResult.error ?? usersResult.error ?? suppliersResult.error;
  if (error) {
    if (!usageTableMissing(error)) {
      console.error('[flight-search-usage] report read failed:', error.message);
    }
    return { available: false, totals: EMPTY_TOTALS, users: [], suppliers: [] };
  }
  const totalsRow = (Array.isArray(totalsResult.data)
    ? totalsResult.data[0]
    : totalsResult.data) as Record<string, unknown> | null;
  const totals: FlightSearchUsageTotals = totalsRow
    ? {
        requestCount: integer(totalsRow.request_count),
        supplierApiHitCount: integer(totalsRow.supplier_api_hit_count),
        successCount: integer(totalsRow.success_count),
        failedCount: integer(totalsRow.failed_count),
        blockedCount: integer(totalsRow.blocked_count),
        anonymousCount: integer(totalsRow.anonymous_count),
        uniqueUserCount: integer(totalsRow.unique_user_count),
        averageTotalMs: nullableInteger(totalsRow.average_total_ms),
      }
    : EMPTY_TOTALS;
  const users = ((usersResult.data ?? []) as Record<string, unknown>[]).map(
    (row): FlightSearchUserUsage => ({
      userId: text(row.user_id),
      displayName: text(row.display_name),
      email: text(row.email),
      role: text(row.role),
      agencyCode: text(row.agency_code),
      agencyName: text(row.agency_name),
      searchedRoutes: routeUsage(row.searched_routes),
      distinctRouteCount: integer(row.distinct_route_count),
      requestCount: integer(row.request_count),
      supplierApiHitCount: integer(row.supplier_api_hit_count),
      successCount: integer(row.success_count),
      failedCount: integer(row.failed_count),
      blockedCount: integer(row.blocked_count),
      lastSearchAt: text(row.last_search_at),
      averageTotalMs: nullableInteger(row.average_total_ms),
      searchEnabled: row.search_enabled !== false,
      dailyLimit: nullableInteger(row.daily_limit),
      controlVersion: integer(row.control_version),
      todayHitCount: integer(row.today_hit_count),
    })
  );
  const suppliers = ((suppliersResult.data ?? []) as Record<string, unknown>[])
    .flatMap((row): FlightSearchSupplierUsage[] => {
      const supplier = text(row.supplier);
      if (!isFlightReadSupplier(supplier)) return [];
      return [{
        supplier,
        requestCount: integer(row.request_count),
        supplierApiHitCount: integer(row.supplier_api_hit_count),
        successCount: integer(row.success_count),
        failedCount: integer(row.failed_count),
        blockedCount: integer(row.blocked_count),
        lastSearchAt: text(row.last_search_at),
        dailyLimit: nullableInteger(row.daily_limit),
        limitVersion: integer(row.limit_version),
        todayHitCount: integer(row.today_hit_count),
      }];
    });
  return { available: true, totals, users, suppliers };
}

export async function saveFlightSearchSupplierLimit(input: {
  supplier: FlightReadSupplier;
  dailyLimit: number | null;
  expectedVersion: number;
  actorUserId: string;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('flight_search_supplier_limits')
    .update({
      daily_limit: input.dailyLimit,
      version: input.expectedVersion + 1,
      updated_by_user_id: input.actorUserId,
      updated_at: new Date().toISOString(),
    })
    .eq('supplier', input.supplier)
    .eq('version', input.expectedVersion)
    .select('supplier')
    .maybeSingle();
  if (error) console.error('[flight-search-usage] supplier limit save failed:', error.message);
  return !error && Boolean(data);
}

export async function saveFlightSearchUserControl(input: {
  userId: string;
  searchEnabled: boolean;
  dailyLimit: number | null;
  expectedVersion: number;
  actorUserId: string;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  if (input.expectedVersion === 0) {
    const { error } = await supabase.from('flight_search_user_controls').insert({
      user_id: input.userId,
      search_enabled: input.searchEnabled,
      daily_limit: input.dailyLimit,
      version: 1,
      updated_by_user_id: input.actorUserId,
    });
    if (error) console.error('[flight-search-usage] user control insert failed:', error.message);
    return !error;
  }
  const { data, error } = await supabase
    .from('flight_search_user_controls')
    .update({
      search_enabled: input.searchEnabled,
      daily_limit: input.dailyLimit,
      version: input.expectedVersion + 1,
      updated_by_user_id: input.actorUserId,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', input.userId)
    .eq('version', input.expectedVersion)
    .select('user_id')
    .maybeSingle();
  if (error) console.error('[flight-search-usage] user control save failed:', error.message);
  return !error && Boolean(data);
}
