'use server';

import { revalidatePath } from 'next/cache';

import { getDashboardSession } from '@/lib/dashboard/session';
import { dashboardFeatureEnabled } from '@/lib/dashboard/features';
import {
  saveFlightSearchSupplierLimit,
  saveFlightSearchUserControl,
} from '@/lib/db/flight-search-usage';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { isFlightReadSupplier } from '@/lib/flights/supplier';

export type SearchControlActionResult = { ok: boolean; message: string };

function limit(
  value: number | null,
  minimum = 1
): number | null | undefined {
  if (value === null) return null;
  return Number.isInteger(value) && value >= minimum && value <= 1_000_000
    ? value
    : undefined;
}

async function superAdmin() {
  if (!dashboardFeatureEnabled('search-control')) {
    return { denied: 'Search Control is currently disabled.' };
  }
  const session = await getDashboardSession();
  if (session?.role !== 'superadmin') return null;
  const allowed = await checkActionLimit('manageFlightSearchControls', session.clerkId);
  return allowed.ok
    ? { session }
    : { denied: rateLimitMessage(allowed.retryAfterSeconds) };
}

export async function saveSupplierSearchLimitAction(input: {
  supplier: string;
  dailyLimit: number | null;
  expectedVersion: number;
}): Promise<SearchControlActionResult> {
  const access = await superAdmin();
  if (!access) return { ok: false, message: 'Only a Super Admin can change search limits.' };
  if ('denied' in access) {
    return { ok: false, message: access.denied ?? 'Too many control changes. Try again later.' };
  }
  const parsedLimit = limit(input.dailyLimit, 0);
  if (!isFlightReadSupplier(input.supplier) || parsedLimit === undefined ||
      !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { ok: false, message: 'Check the supplier daily limit.' };
  }
  const metadata = {
    supplier: input.supplier,
    dailyLimit: parsedLimit,
    expectedVersion: input.expectedVersion,
  };
  const audited = await recordSecurityAuditEvent({
    actorUserId: access.session.clerkId,
    actorRole: access.session.role,
    action: 'flight_search.supplier_limit.saved',
    targetType: 'flight_search_supplier',
    targetId: input.supplier,
    outcome: 'attempted',
    metadata,
  });
  if (!audited) {
    return { ok: false, message: 'The audit trail is unavailable, so nothing changed.' };
  }
  const saved = await saveFlightSearchSupplierLimit({
    supplier: input.supplier,
    dailyLimit: parsedLimit,
    expectedVersion: input.expectedVersion,
    actorUserId: access.session.clerkId,
  });
  await recordSecurityAuditEvent({
    actorUserId: access.session.clerkId,
    actorRole: access.session.role,
    action: 'flight_search.supplier_limit.saved',
    targetType: 'flight_search_supplier',
    targetId: input.supplier,
    outcome: saved ? 'succeeded' : 'failed',
    metadata,
  });
  if (!saved) {
    return { ok: false, message: 'The limit changed elsewhere. Refresh and try again.' };
  }
  revalidatePath('/dashboard/search-control');
  return { ok: true, message: 'Supplier daily API limit saved.' };
}

export async function saveUserSearchControlAction(input: {
  userId: string;
  searchEnabled: boolean;
  dailyLimit: number | null;
  expectedVersion: number;
}): Promise<SearchControlActionResult> {
  const access = await superAdmin();
  if (!access) return { ok: false, message: 'Only a Super Admin can change user search access.' };
  if ('denied' in access) {
    return { ok: false, message: access.denied ?? 'Too many control changes. Try again later.' };
  }
  const parsedLimit = limit(input.dailyLimit);
  if (!/^user_[A-Za-z0-9_-]{3,250}$/.test(input.userId) ||
      typeof input.searchEnabled !== 'boolean' || parsedLimit === undefined ||
      !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return { ok: false, message: 'Check the user search control values.' };
  }
  const metadata = {
    searchEnabled: input.searchEnabled,
    dailyLimit: parsedLimit,
    expectedVersion: input.expectedVersion,
  };
  const audited = await recordSecurityAuditEvent({
    actorUserId: access.session.clerkId,
    actorRole: access.session.role,
    action: 'flight_search.user_control.saved',
    targetType: 'app_user',
    targetId: input.userId,
    outcome: 'attempted',
    metadata,
  });
  if (!audited) {
    return { ok: false, message: 'The audit trail is unavailable, so nothing changed.' };
  }
  const saved = await saveFlightSearchUserControl({
    userId: input.userId,
    searchEnabled: input.searchEnabled,
    dailyLimit: parsedLimit,
    expectedVersion: input.expectedVersion,
    actorUserId: access.session.clerkId,
  });
  await recordSecurityAuditEvent({
    actorUserId: access.session.clerkId,
    actorRole: access.session.role,
    action: 'flight_search.user_control.saved',
    targetType: 'app_user',
    targetId: input.userId,
    outcome: saved ? 'succeeded' : 'failed',
    metadata,
  });
  if (!saved) {
    return { ok: false, message: 'The user control changed elsewhere. Refresh and try again.' };
  }
  revalidatePath('/dashboard/search-control');
  return { ok: true, message: 'User flight-search control saved.' };
}
