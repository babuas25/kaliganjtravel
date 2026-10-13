import 'server-only';

import type { TriploverSupplierStatusFacts } from '@/lib/triplover/supplier-status';
import { supabaseAdmin } from '@/lib/supabase/server';

export type TriploverStatusActor = { clerkId: string; role: 'admin' | 'superadmin' };
export type TriploverStatusCheck = TriploverSupplierStatusFacts & {
  checkId: string;
  checkedAt: string;
  expiresAt: string;
};
export type TriploverIssuedHoldPreview = {
  ok: boolean;
  eligible: boolean;
  code?: string;
  checkId?: string;
  previewHash?: string;
  walletEffect?: 'capture_hold';
  amount?: number;
  currency?: string;
  availableBefore?: number;
  availableAfter?: number;
  holdBefore?: number;
  holdAfter?: number;
};

async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const admin = supabaseAdmin();
  if (!admin) throw new Error('Supplier status storage is unavailable.');
  const { data, error } = await admin.rpc(name, args);
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('[triplover-status]', name, error?.code ?? 'INVALID_DATABASE_RESPONSE');
    throw new Error('Supplier status storage is unavailable.');
  }
  return data as Record<string, unknown>;
}

function actorArgs(bookingId: string, actor: TriploverStatusActor) {
  return { p_booking_id: bookingId, p_actor_user_id: actor.clerkId, p_actor_role: actor.role };
}

export function triploverStatusCheckContext(bookingId: string, actor: TriploverStatusActor) {
  return rpc('triplover_status_check_context_v1', actorArgs(bookingId, actor));
}

export async function recordTriploverStatusCheck(bookingId: string, actor: TriploverStatusActor,
  bookingSnapshotHash: string, facts: TriploverSupplierStatusFacts): Promise<TriploverStatusCheck | null> {
  const result = await rpc('record_triplover_status_check_v1', {
    ...actorArgs(bookingId, actor), p_booking_snapshot_hash: bookingSnapshotHash, p_facts: facts,
  });
  if (result.ok !== true || typeof result.checkId !== 'string' || typeof result.checkedAt !== 'string' ||
      typeof result.expiresAt !== 'string') return null;
  return { ...facts, checkId: result.checkId, checkedAt: result.checkedAt, expiresAt: result.expiresAt };
}

export async function previewTriploverIssuedHold(bookingId: string, actor: TriploverStatusActor,
  checkId: string): Promise<TriploverIssuedHoldPreview> {
  const result = await rpc('preview_triplover_issued_hold_confirmation_v1', { ...actorArgs(bookingId, actor), p_check_id: checkId });
  // Keep internal account/reservation/operation identifiers on the server.
  const fields = ['ok', 'eligible', 'code', 'checkId', 'previewHash', 'walletEffect', 'amount', 'currency',
    'availableBefore', 'availableAfter', 'holdBefore', 'holdAfter'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])) as TriploverIssuedHoldPreview;
}

export function confirmTriploverIssuedHold(bookingId: string, actor: TriploverStatusActor,
  input: { checkId: string; previewHash: string; requestId: string }) {
  return rpc('confirm_triplover_issued_hold_v1', {
    ...actorArgs(bookingId, actor), p_check_id: input.checkId, p_preview_hash: input.previewHash,
    p_request_key: `triplover-issued-hold:v1:${input.requestId}`, p_money_movement_confirmed: true,
  });
}

/** A verified issued result remains a stop signal even after confirmation proof expires. */
export async function hasVerifiedTriploverIssuedStatus(bookingId: string): Promise<boolean> {
  const admin = supabaseAdmin();
  if (!admin) throw new Error('Supplier status storage is unavailable.');
  const { data, error } = await admin.from('triplover_booking_status_checks')
    .select('facts').eq('booking_id', bookingId).eq('facts->>verified', 'true')
    .eq('facts->>verifiedStatus', 'issued').limit(1).maybeSingle();
  if (error) throw new Error('Supplier status storage is unavailable.');
  return data?.facts?.verified === true && data.facts.verifiedStatus === 'issued';
}
