import type { FareBreakdown, SearchRoute } from '@/lib/flights/types';
import { isAgencyCode } from '@/lib/agency';
import type { Role } from '@/lib/roles';

export const MARKUP_AUDIENCES = ['b2c', 'b2b', 'agency'] as const;
export type MarkupAudience = (typeof MARKUP_AUDIENCES)[number];

export const MARKUP_TYPES = ['fixed', 'percentage', 'margin_share'] as const;
export type MarkupType = (typeof MARKUP_TYPES)[number];

export type MarkupRule = {
  id: string;
  audience: MarkupAudience;
  agencyCode: string | null;
  /** Null targets every airline, optionally limited to one route. */
  airlineCode: string | null;
  origin: string | null;
  destination: string | null;
  bidirectional: boolean;
  markupType: MarkupType;
  value: number;
  lccServiceMargin: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MarkupRuleInput = {
  audience: MarkupAudience;
  agencyCode: string | null;
  /** Null targets every airline, optionally limited to one route. */
  airlineCode: string | null;
  origin: string | null;
  destination: string | null;
  bidirectional: boolean;
  markupType: MarkupType;
  value: number;
  lccServiceMargin: boolean;
  active: boolean;
};

export type PricingAudience =
  | { kind: 'b2c' }
  | { kind: 'agency'; agencyCode: string }
  | { kind: 'superadmin' };

export const B2C_PRICING_AUDIENCE: PricingAudience = { kind: 'b2c' };
export const SUPERADMIN_PRICING_AUDIENCE: PricingAudience = {
  kind: 'superadmin',
};

/**
 * Pricing identity is derived only from the verified server session. A Super
 * Admin sees the supplier payable amount for fare auditing; every other role
 * remains in the configured B2C or agency markup flow.
 */
export function pricingAudienceForRole(
  role: Role | null,
  agencyCode: string | null
): PricingAudience {
  if (role === 'superadmin') return SUPERADMIN_PRICING_AUDIENCE;
  if (
    agencyCode &&
    isAgencyCode(agencyCode) &&
    (role === 'b2b' || role === 'b2b_sub')
  ) {
    return { kind: 'agency', agencyCode };
  }
  return B2C_PRICING_AUDIENCE;
}

export type SupplierFarePricing = {
  passengerType: FareBreakdown['passengerType'];
  count: number;
  basePrice: number;
  taxes: number;
  ait: number;
  serviceCharge: number;
  supplierTotalPrice: number;
};

/**
 * One stage of the two-stage calculation, stored so any selling price can be
 * reconstructed from the snapshot alone.
 */
export type PricingComponent = {
  stage: 'base' | 'adjustment';
  ruleId: string;
  markupType: MarkupType;
  markupValue: number;
  /** Money the percentage was taken from; 0 for a fixed per-passenger rule. */
  basisAmount: number;
  requestedAmount: number;
  sellingBefore: number;
  sellingAfter: number;
};

export type PricingSnapshot = {
  audience: PricingAudience['kind'];
  agencyCode: string | null;
  basis: 'gross' | 'supplier' | 'lcc_service';
  supplierTotalPrice: number;
  grossPrice: number;
  availableMargin: number;
  requestedMarkupAmount: number;
  markupAmount: number;
  serviceMarginAmount: number;
  sellingPrice: number;
  grossCapApplied: boolean;
  /** True when a discount was limited so taxes and AIT remain payable. */
  discountFloorApplied: boolean;
  lccServiceMargin: boolean;
  ruleId: string | null;
  markupType: MarkupType | null;
  markupValue: number | null;
  /** Absent on snapshots written before two-stage pricing. */
  components?: PricingComponent[];
};

export type PricedOffer = {
  totalPrice: number;
  basePrice: number;
  taxes: number;
  ait: number;
  serviceMargin: number;
  fares: FareBreakdown[];
  snapshot: PricingSnapshot;
};

const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const AIRPORT_CODE = /^[A-Z]{3}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/**
 * The server-side contract for a rule write. Client-side required fields make
 * the form pleasant; this is the check that makes a forged action harmless.
 */
export function validateMarkupRuleInput(
  value: unknown
):
  | { ok: true; value: MarkupRuleInput }
  | { ok: false; message: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'The markup rule is missing.' };
  }

  const raw = value as Record<string, unknown>;
  const audience = raw.audience;
  const markupType = raw.markupType;
  if (
    audience !== 'b2c' &&
    audience !== 'b2b' &&
    audience !== 'agency'
  ) {
    return {
      ok: false,
      message: 'Choose B2C, all B2B users, or a specific agent.',
    };
  }
  if (
    markupType !== 'fixed' &&
    markupType !== 'percentage' &&
    markupType !== 'margin_share'
  ) {
    return {
      ok: false,
      message: 'Choose fixed, base percentage, or margin share.',
    };
  }

  const airlineCode = text(raw.airlineCode) || null;
  if (airlineCode !== null && !AIRLINE_CODE.test(airlineCode)) {
    return { ok: false, message: 'Airline code must be two letters or numbers.' };
  }

  const agencyCode =
    audience === 'agency' && typeof raw.agencyCode === 'string'
      ? raw.agencyCode.trim()
      : null;
  if (audience === 'agency' && !isAgencyCode(agencyCode)) {
    return { ok: false, message: 'Choose the agent this rule belongs to.' };
  }

  const origin = text(raw.origin) || null;
  const destination = text(raw.destination) || null;
  if ((origin === null) !== (destination === null)) {
    return { ok: false, message: 'A route needs both origin and destination.' };
  }
  if (
    (origin && !AIRPORT_CODE.test(origin)) ||
    (destination && !AIRPORT_CODE.test(destination))
  ) {
    return { ok: false, message: 'Airport codes must be three letters.' };
  }
  if (origin && origin === destination) {
    return { ok: false, message: 'Route origin and destination must differ.' };
  }
  const amount = Number(raw.value);
  if (!Number.isFinite(amount)) {
    return { ok: false, message: 'Enter a valid markup value.' };
  }
  if (markupType === 'margin_share' && (amount < 0 || amount > 100)) {
    return { ok: false, message: 'Margin share must be from 0% to 100%.' };
  }
  if (markupType !== 'margin_share' && amount === 0) {
    return { ok: false, message: 'Enter a positive markup or negative discount.' };
  }
  if (markupType === 'percentage' && Math.abs(amount) > 100) {
    return {
      ok: false,
      message: 'Percentage must be between -100% and 100%.',
    };
  }
  if (markupType === 'fixed' && Math.abs(amount) > 1_000_000) {
    return {
      ok: false,
      message: 'Fixed amount must be between BDT -1,000,000 and BDT 1,000,000.',
    };
  }
  const lccServiceMargin = raw.lccServiceMargin === true;
  if (lccServiceMargin && amount <= 0) {
    return {
      ok: false,
      message: 'An LCC service margin must be greater than zero.',
    };
  }
  if (airlineCode === null && lccServiceMargin) {
    return {
      ok: false,
      message: 'LCC service-margin rules must target a specific airline.',
    };
  }
  if (lccServiceMargin && markupType === 'margin_share') {
    return {
      ok: false,
      message:
        'LCC service margin must be fixed per passenger or a percentage of base fare.',
    };
  }

  return {
    ok: true,
    value: {
      audience,
      agencyCode,
      airlineCode,
      origin,
      destination,
      bidirectional: Boolean(origin && raw.bidirectional === true),
      markupType,
      value: Math.round(amount * 100) / 100,
      lccServiceMargin,
      active: raw.active !== false,
    },
  };
}

