/**
 * One-time: show which live pricing scopes change when the engine moves from
 * "one winning rule" to "base rule + one adjustment rule".
 *
 *   node scripts/audit-markup-composition.mjs
 *
 * Read-only. It never writes to `markup_rules`.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
 * environment (or .env.local, which it parses itself — this runs outside Next,
 * so nothing loads that file for it).
 *
 * Three configurations reprice:
 *
 *   1. An audience holding both an all-airlines/all-routes rule and a scoped
 *      rule. Before, the scoped rule replaced the global one. Now the global
 *      one prices the fare and the scoped one adjusts that result.
 *   2. Any *percentage* rule. Before, it was a percentage of the base fare.
 *      Now it is a percentage of the running selling price — the supplier
 *      payable at stage one, the stage one result at stage two.
 *   3. An agency that owns an all-airlines/all-routes rule now also receives
 *      scoped all-B2B rules, which its own rule used to shadow entirely.
 *
 * The arithmetic is duplicated from `lib/markup.ts` rather than imported: that
 * file is TypeScript behind the app's module aliases, and a throwaway audit is
 * not worth a build step. It is checked against the real engine by the numbers
 * in MARKUP.md §9. Delete this script once the deltas have been approved.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/** Sample fares. Tax share matters, so audit a light and a heavy one. */
const FARES = [
  { label: 'domestic  (base 4,800 / tax 1,200)', basePrice: 4800, taxes: 1200 },
  { label: 'long-haul (base 4,800 / tax 6,000)', basePrice: 4800, taxes: 6000 },
];

/** Supplier payable as a share of gross — a typical commissionable fare. */
const SUPPLIER_SHARE = 0.93;

/** Minimal .env.local reader — enough for KEY=value, ignoring comments. */
function loadEnvLocal() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    'Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.'
  );
  process.exit(1);
}

/* ── Pricing arithmetic, in integer minor units ────────────────────────── */

const toMinor = (amount) => Math.round(amount * 100);
const fromMinor = (amount) => Math.round(amount) / 100;

function requestedMinor(rule, basisMinor, passengerCount) {
  if (rule.markup_type === 'fixed') {
    return toMinor(Number(rule.value)) * Math.max(1, passengerCount);
  }
  return Math.round((basisMinor * Math.round(Number(rule.value) * 100)) / 10_000);
}

function basisMinor(rule, priceMinor, availableMarginMinor) {
  if (rule.markup_type === 'fixed') return 0;
  return rule.markup_type === 'margin_share' ? availableMarginMinor : priceMinor;
}

function fareMinors({ basePrice, taxes }) {
  const baseMinor = toMinor(basePrice);
  const taxesMinor = toMinor(taxes);
  const grossMinor = baseMinor + taxesMinor;
  const supplierMinor = Math.round(grossMinor * SUPPLIER_SHARE);
  return {
    baseMinor,
    taxesMinor,
    grossMinor,
    supplierMinor,
    safeGrossMinor: Math.max(grossMinor, supplierMinor),
    availableMarginMinor: Math.max(0, grossMinor - supplierMinor),
    minimumSellingMinor: taxesMinor,
  };
}

/** The engine as it was: one winning rule, one clamp. */
function sellingBefore(rule, fare) {
  const f = fareMinors(fare);
  if (!rule) return fromMinor(f.supplierMinor);
  if (rule.lcc_service_margin) {
    return fromMinor(
      f.safeGrossMinor +
        requestedMinor(rule, basisMinor(rule, f.baseMinor, f.availableMarginMinor), 1)
    );
  }
  const requested = requestedMinor(
    rule,
    basisMinor(rule, f.baseMinor, f.availableMarginMinor),
    1
  );
  const minimumMarkup = f.minimumSellingMinor - f.supplierMinor;
  const applied = Math.max(
    minimumMarkup,
    Math.min(requested, f.availableMarginMinor)
  );
  return fromMinor(f.supplierMinor + applied);
}

