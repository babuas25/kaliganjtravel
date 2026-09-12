import 'server-only';

import {
  type MarkupRule,
  type MarkupRuleInput,
  type PricingAudience,
} from '@/lib/markup';
import { supabaseAdmin } from '@/lib/supabase/server';

const TABLE = 'markup_rules';
const DUPLICATE = '23505';

type RuleRow = {
  id: string;
  audience: 'b2c' | 'b2b' | 'agency';
  agency_code: string | null;
  airline_code: string | null;
  origin: string | null;
  destination: string | null;
  bidirectional: boolean;
  markup_type: 'fixed' | 'percentage' | 'margin_share';
  value: number | string;
  lcc_service_margin: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type MarkupRulesResult =
  | { ok: true; rules: MarkupRule[] }
  | { ok: false; rules: [] };

export type MarkupMutationResult = {
  ok: boolean;
  message: string;
};

function toRule(row: RuleRow): MarkupRule {
  return {
    id: row.id,
    audience: row.audience,
    agencyCode: row.agency_code,
    airlineCode: row.airline_code,
    origin: row.origin,
    destination: row.destination,
    bidirectional: row.bidirectional,
    markupType: row.markup_type,
    value: Number(row.value),
    lccServiceMargin: row.lcc_service_margin,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT =
  'id, audience, agency_code, airline_code, origin, destination, bidirectional, markup_type, value, lcc_service_margin, active, created_at, updated_at';

export async function listMarkupRules(): Promise<MarkupRulesResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, rules: [] };

  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT)
    .order('active', { ascending: false })
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[db] listMarkupRules failed:', error.message);
    return { ok: false, rules: [] };
  }

  return { ok: true, rules: ((data ?? []) as RuleRow[]).map(toRule) };
}

/**
 * Only the current pricing audience's active rules. Called beside the slow
 * supplier request, so one search performs one bounded database read rather
 * than querying once per offer.
 */
export async function activeMarkupRulesFor(
  audience: PricingAudience
): Promise<MarkupRulesResult> {
  // Super Admin searches are an audit view of supplier payable, so they do not
  // read or apply commercial markup rules.
  if (audience.kind === 'superadmin') return { ok: true, rules: [] };

  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, rules: [] };

  let query = supabase
    .from(TABLE)
    .select(SELECT)
    .eq('active', true);

  query =
    audience.kind === 'agency'
      ? query
          .in('audience', ['agency', 'b2b'])
          .or(
            `agency_code.eq.${audience.agencyCode},agency_code.is.null`
          )
      : query.eq('audience', 'b2c').is('agency_code', null);

  const { data, error } = await query.order('updated_at', {
    ascending: false,
  });

  if (error) {
    console.error('[db] activeMarkupRulesFor failed:', error.message);
    return { ok: false, rules: [] };
  }

  return { ok: true, rules: ((data ?? []) as RuleRow[]).map(toRule) };
}

function rowFor(input: MarkupRuleInput, actorId: string) {
  return {
    audience: input.audience,
    agency_code: input.agencyCode,
    airline_code: input.airlineCode,
    origin: input.origin,
    destination: input.destination,
    bidirectional: input.bidirectional,
    markup_type: input.markupType,
    value: input.value,
    lcc_service_margin: input.lccServiceMargin,
    active: input.active,
    created_by: actorId,
  };
}

export async function saveMarkupRule(
  id: string | null,
  input: MarkupRuleInput,
  actorId: string
): Promise<MarkupMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'Pricing-rule storage is not configured in this environment.',
    };
  }

  const values = rowFor(input, actorId);
  const response = id
    ? await supabase.from(TABLE).update(values).eq('id', id).select('id').maybeSingle()
    : await supabase.from(TABLE).insert(values).select('id').single();

  if (response.error) {
    if (response.error.code === DUPLICATE) {
      return {
        ok: false,
        message:
          'A pricing rule already exists or overlaps this audience, airline, and route. Edit the existing rule instead.',
      };
    }
    console.error('[db] saveMarkupRule failed:', response.error.message);
    return { ok: false, message: 'The pricing rule could not be saved.' };
  }

  if (!response.data) {
    return { ok: false, message: 'That pricing rule no longer exists.' };
  }

  return {
    ok: true,
    message: id ? 'Pricing rule updated.' : 'Pricing rule created.',
  };
}

export async function setMarkupRuleActive(
  id: string,
  active: boolean
): Promise<MarkupMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'Pricing-rule storage is not configured in this environment.',
    };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ active })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[db] setMarkupRuleActive failed:', error.message);
    return { ok: false, message: 'The pricing rule could not be updated.' };
  }
  if (!data) return { ok: false, message: 'That pricing rule no longer exists.' };

  return {
    ok: true,
    message: active ? 'Pricing rule enabled.' : 'Pricing rule paused.',
  };
}

export async function removeMarkupRule(
  id: string
): Promise<MarkupMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'Pricing-rule storage is not configured in this environment.',
    };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[db] removeMarkupRule failed:', error.message);
    return { ok: false, message: 'The pricing rule could not be deleted.' };
  }
  if (!data) return { ok: false, message: 'That pricing rule no longer exists.' };

  return { ok: true, message: 'Pricing rule deleted.' };
}
