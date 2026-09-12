import 'server-only';

import { createHash, randomUUID } from 'crypto';

import type { Role } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';

export type SecurityAuditEvent = {
  actorUserId: string;
  actorRole: Role;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome?: 'attempted' | 'succeeded' | 'failed' | 'denied';
  metadata?: Record<string, unknown>;
};

/** Appends a PII-minimised privileged-operation record. */
export async function recordSecurityAuditEvent(
  event: SecurityAuditEvent
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    console.error('[security] audit event could not be stored: Supabase unavailable');
    return false;
  }

  const { error } = await supabase.from('security_audit_events').insert({
    actor_user_id: event.actorUserId,
    actor_role: event.actorRole,
    action: event.action.slice(0, 100),
    target_type: event.targetType.slice(0, 50),
    target_id: event.targetId?.slice(0, 512) ?? null,
    outcome: event.outcome ?? 'succeeded',
    metadata: event.metadata ?? {},
  });
  if (error) {
    console.error('[security] audit event write failed:', error.message);
    return false;
  }
  return true;
}

export type SecurityLock = { name: string; holder: string };

/** Stable audit subject without storing an email address in the event table. */
export function securitySubjectHash(value: string): string {
  return `sha256:${createHash('sha256')
    .update(value.trim().toLowerCase(), 'utf8')
    .digest('hex')}`;
}

/** Acquires a short cross-instance lease, or null while another write owns it. */
export async function acquireSecurityLock(
  name: string,
  leaseSeconds = 60
): Promise<SecurityLock | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;

  const holder = randomUUID();
  const { data, error } = await supabase.rpc('try_acquire_security_lock', {
    p_name: name,
    p_holder: holder,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    console.error('[security] operation lock failed:', error.message);
    return null;
  }
  return data === true ? { name, holder } : null;
}

/** Releases only the lease token acquired by this operation. */
export async function releaseSecurityLock(lock: SecurityLock): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('release_security_lock', {
    p_name: lock.name,
    p_holder: lock.holder,
  });
  if (error) console.error('[security] operation lock release failed:', error.message);
}