/** The engine now: base stage, then adjustment stage, clamped after each. */
function sellingAfter(base, adjustment, fare) {
  const f = fareMinors(fare);
  const clamp = (value) =>
    Math.max(f.minimumSellingMinor, Math.min(value, f.safeGrossMinor));

  const lcc =
    adjustment?.lcc_service_margin === true
      ? adjustment
      : base?.lcc_service_margin === true
        ? base
        : null;
  if (lcc) {
    return fromMinor(
      f.safeGrossMinor +
        requestedMinor(lcc, basisMinor(lcc, f.baseMinor, f.availableMarginMinor), 1)
    );
  }

  let running = f.supplierMinor;
  if (base) {
    // `running` is still the supplier payable here — the stage 1 percentage
    // basis.
    running = clamp(
      running +
        requestedMinor(base, basisMinor(base, running, f.availableMarginMinor), 1)
    );
  }
  if (adjustment) {
    running = clamp(
      running +
        requestedMinor(
          adjustment,
          basisMinor(adjustment, running, f.availableMarginMinor),
          1
        )
    );
  }
  return fromMinor(running);
}

/* ── Report ────────────────────────────────────────────────────────────── */

const money = (value) =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const isBaseScope = (rule) => rule.airline_code === null && !rule.origin;

function scopeLabel(rule) {
  const route =
    rule.origin && rule.destination
      ? `${rule.origin} ${rule.bidirectional ? '<->' : '->'} ${rule.destination}`
      : 'all routes';
  return `${rule.airline_code ?? 'all airlines'} / ${route}`;
}

function valueLabel(rule) {
  const value = Number(rule.value);
  if (rule.markup_type === 'fixed') return `${value >= 0 ? '+' : ''}${value} BDT`;
  if (rule.markup_type === 'margin_share') return `${value}% of margin`;
  return `${value >= 0 ? '+' : ''}${value}%`;
}

function audienceKey(rule) {
  return rule.audience === 'agency'
    ? `agency:${rule.agency_code}`
    : rule.audience;
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from('markup_rules')
  .select(
    'id, audience, agency_code, airline_code, origin, destination, bidirectional, markup_type, value, lcc_service_margin, active, updated_at'
  )
  .eq('active', true)
  .order('updated_at', { ascending: false });

if (error) {
  console.error(`Could not read markup_rules: ${error.message}`);
  process.exit(1);
}

const rules = data ?? [];
console.log(`${rules.length} active rule(s).\n`);

/**
 * Audience buckets. An agency also inherits the all-B2B rules, so its bucket
 * carries both — matching how `selectMarkupRules()` resolves each stage.
 */
const buckets = new Map();
for (const rule of rules) {
  const key = audienceKey(rule);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(rule);
}
for (const [key, bucket] of buckets) {
  if (!key.startsWith('agency:')) continue;
  bucket.push(...(buckets.get('b2b') ?? []));
}

let changed = 0;

for (const [key, bucket] of buckets) {
  const base =
    bucket.find((rule) => isBaseScope(rule) && audienceKey(rule) === key) ??
    bucket.find((rule) => isBaseScope(rule)) ??
    null;
  const scoped = bucket.filter((rule) => !isBaseScope(rule));

  for (const adjustment of scoped) {
    const rows = FARES.map((fare) => {
      const before = sellingBefore(adjustment, fare);
      const after = sellingAfter(base, adjustment, fare);
      return { fare, before, after, delta: after - before };
    });
    if (rows.every((row) => Math.abs(row.delta) < 0.005)) continue;

    changed += 1;
    console.log(`${key}  ·  ${scopeLabel(adjustment)}  ·  ${valueLabel(adjustment)}`);
    console.log(
      `  base stage: ${base ? valueLabel(base) : 'none — lone rule, percentage basis moves to the running price'}`
    );
    for (const row of rows) {
      const sign = row.delta > 0 ? '+' : '';
      console.log(
        `    ${row.fare.label}   ${money(row.before)}  ->  ${money(row.after)}   (${sign}${money(row.delta)})`
      );
    }
    console.log('');
  }
}

console.log(
  changed === 0
    ? 'No live scope changes price under two-stage pricing.'
    : `${changed} scope(s) change price. Approve these before deploying.`
);