function routeMatchIndex(
  rule: MarkupRule,
  routes: readonly SearchRoute[]
): number | null {
  if (!rule.origin || !rule.destination) return null;

  const direct = routes.findIndex(
    (route) =>
      route.origin === rule.origin && route.destination === rule.destination
  );
  if (direct >= 0) return direct;

  if (!rule.bidirectional) return null;
  const reverse = routes.findIndex(
    (route) =>
      route.origin === rule.destination && route.destination === rule.origin
  );
  return reverse >= 0 ? reverse : null;
}

/**
 * The two rules that price one itinerary. Never more than two: a base rule
 * that prices the supplier fare, and one adjustment rule that modifies that
 * result. Matching rules beyond these two are ignored.
 */
export type MarkupRuleSelection = {
  /** All airlines and all routes. Prices the supplier fare. */
  base: MarkupRule | null;
  /** Agency, airline or route scoped. Adjusts the base stage result. */
  adjustment: MarkupRule | null;
};

export const NO_MARKUP_RULES: MarkupRuleSelection = {
  base: null,
  adjustment: null,
};

function isBaseScope(rule: MarkupRule): boolean {
  return rule.airlineCode === null && !rule.origin;
}

/**
 * Picks at most one rule for each stage. Precedence inside a stage is
 * unchanged: a rule for one agency beats the all-B2B fallback, route
 * specificity beats airline-wide, a named airline beats an all-airlines rule
 * at the same route specificity, an earlier requested leg wins for multicity
 * journeys, and updated time is the deterministic tie-breaker.
 *
 * The stages resolve independently, so an agency keeps its own base margin
 * even when the winning adjustment came from the all-B2B audience.
 */
