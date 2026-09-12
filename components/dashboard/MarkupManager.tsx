'use client';

import AgencySearch from '@/components/dashboard/AgencySearch';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  Check,
  CircleDollarSign,
  Gauge,
  Globe2,
  Loader2,
  MapPin,
  Pencil,
  Percent,
  Plane,
  Plus,
  Power,
  Route,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';

import {
  removeMarkupRuleAction,
  saveMarkupRuleAction,
  setMarkupRuleActiveAction,
  type MarkupActionResult,
} from '@/app/(dashboard)/dashboard/markup/actions';
import { agencyOptionLabel, type AgencyOption } from '@/lib/agency';
import {
  markupRuleScope,
  priceOffer,
  type MarkupRule,
  type MarkupRuleInput,
  type PricingComponent,
  validateMarkupRuleInput,
} from '@/lib/markup';

type RuleDraft = Omit<MarkupRuleInput, 'airlineCode'> & {
  airlineCode: string;
  scope: 'all' | 'airline' | 'route' | 'all-route';
};

const EMPTY_DRAFT: RuleDraft = {
  audience: 'b2c',
  agencyCode: null,
  airlineCode: '',
  origin: null,
  destination: null,
  bidirectional: false,
  markupType: 'fixed',
  value: 0,
  lccServiceMargin: false,
  active: true,
  scope: 'airline',
};

const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const AIRPORT_CODE = /^[A-Z]{3}$/;

function inputForDraft(draft: RuleDraft): MarkupRuleInput {
  const routeScope =
    draft.scope === 'route' || draft.scope === 'all-route';

  return {
    audience: draft.audience,
    agencyCode: draft.audience === 'agency' ? draft.agencyCode : null,
    airlineCode:
      draft.scope === 'all' || draft.scope === 'all-route'
        ? null
        : draft.airlineCode,
    origin: routeScope ? draft.origin : null,
    destination: routeScope ? draft.destination : null,
    bidirectional: routeScope ? draft.bidirectional : false,
    markupType: draft.markupType,
    value: draft.value,
    lccServiceMargin: draft.lccServiceMargin,
    active: draft.active,
  };
}

function draftValidationMessage(draft: RuleDraft): string | null {
  if (draft.audience === 'agency' && !draft.agencyCode) {
    return 'Choose the agent this rule belongs to.';
  }

  if (
    (draft.scope === 'airline' || draft.scope === 'route') &&
    !AIRLINE_CODE.test(draft.airlineCode)
  ) {
    return 'Enter a complete two-character airline code.';
  }

  if (draft.scope === 'route' || draft.scope === 'all-route') {
    if (!draft.origin || !AIRPORT_CODE.test(draft.origin)) {
      return 'Enter a three-letter origin airport code.';
    }
    if (!draft.destination || !AIRPORT_CODE.test(draft.destination)) {
      return 'Enter a three-letter destination airport code.';
    }
    if (draft.origin === draft.destination) {
      return 'Route origin and destination must differ.';
    }
  }

  const parsed = validateMarkupRuleInput(inputForDraft(draft));
  return parsed.ok ? null : parsed.message;
}

function valueForMarkupType(
  markupType: RuleDraft['markupType'],
  currentValue: number,
  lccServiceMargin: boolean
): number {
  if (markupType === 'margin_share') {
    return currentValue > 0 && currentValue <= 100 ? currentValue : 50;
  }

  if (markupType === 'percentage') {
    if (
      currentValue !== 0 &&
      Math.abs(currentValue) <= 100 &&
      (!lccServiceMargin || currentValue > 0)
    ) {
      return currentValue;
    }
    return currentValue < 0 && !lccServiceMargin ? -5 : 5;
  }

  if (
    currentValue !== 0 &&
    Math.abs(currentValue) <= 1_000_000 &&
    (!lccServiceMargin || currentValue > 0)
  ) {
    return currentValue;
  }
  return currentValue < 0 && !lccServiceMargin ? -200 : 200;
}

function draftFor(rule: MarkupRule): RuleDraft {
  return {
    audience: rule.audience,
    agencyCode: rule.agencyCode,
    airlineCode: rule.airlineCode ?? '',
    origin: rule.origin,
    destination: rule.destination,
    bidirectional: rule.bidirectional,
    markupType: rule.markupType,
    value: rule.value,
    lccServiceMargin: rule.lccServiceMargin,
    active: rule.active,
    scope: rule.airlineCode
      ? rule.origin
        ? 'route'
        : 'airline'
      : rule.origin
        ? 'all-route'
        : 'all',
  };
}

