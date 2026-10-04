import type { FareBreakdown } from '@/lib/flights/types';
import {
  priceOffer,
  type MarkupRuleSelection,
  type PricingAudience,
  type PricedOffer,
  type SupplierFarePricing,
} from '@/lib/markup';

type Money = string;
type Passenger = {
  count?: unknown;
  payable?: Money;
  gross?: Money;
  taxes?: Money;
  ait?: Money;
  serviceCharge?: Money;
};
export type ShapontravelsFareBreakdown = {
  currency?: unknown;
  payable?: Money;
  gross?: Money;
  taxes?: Money;
  ait?: Money;
  serviceCharge?: Money;
  passengers?: Record<string, Passenger>;
};

function minor(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  const [whole, fraction] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : null;
}

function major(cents: number): number { return cents / 100; }

/** Normalize supplier payable separately from our locally marked selling price. */
export function shapontravelsPricedOffer(
  breakdown: ShapontravelsFareBreakdown | undefined,
  audience: PricingAudience,
  pricing: { rulesAvailable: boolean; rules: MarkupRuleSelection }
): PricedOffer | null {
  if (breakdown?.currency !== 'BDT') return null;
  const payable = minor(breakdown.payable);
  const gross = minor(breakdown.gross);
  const taxes = minor(breakdown.taxes);
  const ait = minor(breakdown.ait);
  const serviceCharge = minor(breakdown.serviceCharge ?? '0.00');
  if (payable === null || gross === null || taxes === null || ait === null || serviceCharge === null ||
      payable <= 0 || payable < taxes + ait || gross < taxes + ait + serviceCharge) return null;
  if (!breakdown.passengers || typeof breakdown.passengers !== 'object') return null;
  const fares: SupplierFarePricing[] = [];
  let farePayable = 0;
  let fareTaxes = 0;
  let fareAit = 0;
  let fareServiceCharge = 0;
  let fareGross = 0;
  let allPassengerGrossAvailable = true;
  let passengerCount = 0;
  for (const [key, row] of Object.entries(breakdown.passengers)) {
    const type = key.toUpperCase();
    if (!['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(type) || !row || !Number.isSafeInteger(row.count) || Number(row.count) < 0) return null;
    if (Number(row.count) === 0) continue;
    const amount = minor(row.payable);
    const tax = minor(row.taxes);
    const passengerAit = minor(row.ait);
    const passengerServiceCharge = minor(row.serviceCharge ?? '0.00');
    const passengerGross = row.gross === undefined ? null : minor(row.gross);
    if (amount === null || tax === null || passengerAit === null || passengerServiceCharge === null ||
        amount < tax + passengerAit ||
        (row.gross !== undefined && (passengerGross === null || passengerGross < tax + passengerAit + passengerServiceCharge))) return null;
    farePayable += amount;
    fareTaxes += tax;
    fareAit += passengerAit;
    fareServiceCharge += passengerServiceCharge;
    fareGross += passengerGross ?? 0;
    allPassengerGrossAvailable &&= passengerGross !== null;
    passengerCount += Number(row.count);
    fares.push({
      passengerType: type as FareBreakdown['passengerType'],
      count: Number(row.count),
      // Rows are already totals for this passenger type, including its count.
      basePrice: major(Math.max(0, (passengerGross ?? amount) - tax - passengerAit - passengerServiceCharge)),
      taxes: major(tax),
      ait: major(passengerAit),
      serviceCharge: major(passengerServiceCharge),
      supplierTotalPrice: major(amount),
    });
  }
  if (fares.length === 0 || farePayable !== payable || fareTaxes !== taxes || fareAit !== ait ||
      fareServiceCharge !== serviceCharge || (allPassengerGrossAvailable && fareGross !== gross) ||
      !Number.isSafeInteger(passengerCount)) return null;
  return priceOffer({
    audience,
    rulesAvailable: pricing.rulesAvailable,
    rules: pricing.rules,
    supplierTotalPrice: major(payable),
    basePrice: major(gross - taxes - ait - serviceCharge),
    taxes: major(taxes),
    ait: major(ait),
    fares,
    passengerCount,
  });
}