export function selectMarkupRules(
  rules: readonly MarkupRule[],
  audience: PricingAudience,
  airlineCode: string,
  routes: readonly SearchRoute[]
): MarkupRuleSelection {
  if (audience.kind === 'superadmin') return NO_MARKUP_RULES;

  const candidates = rules.flatMap((rule) => {
    if (
      !rule.active ||
      (rule.airlineCode !== null && rule.airlineCode !== airlineCode)
    ) {
      return [];
    }
    if (audience.kind === 'b2c') {
      if (rule.audience !== 'b2c') return [];
    } else {
      const specificAgency =
        rule.audience === 'agency' &&
        rule.agencyCode === audience.agencyCode;
      if (!specificAgency && rule.audience !== 'b2b') return [];
    }

    if (!rule.origin) return [{ rule, routeIndex: Number.MAX_SAFE_INTEGER }];
    const routeIndex = routeMatchIndex(rule, routes);
    return routeIndex === null ? [] : [{ rule, routeIndex }];
  });

  candidates.sort((a, b) => {
    const aAudienceSpecific = a.rule.audience === 'agency';
    const bAudienceSpecific = b.rule.audience === 'agency';
    if (aAudienceSpecific !== bAudienceSpecific) {
      return aAudienceSpecific ? -1 : 1;
    }
    const aSpecific = a.routeIndex !== Number.MAX_SAFE_INTEGER;
    const bSpecific = b.routeIndex !== Number.MAX_SAFE_INTEGER;
    if (aSpecific !== bSpecific) return aSpecific ? -1 : 1;
    const aAirlineSpecific = a.rule.airlineCode !== null;
    const bAirlineSpecific = b.rule.airlineCode !== null;
    if (aAirlineSpecific !== bAirlineSpecific) {
      return aAirlineSpecific ? -1 : 1;
    }
    if (a.routeIndex !== b.routeIndex) return a.routeIndex - b.routeIndex;
    return b.rule.updatedAt.localeCompare(a.rule.updatedAt);
  });

  return {
    base: candidates.find(({ rule }) => isBaseScope(rule))?.rule ?? null,
    adjustment:
      candidates.find(({ rule }) => !isBaseScope(rule))?.rule ?? null,
  };
}

function toMinor(amount: number): number {
  return Math.round((Number.isFinite(amount) ? amount : 0) * 100);
}

function fromMinor(amount: number): number {
  return Math.round(amount) / 100;
}

function allocateMinor(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeWeights = weights.map((weight) => Math.max(0, weight));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 0) {
    const base = Math.floor(total / weights.length);
    return weights.map((_, index) =>
      index === weights.length - 1
        ? total - base * (weights.length - 1)
        : base
    );
  }

  const allocated = safeWeights.map((weight) =>
    Math.floor((total * weight) / weightTotal)
  );
  allocated[allocated.length - 1] +=
    total - allocated.reduce((sum, amount) => sum + amount, 0);
  return allocated;
}

/**
 * What one stage asks for: the money its percentage was taken from, and the
 * amount itself. A fixed rule has no monetary basis — it is an amount per
 * passenger — so its basis is reported as zero.
 */
type StageAmount = { basisMinor: number; requestedMinor: number };