function inputClass(extra = '') {
  return `mt-1 w-full rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/35 focus:border-brand-orange focus:ring-1 focus:ring-brand-orange disabled:cursor-not-allowed disabled:bg-navy-50 ${extra}`;
}

function Field({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-navy-700">
        {label}
        {required && <span className="ml-0.5 text-brand-orange">*</span>}
      </span>
      {children}
    </label>
  );
}

const EXAMPLE_SUPPLIER = 5_350.89;
const EXAMPLE_GROSS = 5_749;
const EXAMPLE_BASE = 4_524;

const LCC_EXAMPLES =
  'Southwest, Ryanair, AirAsia, IndiGo, easyJet, Scoot, Jetstar, ZIPAIR, West Air, Air India Express, SpiceJet, Wings Air, Jazeera Airways, SalamAir, Flynas, flyadeal, flydubai, Air Arabia';

function ChoiceCard({
  selected,
  disabled,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  disabled: boolean;
  icon: typeof Users;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-20 items-start gap-3 rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? 'border-brand-orange bg-brand-orange-light/60 ring-1 ring-brand-orange/20'
          : 'border-navy-100 bg-white hover:border-navy-200 hover:bg-navy-50/60'
      }`}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
          selected
            ? 'bg-brand-orange text-navy-950'
            : 'bg-navy-50 text-navy-800'
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-navy-950">
          {title}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-navy-700/65">
          {description}
        </span>
      </span>
    </button>
  );
}

function money(value: number) {
  return `BDT ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function percent(value: number) {
  return `${Math.abs(value).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}%`;
}

/** A base rule prices the supplier fare; anything scoped adjusts its result. */
function isBaseScope(rule: { airlineCode: string | null; origin: string | null }) {
  return rule.airlineCode === null && !rule.origin;
}

function percentageBasisLabel(baseScope: boolean, lccServiceMargin = false) {
  if (lccServiceMargin) return 'base fare';
  return baseScope ? 'supplier payable' : 'the base-rule price';
}

function ruleValueLabel(rule: MarkupRule) {
  if (rule.markupType === 'fixed') {
    if (rule.value < 0) {
      return `${money(Math.abs(rule.value))} discount per passenger`;
    }
    return `${money(rule.value)} per passenger`;
  }
  if (rule.markupType === 'margin_share') {
    return `${percent(rule.value)} of available supplier margin`;
  }
  const basis = percentageBasisLabel(
    isBaseScope(rule),
    rule.lccServiceMargin
  );
  if (rule.value < 0) {
    return `${percent(rule.value)} discount on ${basis}`;
  }
  return `${percent(rule.value)} of ${basis}`;
}

function componentEffectLabel(component: PricingComponent) {
  const sign = component.requestedAmount < 0 ? '−' : '+';
  if (component.markupType === 'fixed') {
    return `${sign}${money(Math.abs(component.markupValue))} per passenger`;
  }
  const amount = `${sign}${money(Math.abs(component.requestedAmount))}`;
  if (component.markupType === 'margin_share') {
    return `${percent(component.markupValue)} of available supplier margin · ${amount}`;
  }
  return `${sign}${percent(component.markupValue)} of ${percentageBasisLabel(
    component.stage === 'base'
  )} · ${amount}`;
}

/**
 * The saved rule that would price the supplier fare before this draft adjusts
 * it. Mirrors `selectMarkupRules()`: an agency keeps its own base rule and
 * falls back to the all-B2B one, and B2C never crosses audiences.
 */
function baseRuleForDraft(
  rules: MarkupRule[],
  draft: RuleDraft,
  editingId: string | null
): MarkupRule | null {
  const globals = rules
    .filter(
      (rule) =>
        rule.active && rule.id !== editingId && isBaseScope(rule)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (draft.audience === 'b2c') {
    return globals.find((rule) => rule.audience === 'b2c') ?? null;
  }

  const own =
    draft.audience === 'agency' && draft.agencyCode
      ? globals.find(
          (rule) =>
            rule.audience === 'agency' &&
            rule.agencyCode === draft.agencyCode
        )
      : undefined;
  return own ?? globals.find((rule) => rule.audience === 'b2b') ?? null;
}

function PriceExample() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border border-navy-100 bg-white p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
            <Users className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-navy-950">
              Normal airline margin
            </p>
            <p className="text-xs text-navy-700/60">
              Supplier payable → gross ceiling
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-navy-700/60">Supplier</p>
            <p className="mt-0.5 font-semibold text-navy-950">
              BDT 5,350.89
            </p>
          </div>
          <div>
            <p className="text-navy-700/60">Available margin</p>
            <p className="mt-0.5 font-semibold text-brand-orange">
              BDT 398.11
            </p>
          </div>
          <div>
            <p className="text-navy-700/60">Maximum selling</p>
            <p className="mt-0.5 font-semibold text-navy-950">BDT 5,749.00</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-100 text-amber-800">
            <Percent className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-navy-950">
              LCC service margin
            </p>
            <p className="text-xs text-navy-700/60">
              Explicit exception above gross
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-navy-700/60">Supplier / gross</p>
            <p className="mt-0.5 font-semibold text-navy-950">BDT 5,749.00</p>
          </div>
          <div>
            <p className="text-navy-700/60">Service margin</p>
            <p className="mt-0.5 font-semibold text-brand-orange">+ BDT 200.00</p>
          </div>
          <div>
            <p className="text-navy-700/60">Selling total</p>
            <p className="mt-0.5 font-semibold text-navy-950">BDT 5,949.00</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function RulePreview({
  draft,
  summary,
  baseRule,
}: {
  draft: RuleDraft;
  summary: string;
  baseRule: MarkupRule | null;
}) {
  const lccServiceMargin =
    draft.lccServiceMargin && draft.value > 0;
  const supplier = lccServiceMargin ? EXAMPLE_GROSS : EXAMPLE_SUPPLIER;
  const draftIsBase = draft.scope === 'all';
  const previewRule: MarkupRule = {
    id: 'preview',
    audience: 'b2c',
    agencyCode: null,
    airlineCode: draft.airlineCode || null,
    origin: null,
    destination: null,
    bidirectional: false,
    markupType: draft.markupType,
    value:
      draft.markupType === 'margin_share'
        ? Math.max(0, draft.value)
        : draft.value,
    lccServiceMargin,
    active: true,
    createdAt: '',
    updatedAt: '',
  };
  const preview = priceOffer({
    audience: { kind: 'b2c' },
    rulesAvailable: true,
    rules: draftIsBase
      ? { base: previewRule, adjustment: null }
      : { base: baseRule, adjustment: previewRule },
    supplierTotalPrice: supplier,
    basePrice: EXAMPLE_BASE,
    taxes: EXAMPLE_GROSS - EXAMPLE_BASE,
    ait: 0,
    fares: [
      {
        passengerType: 'ADT',
        count: 1,
        basePrice: EXAMPLE_BASE,
        taxes: EXAMPLE_GROSS - EXAMPLE_BASE,
        ait: 0,
        serviceCharge: 0,
        supplierTotalPrice: supplier,
      },
    ],
    passengerCount: 1,
  });
  const requested = preview.snapshot.requestedMarkupAmount;
  const applied = preview.snapshot.markupAmount;
  const selling = preview.totalPrice;
  const stages = preview.snapshot.components ?? [];

  return (
    <div
      className={`rounded-lg border p-4 ${
        lccServiceMargin
          ? 'border-amber-200 bg-amber-50/60'
          : 'border-navy-100 bg-navy-50/60'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-brand-orange-dark ring-1 ring-navy-100">
          <Gauge className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-navy-700/55">
            Rule summary
          </p>
          <p className="mt-1 text-sm font-semibold leading-relaxed text-navy-950">
            {summary}
          </p>
        </div>
      </div>

      {stages.length > 1 && (
        <ol className="mt-4 space-y-1.5">
          <li className="flex items-center justify-between gap-3 px-3 text-[11px] text-navy-700/55">
            <span>Supplier payable</span>
            <span className="font-semibold">{money(supplier)}</span>
          </li>
          {stages.map((stage) => (
            <li
              key={`${stage.stage}-${stage.ruleId}`}
              className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-xs ring-1 ring-navy-100"
            >
              <span className="min-w-0">
                <span className="block font-semibold text-navy-950">
                  {stage.ruleId === 'preview'
                    ? 'This rule'
                    : `Base rule · ${
                        baseRule ? markupRuleScope(baseRule) : 'all airlines'
                      }`}
                </span>
                <span className="mt-0.5 block text-navy-700/60">
                  {componentEffectLabel(stage)}
                </span>
              </span>
              <span className="shrink-0 font-semibold text-navy-950">
                {money(stage.sellingAfter)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 grid grid-cols-3 divide-x divide-navy-100 rounded-md bg-white py-3 ring-1 ring-navy-100">
        <div className="px-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-navy-700/50">
            Requested
          </p>
          <p className="mt-1 text-xs font-semibold text-navy-950">
            {money(requested)}
          </p>
        </div>
        <div className="px-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-navy-700/50">
            Applied
          </p>
          <p className="mt-1 text-xs font-semibold text-navy-950">
            {money(applied)}
          </p>
        </div>
        <div className="px-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-navy-700/50">
            Example fare
          </p>
          <p className="mt-1 text-xs font-semibold text-brand-orange-dark">
            {money(selling)}
          </p>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-navy-700/55">
        Example uses one passenger and a BDT 4,524 base fare.
        {!lccServiceMargin &&
          !draftIsBase &&
          !baseRule &&
          ' No saved base rule covers this audience yet, so this rule prices from supplier payable on its own.'}
        {!lccServiceMargin &&
          requested - applied >= 0.005 &&
          ` Markup is capped at gross by ${money(requested - applied)}.`}
        {!lccServiceMargin &&
          applied - requested >= 0.005 &&
          ` Discount is limited by ${money(
            applied - requested
          )} so taxes and AIT remain payable.`}
        {lccServiceMargin &&
          ' This service margin is added above gross.'}
        {lccServiceMargin &&
          baseRule &&
          ' An LCC service margin replaces the base rule instead of adjusting it.'}
      </p>
    </div>
  );
}

export default function MarkupManager({
  rules,
  agencies,
  configured,
  readFailed,
}: {
  rules: MarkupRule[];
  agencies: AgencyOption[];
  configured: boolean;
  readFailed: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState<MarkupActionResult | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [rulesAgencyCode, setRulesAgencyCode] = useState('');
  const ruleAgencies = useMemo(() => {
    const options = new Map(agencies.map((agency) => [agency.agencyCode, agency]));
    for (const rule of rules) {
      if (rule.audience === 'agency' && rule.agencyCode && !options.has(rule.agencyCode)) {
        options.set(rule.agencyCode, { agencyCode: rule.agencyCode, label: '' });
      }
    }
    return Array.from(options.values());
  }, [agencies, rules]);
  const visibleRules = rulesAgencyCode
    ? rules.filter((rule) => rule.audience === 'agency' && rule.agencyCode === rulesAgencyCode)
    : rules;

  const agencyLabels = useMemo(
    () =>
      new Map(
        agencies.map((agency) => [
          agency.agencyCode,
          agencyOptionLabel(agency),
        ])
      ),
    [agencies]
  );

  const activeCount = rules.filter((rule) => rule.active).length;
  const routeCount = rules.filter((rule) => rule.origin).length;
  const selectedAgency =
    agencyLabels.get(draft.agencyCode ?? '') ?? 'the selected agent';
  const routeLabel =
    draft.origin && draft.destination
      ? `${draft.origin} ${draft.bidirectional ? '↔' : '→'} ${
          draft.destination
        }`
      : 'the selected route';
  const coverageLabel =
    draft.scope === 'all'
      ? 'every airline and route'
      : draft.scope === 'airline'
        ? `${draft.airlineCode || 'the selected airline'} on every route`
        : draft.scope === 'all-route'
          ? `every airline on ${routeLabel}`
          : `${draft.airlineCode || 'the selected airline'} on ${routeLabel}`;
  const draftIsBase = draft.scope === 'all';
  const draftPercentageBasis = percentageBasisLabel(
    draftIsBase,
    draft.lccServiceMargin && draft.value > 0
  );
  const previewBaseRule = useMemo(
    () => baseRuleForDraft(rules, draft, editingId),
    [rules, draft, editingId]
  );
  const markupLabel =
    draft.markupType === 'fixed'
      ? draft.value < 0
        ? `Discount ${money(Math.abs(draft.value))} per passenger`
        : `Add ${money(draft.value)} per passenger`
      : draft.markupType === 'percentage'
        ? draft.value < 0
          ? `Discount ${Math.abs(draft.value)}% of ${draftPercentageBasis}`
          : `Add ${draft.value || 0}% of ${draftPercentageBasis}`
        : `Keep ${draft.value || 0}% of the available supplier margin`;
  const ruleSummary = `${markupLabel} for ${
    draft.audience === 'b2c'
      ? 'B2C customers'
      : draft.audience === 'b2b'
        ? 'all B2B agencies and their sub-users'
        : selectedAgency
  } across ${coverageLabel}.`;
  const currentDraftIssue = draftValidationMessage(draft);

  function resetForm() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setConfirmDeleteId(null);
  }

  function run(
    action: () => Promise<MarkupActionResult>,
    onSuccess?: () => void
  ) {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      if (result.ok) {
        onSuccess?.();
        router.refresh();
      }
    });
  }

  function chooseAudience(audience: RuleDraft['audience']) {
    setDraft((current) => ({
      ...current,
      audience,
      agencyCode: audience === 'agency' ? current.agencyCode : null,
    }));
  }

  function chooseScope(scope: RuleDraft['scope']) {
    const allAirlines = scope === 'all' || scope === 'all-route';
    const specificRoute = scope === 'route' || scope === 'all-route';
    setDraft((current) => ({
      ...current,
      scope,
      airlineCode: allAirlines ? '' : current.airlineCode,
      origin: specificRoute ? current.origin : null,
      destination: specificRoute ? current.destination : null,
      bidirectional: specificRoute ? current.bidirectional : false,
      lccServiceMargin: allAirlines ? false : current.lccServiceMargin,
    }));
  }

  function chooseMarkupType(markupType: RuleDraft['markupType']) {
    setDraft((current) => ({
      ...current,
      markupType,
      value: valueForMarkupType(
        markupType,
        current.value,
        current.lccServiceMargin
      ),
    }));
  }

  function submit() {
    const issue = draftValidationMessage(draft);
    if (issue) {
      setNotice({ ok: false, message: issue });
      return;
    }

    const input = inputForDraft(draft);
    run(() => saveMarkupRuleAction(editingId, input), resetForm);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-navy-950">
            Fare Pricing Rules
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-navy-700/70">
            Create markups or discounts by choosing who receives the rule,
            where it applies, and how the adjustment is calculated.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded-full bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700">
            {activeCount} active
          </span>
          <span className="rounded-full bg-navy-50 px-3 py-1.5 font-semibold text-navy-800">
            {routeCount} route-specific
          </span>
        </div>
      </div>

      <details className="group overflow-hidden rounded-lg border border-navy-100 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-navy-950 marker:hidden">
          <span>How pricing works</span>
          <span className="text-xs font-medium text-navy-700/55 group-open:hidden">
            Show examples
          </span>
          <span className="hidden text-xs font-medium text-navy-700/55 group-open:inline">
            Hide examples
          </span>
        </summary>
        <div className="border-t border-navy-100 bg-navy-50/40 p-4">
          <PriceExample />
        </div>
      </details>

      {(!configured || readFailed) && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {configured
              ? 'Pricing rules could not be loaded. No rule changes are available until storage responds.'
              : 'Pricing-rule storage is not configured in this environment.'}
          </p>
        </div>
      )}

      <section className="overflow-hidden rounded-lg border border-navy-100 bg-white">
        <div className="border-b border-navy-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-navy-950">
            {editingId ? 'Edit pricing rule' : 'Add pricing rule'}
          </h2>
          <p className="mt-1 text-xs text-navy-700/65">
            Complete the four short steps below. Only fields needed for your
            selected coverage will appear.
          </p>
        </div>

        <form
          className="space-y-7 p-4 sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset className="space-y-3">
            <legend className="flex items-center gap-3 text-sm font-semibold text-navy-950">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-orange text-xs text-navy-950">
                1
              </span>
              Who will receive this rule?
            </legend>
            <div
              role="radiogroup"
              aria-label="Pricing audience"
              className="grid gap-3 sm:grid-cols-3"
            >
              <ChoiceCard
                selected={draft.audience === 'b2c'}
                disabled={pending}
                icon={Users}
                title="B2C customers"
                description="Public customer fares across the website."
                onClick={() => chooseAudience('b2c')}
              />
              <ChoiceCard
                selected={draft.audience === 'b2b'}
                disabled={pending}
                icon={Building2}
                title="All B2B users"
                description="Every B2B agency and all of their sub-users."
                onClick={() => chooseAudience('b2b')}
              />
              <ChoiceCard
                selected={draft.audience === 'agency'}
                disabled={pending}
                icon={UserRound}
                title="Specific agent"
                description="One B2B agency and its sub-users."
                onClick={() => chooseAudience('agency')}
              />
            </div>

            {draft.audience === 'agency' && (
              <div className="max-w-md">
                <AgencySearch
                  label="Choose agent"
                  required
                  agencies={agencies}
                  value={draft.agencyCode ?? ''}
                  disabled={pending}
                  onChange={(agencyCode) =>
                    setDraft((current) => ({ ...current, agencyCode }))
                  }
                />
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3 border-t border-navy-100 pt-6">
            <legend className="flex items-center gap-3 text-sm font-semibold text-navy-950">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-orange text-xs text-navy-950">
                2
              </span>
              Where will it apply?
            </legend>
            <div
              role="radiogroup"
              aria-label="Pricing coverage"
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            >
              <ChoiceCard
                selected={draft.scope === 'all'}
                disabled={pending}
                icon={Globe2}
                title="All airlines + all routes"
                description="The default fallback for every flight."
                onClick={() => chooseScope('all')}
              />
              <ChoiceCard
                selected={draft.scope === 'airline'}
                disabled={pending}
                icon={Plane}
                title="Specific airline + all routes"
                description="One airline, wherever it flies."
                onClick={() => chooseScope('airline')}
              />
              <ChoiceCard
                selected={draft.scope === 'route'}
                disabled={pending}
                icon={Route}
                title="Specific airline + specific route"
                description="One airline on one selected route."
                onClick={() => chooseScope('route')}
              />
              <ChoiceCard
                selected={draft.scope === 'all-route'}
                disabled={pending}
                icon={MapPin}
                title="All airlines + specific route"
                description="Every airline on one selected route."
                onClick={() => chooseScope('all-route')}
              />
            </div>

            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              {(draft.scope === 'airline' || draft.scope === 'route') && (
                <Field label="Airline code" required>
                  <input
                    required
                    maxLength={2}
                    pattern="[A-Za-z0-9]{2}"
                    value={draft.airlineCode}
                    disabled={pending}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        airlineCode: event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 2),
                      }))
                    }
                    placeholder="BG"
                    className={inputClass('uppercase')}
                  />
                </Field>
              )}

              {(draft.scope === 'route' ||
                draft.scope === 'all-route') && (
                <>
                  <Field label="Origin" required>
                    <input
                      required
                      maxLength={3}
                      pattern="[A-Za-z]{3}"
                      value={draft.origin ?? ''}
                      disabled={pending}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          origin:
                            event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z]/g, '')
                              .slice(0, 3) || null,
                        }))
                      }
                      placeholder="DAC"
                      className={inputClass('uppercase')}
                    />
                  </Field>
                  <Field label="Destination" required>
                    <input
                      required
                      maxLength={3}
                      pattern="[A-Za-z]{3}"
                      value={draft.destination ?? ''}
                      disabled={pending}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          destination:
                            event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z]/g, '')
                              .slice(0, 3) || null,
                        }))
                      }
                      placeholder="CXB"
                      className={inputClass('uppercase')}
                    />
                  </Field>
                </>
              )}
            </div>

            {(draft.scope === 'route' || draft.scope === 'all-route') && (
              <label className="inline-flex items-center gap-2 rounded-md border border-navy-100 px-3 py-2 text-sm text-navy-800">
                <input
                  type="checkbox"
                  checked={draft.bidirectional}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bidirectional: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 accent-red-600"
                />
                Apply in both directions
              </label>
            )}
          </fieldset>

          <fieldset className="space-y-3 border-t border-navy-100 pt-6">
            <legend className="flex items-center gap-3 text-sm font-semibold text-navy-950">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-orange text-xs text-navy-950">
                3
              </span>
              Choose the adjustment
            </legend>
            <div
              role="radiogroup"
              aria-label="Pricing adjustment"
              className="grid gap-3 sm:grid-cols-3"
            >
              <ChoiceCard
                selected={draft.markupType === 'fixed'}
                disabled={pending}
                icon={CircleDollarSign}
                title="Fixed BDT"
                description="Positive markup or negative discount per passenger."
                onClick={() => chooseMarkupType('fixed')}
              />
              <ChoiceCard
                selected={draft.markupType === 'percentage'}
                disabled={pending}
                icon={Percent}
                title="Percentage"
                description={`Positive markup or negative discount on ${draftPercentageBasis}.`}
                onClick={() => chooseMarkupType('percentage')}
              />
              <ChoiceCard
                selected={draft.markupType === 'margin_share'}
                disabled={pending || draft.lccServiceMargin}
                icon={Gauge}
                title="Margin share"
                description="Keep part of the supplier-to-gross margin."
                onClick={() => chooseMarkupType('margin_share')}
              />
            </div>

            <div className="max-w-sm">
              <Field
                label={
                  draft.markupType === 'fixed'
                    ? 'Amount per passenger'
                    : draft.markupType === 'percentage'
                      ? `Percentage of ${draftPercentageBasis}`
                      : 'Share of available margin'
                }
                required
              >
                <div className="relative">
                  <input
                    required
                    type="number"
                    min={
                      draft.lccServiceMargin
                        ? 0.01
                        : draft.markupType === 'margin_share'
                          ? 0
                          : draft.markupType === 'fixed'
                            ? -1000000
                            : -100
                    }
                    max={
                      draft.markupType === 'fixed' ? 1000000 : 100
                    }
                    step={
                      0.01
                    }
                    value={
                      draft.markupType === 'margin_share'
                        ? draft.value
                        : draft.value || ''
                    }
                    disabled={pending}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setDraft((current) => ({
                        ...current,
                        value,
                        lccServiceMargin:
                          current.lccServiceMargin && value > 0,
                      }));
                    }}
                    placeholder={
                      draft.markupType === 'fixed' ? '200' : '5'
                    }
                    className={inputClass('pr-16')}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 text-xs text-navy-700/50">
                    {draft.markupType === 'fixed' ? 'BDT' : '%'}
                  </span>
                </div>
              </Field>
            </div>
          </fieldset>

          <details className="group overflow-hidden rounded-lg border border-navy-100 bg-white">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-navy-950 marker:hidden">
              <span>Advanced settings</span>
              <span className="text-xs font-medium text-navy-700/55">
                {!draft.active
                  ? 'Rule paused'
                  : draft.lccServiceMargin
                    ? 'LCC margin enabled'
                    : 'Status and LCC options'}
              </span>
            </summary>
            <div className="space-y-3 border-t border-navy-100 bg-navy-50/40 p-4">
              <label className="flex items-start gap-3 rounded-md border border-navy-100 bg-white p-3 text-sm text-navy-800">
                <input
                  type="checkbox"
                  checked={draft.active}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      active: event.target.checked,
                    }))
                  }
                  className="mt-0.5 h-4 w-4 accent-red-600"
                />
                <span>
                  <span className="block font-semibold text-navy-950">
                    Rule active
                  </span>
                  <span className="mt-0.5 block text-xs text-navy-700/60">
                    Turn this off to save the rule without applying it.
                  </span>
                </span>
              </label>

              {(draft.scope === 'airline' || draft.scope === 'route') && (
                <label
                  className={`flex items-start gap-3 rounded-md border p-3 text-sm ${
                    draft.lccServiceMargin
                      ? 'border-amber-300 bg-amber-50 text-amber-950'
                      : 'border-navy-100 bg-white text-navy-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={draft.lccServiceMargin}
                    disabled={pending}
                    onChange={(event) => {
                      const lccServiceMargin = event.target.checked;
                      setDraft((current) => ({
                        ...current,
                        lccServiceMargin,
                        markupType:
                          lccServiceMargin &&
                          current.markupType === 'margin_share'
                            ? 'fixed'
                            : current.markupType,
                        value: lccServiceMargin
                          ? Math.abs(current.value) ||
                            (current.markupType === 'percentage' ? 5 : 200)
                          : current.value,
                      }));
                    }}
                    className="mt-0.5 h-4 w-4 accent-amber-600"
                  />
                  <span>
                    <span className="block font-semibold">
                      LCC service margin above gross
                    </span>
                    <span className="mt-0.5 block text-xs opacity-70">
                      Use only for an LCC airline. Examples: {LCC_EXAMPLES}.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </details>

          <div className="space-y-3 border-t border-navy-100 pt-6">
            <div className="flex items-center gap-3 text-sm font-semibold text-navy-950">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-orange text-xs text-navy-950">
                4
              </span>
              Review and save
            </div>

            <RulePreview
              draft={draft}
              summary={ruleSummary}
              baseRule={previewBaseRule}
            />

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={
                  pending ||
                  !configured ||
                  readFailed ||
                  currentDraftIssue !== null
                }
                aria-describedby={
                  currentDraftIssue ? 'pricing-rule-validation' : undefined
                }
                className="inline-flex items-center gap-2 rounded-md bg-brand-orange px-5 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : editingId ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {editingId ? 'Save changes' : 'Create rule'}
              </button>
              {editingId && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={resetForm}
                  className="inline-flex items-center gap-2 rounded-md border border-navy-100 px-4 py-2.5 text-sm font-medium text-navy-800 transition hover:bg-navy-50"
                >
                  <X className="h-4 w-4" />
                  Cancel
                </button>
              )}
            </div>
            {currentDraftIssue && configured && !readFailed && (
              <p
                id="pricing-rule-validation"
                className="text-xs font-medium text-amber-700"
              >
                Complete this rule to save: {currentDraftIssue}
              </p>
            )}
          </div>
        </form>

        {notice && (
          <div
            role="status"
            className={`flex items-start gap-2 border-t px-4 py-3 text-sm ${
              notice.ok
                ? 'border-emerald-100 bg-emerald-50 text-emerald-800'
                : 'border-red-100 bg-red-50 text-red-700'
            }`}
          >
            {notice.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {notice.message}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-navy-100 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-navy-950">Pricing rules</h2>
            <p className="mt-0.5 text-xs text-navy-700/60">
              {rules.length} {rules.length === 1 ? 'rule' : 'rules'} configured
            </p>
          </div>
          <p className="text-xs text-navy-700/60">
            The all-airlines rule prices the fare; the most specific rule
            adjusts it
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-navy-100 px-4 py-4">
          <div className="w-full max-w-md">
            <AgencySearch
              label="Filter rules by agency"
              agencies={ruleAgencies}
              value={rulesAgencyCode}
              onChange={setRulesAgencyCode}
            />
          </div>
          {rulesAgencyCode && (
            <button type="button" onClick={() => setRulesAgencyCode('')} className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 px-3 py-3 text-xs font-semibold text-navy-700 hover:bg-navy-50">
              <X className="h-3.5 w-3.5" aria-hidden /> Clear filter
            </button>
          )}
          <p role="status" className="w-full text-xs text-navy-700/60">
            {rulesAgencyCode
              ? `${visibleRules.length} agency-specific ${visibleRules.length === 1 ? 'rule' : 'rules'} found`
              : `Showing all ${rules.length} pricing rules`}
          </p>
        </div>

        {visibleRules.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
              <Percent className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-semibold text-navy-950">
              {rulesAgencyCode ? 'No pricing rules for this agency' : 'No pricing rules yet'}
            </p>
            <p className="mt-1 text-xs text-navy-700/60">
              {rulesAgencyCode ? 'Choose another agency or clear the filter to see all rules.' : 'Add a global fallback, then make airline or route-specific exceptions when needed.'}
            </p>
          </div>
        ) : (
          <div>
            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 bg-navy-50/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-navy-700/50 lg:grid">
              <span>Audience and coverage</span>
              <span>Adjustment</span>
              <span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-navy-100">
              {visibleRules.map((rule) => {
              const target =
                rule.audience === 'b2c'
                  ? 'B2C customers'
                  : rule.audience === 'b2b'
                    ? 'All B2B users'
                    : agencyLabels.get(rule.agencyCode ?? '') ??
                      rule.agencyCode ??
                      'Unknown agency';
              const deleting = confirmDeleteId === rule.id;

                return (
                  <article
                  key={rule.id}
                  className={`grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center ${
                    rule.active ? '' : 'bg-navy-50/60 opacity-70'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 font-mono text-xs font-bold ${
                          rule.airlineCode
                            ? 'bg-navy-50 text-navy-900'
                            : 'bg-brand-orange-light text-brand-orange-dark'
                        }`}
                      >
                        {rule.airlineCode ?? 'ALL'}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-navy-950">
                          {target}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-navy-700/65">
                          <Route className="h-3.5 w-3.5" />
                          {markupRuleScope(rule)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          rule.active
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-navy-100 text-navy-700'
                        }`}
                      >
                        {rule.active ? 'Active' : 'Paused'}
                      </span>
                      {rule.lccServiceMargin && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                          LCC · above gross
                        </span>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-brand-orange-dark">
                      {ruleValueLabel(rule)}
                    </p>
                    <p className="mt-0.5 text-xs text-navy-700/60">
                      {rule.lccServiceMargin
                        ? 'Explicit service margin added above gross'
                        : isBaseScope(rule)
                          ? 'Base stage: prices the supplier fare, capped at gross'
                          : 'Adjusts the base-rule price; capped at gross, floored at taxes and AIT'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1 lg:justify-end">
                    {deleting ? (
                      <>
                        <span className="mr-1 text-xs font-medium text-red-700">
                          Delete?
                        </span>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(
                              () => removeMarkupRuleAction(rule.id),
                              () => setConfirmDeleteId(null)
                            )
                          }
                          className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-navy-700 hover:bg-navy-50"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          title={rule.active ? 'Pause rule' : 'Enable rule'}
                          aria-label={rule.active ? 'Pause rule' : 'Enable rule'}
                          onClick={() =>
                            run(() =>
                              setMarkupRuleActiveAction(rule.id, !rule.active)
                            )
                          }
                          className="rounded-md p-2 text-navy-700 transition hover:bg-navy-50 hover:text-navy-950 disabled:opacity-60"
                        >
                          <Power className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          aria-label="Edit rule"
                          title="Edit rule"
                          onClick={() => {
                            setEditingId(rule.id);
                            setDraft(draftFor(rule));
                            setNotice(null);
                            setConfirmDeleteId(null);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                          className="rounded-md p-2 text-navy-700 transition hover:bg-navy-50 hover:text-navy-950 disabled:opacity-60"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          aria-label="Delete rule"
                          title="Delete rule"
                          onClick={() => setConfirmDeleteId(rule.id)}
                          className="rounded-md p-2 text-navy-700 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
