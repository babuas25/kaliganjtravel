import type { FareBreakdown } from '@/lib/flights/types';
import type { PricingAudience, PricedOffer } from '@/lib/markup';

type Money = string;
type Passenger = { count?: unknown; payable?: Money; taxes?: Money; ait?: Money };
export type ShapontravelsFareBreakdown = {
  currency?: unknown;
  payable?: Money;
  gross?: Money;
  taxes?: Money;
  ait?: Money;
  passengers?: Record<string, Passenger>;
};

function minor(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  const [whole, fraction] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : null;
}

function major(cents: number): number { return cents / 100; }

/** The machine client's payable is already its final selling price. */
export function shapontravelsPricedOffer(
  breakdown: ShapontravelsFareBreakdown | undefined,
  audience: PricingAudience
): PricedOffer | null {
  if (breakdown?.currency !== 'BDT') return null;
  const payable = minor(breakdown.payable);
  const gross = minor(breakdown.gross);
  const taxes = minor(breakdown.taxes);
  const ait = minor(breakdown.ait);
  if (payable === null || gross === null || taxes === null || ait === null || payable <= 0 || payable < taxes + ait) return null;
  if (!breakdown.passengers || typeof breakdown.passengers !== 'object') return null;
  const fares: FareBreakdown[] = [];
  let farePayable = 0;
  let fareTaxes = 0;
  let fareAit = 0;
  for (const [key, row] of Object.entries(breakdown.passengers)) {
    const type = key.toUpperCase();
    if (!['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(type) || !row || !Number.isInteger(row.count) || Number(row.count) < 0) return null;
    if (Number(row.count) === 0) continue;
    const amount = minor(row.payable);
    const tax = minor(row.taxes);
    const passengerAit = minor(row.ait);
    if (amount === null || tax === null || passengerAit === null || amount < tax + passengerAit) return null;
    farePayable += amount;
    fareTaxes += tax;
    fareAit += passengerAit;
    fares.push({
      passengerType: type as FareBreakdown['passengerType'],
      count: Number(row.count),
      basePrice: major(amount - tax - passengerAit),
      taxes: major(tax),
      ait: major(passengerAit),
      serviceMargin: 0,
      totalPrice: major(amount),
    });
  }
  if (fares.length === 0 || farePayable !== payable || fareTaxes !== taxes || fareAit !== ait) return null;
  return {
    totalPrice: major(payable),
    basePrice: major(payable - taxes - ait),
    taxes: major(taxes),
    ait: major(ait),
    serviceMargin: 0,
    fares,
    snapshot: {
      audience: audience.kind,
      agencyCode: audience.kind === 'agency' ? audience.agencyCode : null,
      basis: 'supplier',
      supplierTotalPrice: major(payable),
      grossPrice: major(gross),
      availableMargin: major(Math.max(0, gross - payable)),
      requestedMarkupAmount: 0,
      markupAmount: 0,
      serviceMarginAmount: 0,
      sellingPrice: major(payable),
      grossCapApplied: false,
      discountFloorApplied: false,
      lccServiceMargin: false,
      ruleId: null,
      markupType: null,
      markupValue: null,
    },
  };
}
