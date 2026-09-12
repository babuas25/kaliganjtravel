'use server';

import { revalidatePath } from 'next/cache';

import {
  removeMarkupRule,
  saveMarkupRule,
  setMarkupRuleActive,
} from '@/lib/db/markup-rules';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import {
  type MarkupRuleInput,
  validateMarkupRuleInput,
} from '@/lib/markup';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';

export type MarkupActionResult = { ok: boolean; message: string };

const DENIED: MarkupActionResult = {
  ok: false,
  message: 'Only a Super Admin can manage fare pricing rules.',
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireSuperadmin() {
  const session = await getDashboardSession();
  return session?.role === 'superadmin' ? session : null;
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

function refreshMarkup() {
  revalidatePath('/dashboard/markup');
}

async function auditMarkup(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  id: string | null,
  outcome: 'attempted' | 'succeeded' | 'failed',
  metadata: Record<string, unknown> = {}
): Promise<boolean> {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'markup_rule',
    targetId: id,
    outcome,
    metadata,
  });
}

const AUDIT_UNAVAILABLE: MarkupActionResult = {
  ok: false,
  message: 'The security audit trail is unavailable, so nothing was changed.',
};

export async function saveMarkupRuleAction(
  id: string | null,
  input: MarkupRuleInput
): Promise<MarkupActionResult> {
  const session = await requireSuperadmin();
  if (!session) return DENIED;
  if (id !== null && !validId(id)) {
    return { ok: false, message: 'That pricing rule is invalid.' };
  }

  const limit = await checkActionLimit('manageMarkup', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const parsed = validateMarkupRuleInput(input);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (!(await auditMarkup(session, 'markup.saved', id, 'attempted'))) {
    return AUDIT_UNAVAILABLE;
  }

  const result = await saveMarkupRule(id, parsed.value, session.clerkId);
  await auditMarkup(
    session,
    'markup.saved',
    id,
    result.ok ? 'succeeded' : 'failed',
    { audience: parsed.value.audience, agencyCode: parsed.value.agencyCode }
  );
  if (result.ok) refreshMarkup();
  return result;
}

export async function setMarkupRuleActiveAction(
  id: string,
  active: boolean
): Promise<MarkupActionResult> {
  const session = await requireSuperadmin();
  if (!session) return DENIED;
  if (!validId(id)) {
    return { ok: false, message: 'That pricing rule is invalid.' };
  }

  const limit = await checkActionLimit('manageMarkup', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (
    !(await auditMarkup(session, 'markup.activation_changed', id, 'attempted', {
      active: active === true,
    }))
  ) {
    return AUDIT_UNAVAILABLE;
  }

  const result = await setMarkupRuleActive(id, active === true);
  await auditMarkup(
    session,
    'markup.activation_changed',
    id,
    result.ok ? 'succeeded' : 'failed',
    { active: active === true }
  );
  if (result.ok) refreshMarkup();
  return result;
}

export async function removeMarkupRuleAction(
  id: string
): Promise<MarkupActionResult> {
  const session = await requireSuperadmin();
  if (!session) return DENIED;
  if (!validId(id)) {
    return { ok: false, message: 'That pricing rule is invalid.' };
  }

  const limit = await checkActionLimit('manageMarkup', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (!(await auditMarkup(session, 'markup.removed', id, 'attempted'))) {
    return AUDIT_UNAVAILABLE;
  }

  const result = await removeMarkupRule(id);
  await auditMarkup(
    session,
    'markup.removed',
    id,
    result.ok ? 'succeeded' : 'failed'
  );
  if (result.ok) refreshMarkup();
  return result;
}
