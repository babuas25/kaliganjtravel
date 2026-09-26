'use server';

import { revalidatePath } from 'next/cache';

import {
  saveSupplierOperationalControls,
  type SupplierOperationalControls,
} from '@/lib/db/supplier-controls';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import {
  isTriploverConfigured,
} from '@/lib/triplover/config';
import { isFlightReadSupplier } from '@/lib/flights/supplier';
import { isShapontravelsConfigured } from '@/lib/shapontravels/client';

export type SupplierControlActionResult = {
  ok: boolean;
  message: string;
  controls?: SupplierOperationalControls;
};

export async function saveSupplierControlAction(input: {
  activeSupplier: string;
  bookingEnabled: boolean;
  ticketingEnabled: boolean;
  expectedVersion: number;
}): Promise<SupplierControlActionResult> {
  const session = await getDashboardSession();
  if (session?.role !== 'superadmin') {
    return { ok: false, message: 'Only a Super Admin can change supplier controls.' };
  }
  if (!isFlightReadSupplier(input.activeSupplier)) {
    return { ok: false, message: 'Choose a supported supplier.' };
  }
  if (
    typeof input.bookingEnabled !== 'boolean' ||
    typeof input.ticketingEnabled !== 'boolean' ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    return { ok: false, message: 'The supplier-control form is invalid.' };
  }
  if (input.ticketingEnabled && !input.bookingEnabled) {
    return {
      ok: false,
      message: 'Ticketing cannot be enabled while booking is disabled.',
    };
  }
  if (input.activeSupplier === 'shapontravels' && input.ticketingEnabled) {
    return { ok: false, message: 'Shapontravels ticketing is not available yet.' };
  }
  if (input.activeSupplier === 'shapontravels' ? !isShapontravelsConfigured() : !isTriploverConfigured(input.activeSupplier)) {
    const supplierLabel = {
      firsttrip: 'FirstTrip',
      takeoff: 'TakeOff',
      triplover: 'Triplover',
      shapontravels: 'Shapontravels',
    }[input.activeSupplier];
    return {
      ok: false,
      message: `${supplierLabel} credentials and URLs are not configured on this server.`,
    };
  }

  const limit = await checkActionLimit('manageSupplierControls', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const metadata = {
    activeSupplier: input.activeSupplier,
    bookingEnabled: input.bookingEnabled,
    ticketingEnabled: input.ticketingEnabled,
    expectedVersion: input.expectedVersion,
  };
  const audited = await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'supplier_controls.saved',
    targetType: 'supplier_operational_settings',
    targetId: 'triplover',
    outcome: 'attempted',
    metadata,
  });
  if (!audited) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  const result = await saveSupplierOperationalControls({
    activeSupplier: input.activeSupplier,
    bookingEnabled: input.bookingEnabled,
    ticketingEnabled: input.ticketingEnabled,
    expectedVersion: input.expectedVersion,
  });
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'supplier_controls.saved',
    targetType: 'supplier_operational_settings',
    targetId: 'triplover',
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      ...metadata,
      ...(result.ok ? { version: result.controls.version } : { reason: result.message }),
    },
  });
  if (result.ok) {
    revalidatePath('/dashboard/supplier-control');
    return { ok: true, message: 'Supplier controls saved.', controls: result.controls };
  }
  return result;
}