function stageAmount(
  rule: MarkupRule,
  percentageBasisMinor: number,
  availableMarginMinor: number,
  passengerCount: number
): StageAmount {
  if (rule.markupType === 'fixed') {
    return {
      basisMinor: 0,
      requestedMinor: toMinor(rule.value) * Math.max(1, passengerCount),
    };
  }

  const basisMinor =
    rule.markupType === 'margin_share'
      ? availableMarginMinor
      : percentageBasisMinor;
  // Store percentages to two decimals, then calculate with basis points so
  // 7.25% means exactly 725/10,000 rather than an accumulated float.
  const basisPoints = Math.round(rule.value * 100);
  return {
    basisMinor,
    requestedMinor: Math.round((basisMinor * basisPoints) / 10_000),
  };
}

/**
 * Either stage. A percentage is a percentage of the running selling price: the
 * supplier payable before stage one, the stage one result at stage two. Both
 * stages modify a price, so the effect always matches the number the rule is
 * applied to, on every fare, whatever its tax split.
 *
 * Margin share is the exception: it is a share of the supplier-to-gross
 * margin, a property of the supplier fare, so it means the same in both
 * stages.
 */
function runningStageAmount(
  rule: MarkupRule,
  runningSellingMinor: number,
  availableMarginMinor: number,
  passengerCount: number
): StageAmount {
  return stageAmount(
    rule,
    runningSellingMinor,
    availableMarginMinor,
    passengerCount
  );
}

/**
 * Not a stage. An LCC service margin replaces the calculation with safe gross
 * plus its margin, so its percentage stays a percentage of the base fare.
 *
 * The basis is chosen by which of these two functions the caller uses, not by
 * a branch inside one of them.
 */
function lccServiceAmount(
  rule: MarkupRule,
  basePriceMinor: number,
  availableMarginMinor: number,
  passengerCount: number
): StageAmount {
  return stageAmount(
    rule,
    basePriceMinor,
    availableMarginMinor,
    passengerCount
  );
}

function componentFor(
  rule: MarkupRule,
  stage: PricingComponent['stage'],
  basisMinor: number,
  requestedMinor: number,
  beforeMinor: number,
  afterMinor: number
): PricingComponent {
  return {
    stage,
    ruleId: rule.id,
    markupType: rule.markupType,
    markupValue: rule.value,
    basisAmount: fromMinor(basisMinor),
    requestedAmount: fromMinor(requestedMinor),
    sellingBefore: fromMinor(beforeMinor),
    sellingAfter: fromMinor(afterMinor),
  };
}

/**
 * Turns supplier pricing into the only numbers safe to return to the browser.
 *
 * Two stages, guarded by the same clamp. The base rule prices the supplier
 * fare; the adjustment rule then modifies that selling price. Both work on the
 * running price, so a percentage means a percentage of the supplier payable at
 * stage one and of the stage one result at stage two. Positive markup can
 * consume only the available
 * supplier-to-gross margin; a discount never removes taxes or AIT, and both
 * bounds are re-checked after each stage, so stacking cannot walk past either.
 * B2C with no rule at all stays at gross; an agency with no rule stays at
 * supplier payable. A Super Admin always sees supplier payable. An explicitly
 * flagged LCC service rule replaces the calculation rather than adjusting it,
 * and is the only path allowed above gross. If the rules table cannot be read,
 * customer-facing audiences fall back to gross.
 */
export function priceOffer({
  audience,
  rulesAvailable,
  rules,
  supplierTotalPrice,
  basePrice,
  taxes,
  ait,
  fares,
  passengerCount,
}: {
  audience: PricingAudience;
  rulesAvailable: boolean;
  rules: MarkupRuleSelection;
  supplierTotalPrice: number;
  basePrice: number;
  taxes: number;
  ait: number;
  fares: readonly SupplierFarePricing[];
  passengerCount: number;
}): PricedOffer {
  // Defense in depth: even if a future caller accidentally supplies rules,
  // the verified Super Admin audience can never receive marked pricing.
  const selection = audience.kind === 'superadmin' ? NO_MARKUP_RULES : rules;
  const supplierMinor = Math.max(0, toMinor(supplierTotalPrice));
  const baseMinor = Math.max(0, toMinor(basePrice));
  const taxesMinor = Math.max(0, toMinor(taxes));
  const aitMinor = Math.max(0, toMinor(ait));
  const serviceMinor = fares.reduce(
    (sum, fare) => sum + Math.max(0, toMinor(fare.serviceCharge)),
    0
  );
  const fareMinimums = fares.map(
    (fare) =>
      Math.max(0, toMinor(fare.taxes)) +
      Math.max(0, toMinor(fare.ait))
  );
  const fareMinimumTotal = fareMinimums.reduce(
    (sum, amount) => sum + amount,
    0
  );
  const grossMinor = baseMinor + taxesMinor + aitMinor + serviceMinor;
  const safeGrossMinor = Math.max(grossMinor, supplierMinor);
  const availableMarginMinor = Math.max(0, grossMinor - supplierMinor);
  const minimumSellingMinor = Math.max(
    taxesMinor + aitMinor,
    fareMinimumTotal
  );

  // The one guard rail, unchanged from the single-rule engine and applied
  // after every stage: a selling price may not pass safe gross, and may not
  // fall below payable taxes and AIT. The floor is applied last so it still
  // wins if the two ever cross.
  const clampSelling = (value: number) =>
    Math.max(minimumSellingMinor, Math.min(value, safeGrossMinor));

  // An LCC rule is not an adjustment layer: it replaces the calculation with
  // safe gross plus its service margin, so its percentage stays a percentage
  // of base fare. Validation keeps the flag off all-airlines rules; the base
  // slot is read only so a legacy row cannot silently lose the exception.
  const lccRule =
    selection.adjustment?.lccServiceMargin === true
      ? selection.adjustment
      : selection.base?.lccServiceMargin === true
        ? selection.base
        : null;
  const lccAmount = lccRule
    ? lccServiceAmount(lccRule, baseMinor, availableMarginMinor, passengerCount)
    : null;
  const lccServiceRule =
    lccRule !== null && lccAmount !== null && lccAmount.requestedMinor > 0;

  const components: PricingComponent[] = [];
  let basis: PricingSnapshot['basis'];
  let sellingMinor: number;
  let appliedMarkup: number;
  let requestedMarkup = 0;
  let serviceMarginMinor = 0;
  let grossCapApplied = false;
  let discountFloorApplied = false;

  if (lccServiceRule) {
    basis = 'lcc_service';
    // The one exception allowed above gross: the safe gross fare is the
    // baseline and the configured service margin is added on top. Supplier
    // payable normally equals gross for an LCC fare, but the higher value
    // wins defensively if supplier data differs.
    requestedMarkup = lccAmount.requestedMinor;
    appliedMarkup = lccAmount.requestedMinor;
    serviceMarginMinor = lccAmount.requestedMinor;
    sellingMinor = Math.max(0, safeGrossMinor + lccAmount.requestedMinor);
    components.push(
      componentFor(
        lccRule,
        lccRule === selection.base ? 'base' : 'adjustment',
        lccAmount.basisMinor,
        lccAmount.requestedMinor,
        safeGrossMinor,
        sellingMinor
      )
    );
  } else if (selection.base || selection.adjustment) {
    basis = 'supplier';
    let runningMinor = supplierMinor;

    if (selection.base) {
      // `runningMinor` is still the supplier payable here, so a base-stage
      // percentage is a percentage of the supplier payable.
      const stage = runningStageAmount(
        selection.base,
        runningMinor,
        availableMarginMinor,
        passengerCount
      );
      const target = runningMinor + stage.requestedMinor;
      const next = clampSelling(target);
      grossCapApplied ||= target > safeGrossMinor;
      discountFloorApplied ||= target < minimumSellingMinor;
      components.push(
        componentFor(
          selection.base,
          'base',
          stage.basisMinor,
          stage.requestedMinor,
          runningMinor,
          next
        )
      );
      requestedMarkup += stage.requestedMinor;
      runningMinor = next;
    }

    if (selection.adjustment) {
      // With no base rule the running price is still the supplier payable, so
      // a lone scoped rule and a lone base rule price identically.
      const stage = runningStageAmount(
        selection.adjustment,
        runningMinor,
        availableMarginMinor,
        passengerCount
      );
      const target = runningMinor + stage.requestedMinor;
      const next = clampSelling(target);
      grossCapApplied ||= target > safeGrossMinor;
      discountFloorApplied ||= target < minimumSellingMinor;
      components.push(
        componentFor(
          selection.adjustment,
          'adjustment',
          stage.basisMinor,
          stage.requestedMinor,
          runningMinor,
          next
        )
      );
      requestedMarkup += stage.requestedMinor;
      runningMinor = next;
    }

    sellingMinor = runningMinor;
    appliedMarkup = sellingMinor - supplierMinor;
  } else if (audience.kind === 'superadmin') {
    basis = 'supplier';
    sellingMinor = supplierMinor;
    appliedMarkup = 0;
  } else if (audience.kind === 'b2c' || !rulesAvailable) {
    basis = 'gross';
    sellingMinor = safeGrossMinor;
    appliedMarkup = 0;
  } else {
    basis = 'supplier';
    sellingMinor = supplierMinor;
    appliedMarkup = 0;
  }

  const effectiveRule = lccServiceRule
    ? lccRule
    : (selection.adjustment ?? selection.base);
  const allocationUsesGross = basis === 'gross';

  const publicFareTotals =
    appliedMarkup < 0
      ? allocateMinor(
          Math.max(0, sellingMinor - fareMinimumTotal),
          fares.map((fare, index) =>
            Math.max(
              0,
              toMinor(fare.supplierTotalPrice) -
                (fareMinimums[index] ?? 0)
            )
          )
        ).map((amount, index) => amount + (fareMinimums[index] ?? 0))
      : allocateMinor(
          sellingMinor,
          fares.map((fare) =>
            allocationUsesGross
              ? toMinor(
                  fare.basePrice +
                    fare.taxes +
                    fare.ait +
                    fare.serviceCharge
                )
              : toMinor(fare.supplierTotalPrice)
          )
        );
  const publicServiceMargins = allocateMinor(
    serviceMarginMinor,
    fares.map((fare) =>
      lccRule?.markupType === 'fixed' ? fare.count : toMinor(fare.basePrice)
    )
  );

  const publicFares: FareBreakdown[] = fares.map((fare, index) => {
    const total = publicFareTotals[index] ?? 0;
    const fareTaxes = Math.max(0, toMinor(fare.taxes));
    const fareAit = Math.max(0, toMinor(fare.ait));
    const fareServiceMargin = publicServiceMargins[index] ?? 0;
    return {
      passengerType: fare.passengerType,
      count: fare.count,
      // "Fare" in the UI: the commercial fare after discounts/markup, while
      // taxes and AIT remain their actual public components.
      basePrice: fromMinor(
        Math.max(0, total - fareTaxes - fareAit - fareServiceMargin)
      ),
      taxes: fromMinor(fareTaxes),
      ait: fromMinor(fareAit),
      serviceMargin: fromMinor(fareServiceMargin),
      totalPrice: fromMinor(total),
    };
  });

  return {
    totalPrice: fromMinor(sellingMinor),
    basePrice: fromMinor(
      Math.max(
        0,
        sellingMinor - taxesMinor - aitMinor - serviceMarginMinor
      )
    ),
    taxes: fromMinor(taxesMinor),
    ait: fromMinor(aitMinor),
    serviceMargin: fromMinor(serviceMarginMinor),
    fares: publicFares,
    snapshot: {
      audience: audience.kind,
      agencyCode: audience.kind === 'agency' ? audience.agencyCode : null,
      basis,
      supplierTotalPrice: fromMinor(supplierMinor),
      grossPrice: fromMinor(grossMinor),
      availableMargin: fromMinor(availableMarginMinor),
      requestedMarkupAmount: fromMinor(requestedMarkup),
      markupAmount: fromMinor(appliedMarkup),
      serviceMarginAmount: fromMinor(serviceMarginMinor),
      sellingPrice: fromMinor(sellingMinor),
      grossCapApplied,
      lccServiceMargin: lccServiceRule,
      discountFloorApplied,
      // The most specific rule that priced this offer. `components` carries
      // the full two-stage detail.
      ruleId: effectiveRule?.id ?? null,
      markupType: effectiveRule?.markupType ?? null,
      markupValue: effectiveRule?.value ?? null,
      components,
    },
  };
}

export function markupRuleScope(rule: MarkupRule): string {
  if (!rule.origin || !rule.destination) {
    return rule.airlineCode
      ? `All ${rule.airlineCode} routes`
      : 'All airlines · all routes';
  }
  const route = `${rule.origin} ${
    rule.bidirectional ? '↔' : '→'
  } ${rule.destination}`;
  return rule.airlineCode ? route : `All airlines · ${route}`;
}
