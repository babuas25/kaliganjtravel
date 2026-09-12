import type { BookingPassengerType } from '@/lib/flights/booking';
import type { SupplierFarePricing } from '@/lib/markup';

type UnknownRecord = Record<string, unknown>;

type NormalizedFare = SupplierFarePricing & { discount: number };

type PassengerFare = Omit<NormalizedFare, 'serviceCharge'> & {
  serviceCharge: number | null;
};

export class SupplierFareReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierFareReconciliationError';
  }
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function rows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function passengerType(value: unknown): BookingPassengerType | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(normalized)
    ? (normalized as BookingPassengerType)
    : null;
}

function strictMoney(value: unknown, label: string, allowNegative = false): number {
  const parsed = typeof value === 'number' ? value :
    typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0)) {
    throw new SupplierFareReconciliationError(
      `Supplier booking has an invalid ${label}.`,
    );
  }
  return Math.round(parsed * 100) / 100;
}

function minor(value: number): number {
  return Math.round(value * 100);
}

function nonZero(value: unknown): boolean {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) >= 0.005;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SupplierFareReconciliationError(
      `Supplier booking has an invalid ${label}.`,
    );
  }
  return parsed;
}

function assertNoUnsupportedCharges(row: UnknownRecord, label: string): void {
  if (
    nonZero(row.agentAdditionalPrice) || nonZero(row.additionalCollection) ||
    nonZero(row.reissueCharge) || nonZero(row.extraBaggageCharge)
  ) {
    throw new SupplierFareReconciliationError(
      `${label} contains an unsupported additional price, collection, reissue, or ancillary charge.`,
    );
  }
}

function commonFare(row: UnknownRecord, label: string) {
  const type = passengerType(row.passengerType);
  if (!type) {
    throw new SupplierFareReconciliationError(
      `${label} has an unsupported passenger type.`,
    );
  }
  const count = positiveInteger(row.passengerCount, `${label} passenger count`);
  const basePrice = strictMoney(row.basePrice, `${label} base fare`);
  const taxes = strictMoney(row.tax ?? row.taxes, `${label} tax`);
  const ait = strictMoney(row.ait, `${label} AIT`);
  const supplierTotalPrice = strictMoney(row.totalPrice, `${label} total`);
  const discount = strictMoney(row.discount, `${label} discount`, true);
  assertNoUnsupportedCharges(row, label);
  return {
    passengerType: type,
    count,
    basePrice,
    taxes,
    ait,
    supplierTotalPrice,
    discount,
  };
}

function signedDiscount(
  gross: number,
  total: number,
  reportedDiscount: number,
  label: string,
): number {
  const grossMinor = minor(gross);
  const totalMinor = minor(total);
  if (grossMinor + minor(reportedDiscount) === totalMinor) {
    return reportedDiscount;
  }
  if (
    reportedDiscount > 0 &&
    grossMinor - minor(reportedDiscount) === totalMinor
  ) {
    return -reportedDiscount;
  }
  throw new SupplierFareReconciliationError(
    `${label} does not reconcile base, tax, AIT, service charge, discount, and total.`,
  );
}

function authoritativeFare(row: UnknownRecord, label: string): NormalizedFare {
  const fare = commonFare(row, label);
  const serviceCharge = strictMoney(
    row.serviceCharge,
    `${label} service charge`,
  );
  const discount = signedDiscount(
    fare.basePrice + fare.taxes + fare.ait + serviceCharge,
    fare.supplierTotalPrice,
    fare.discount,
    label,
  );
  return { ...fare, serviceCharge, discount };
}

function passengerFare(row: UnknownRecord, label: string): PassengerFare {
  const fare = commonFare(row, label);
  const serviceCharge = Object.prototype.hasOwnProperty.call(row, 'serviceCharge')
    ? strictMoney(row.serviceCharge, `${label} service charge`)
    : null;
  const discount = serviceCharge === null
    ? fare.discount
    : signedDiscount(
        fare.basePrice + fare.taxes + fare.ait + serviceCharge,
        fare.supplierTotalPrice,
        fare.discount,
        label,
      );
  return { ...fare, serviceCharge, discount };
}

function sum<T extends object>(items: readonly T[], key: keyof T): number {
  return items.reduce((total, item) => total + Number(item[key]), 0);
}

function assertSameMinor(
  passengerValue: number,
  authoritativeValue: number,
  label: string,
): void {
  if (minor(passengerValue) !== minor(authoritativeValue)) {
    throw new SupplierFareReconciliationError(
      `Supplier passenger fares and fare breakdown disagree on ${label}.`,
    );
  }
}

export function reconcileSupplierFares(input: {
  fareBreakdown: unknown;
  passengers: unknown;
  payable: number;
}): {
  supplierFares: SupplierFarePricing[];
  supplierGross: number;
  supplierDiscount: number;
} {
  const fareRows = rows(input.fareBreakdown);
  if (fareRows.length === 0) {
    throw new SupplierFareReconciliationError(
      'Supplier booking has no authoritative fare breakdown.',
    );
  }
  const passengerRows = rows(input.passengers);
  if (passengerRows.length === 0) {
    throw new SupplierFareReconciliationError(
      'Supplier booking has no passenger fare evidence.',
    );
  }

  const reportFares = fareRows.map((row, index) =>
    authoritativeFare(row, `Fare breakdown ${index + 1}`));
  const passengerFares = passengerRows.map((row, index) =>
    passengerFare(row, `Passenger fare ${index + 1}`));
  const passengerServiceChargePresence = passengerFares.map(
    (fare) => fare.serviceCharge !== null,
  );
  const passengerServiceChargesPresent = passengerServiceChargePresence.every(Boolean);
  if (
    !passengerServiceChargesPresent &&
    passengerServiceChargePresence.some(Boolean)
  ) {
    throw new SupplierFareReconciliationError(
      'Supplier passenger service charge evidence is only partially present.',
    );
  }

  const order: BookingPassengerType[] = ['ADT', 'CHD', 'CNN', 'INF', 'INS'];
  for (const type of order) {
    const passengersOfType = passengerFares.filter(
      (fare) => fare.passengerType === type,
    );
    const reportsOfType = reportFares.filter(
      (fare) => fare.passengerType === type,
    );
    if (passengersOfType.length === 0 && reportsOfType.length === 0) continue;
    if (passengersOfType.length === 0 || reportsOfType.length === 0) {
      throw new SupplierFareReconciliationError(
        `Supplier passenger fares and fare breakdown disagree on passenger type ${type}.`,
      );
    }
    for (const [key, label] of [
      ['count', 'count'],
      ['basePrice', 'basePrice'],
      ['taxes', 'taxes'],
      ['ait', 'ait'],
      ['supplierTotalPrice', 'supplierTotalPrice'],
    ] as const) {
      assertSameMinor(
        sum(passengersOfType, key),
        sum(reportsOfType, key),
        label,
      );
    }
    const authoritativeServiceCharge = sum(reportsOfType, 'serviceCharge');
    const passengerDiscount = passengerServiceChargesPresent
      ? sum(passengersOfType, 'discount')
      : signedDiscount(
          sum(passengersOfType, 'basePrice') +
            sum(passengersOfType, 'taxes') +
            sum(passengersOfType, 'ait') +
            authoritativeServiceCharge,
          sum(passengersOfType, 'supplierTotalPrice'),
          sum(passengersOfType, 'discount'),
          `Passenger fares for ${type}`,
        );
    assertSameMinor(
      passengerDiscount,
      sum(reportsOfType, 'discount'),
      'discount',
    );
    if (passengerServiceChargesPresent) {
      assertSameMinor(
        sum(passengersOfType, 'serviceCharge'),
        authoritativeServiceCharge,
        'serviceCharge',
      );
    } else {
      assertSameMinor(
        sum(passengersOfType, 'basePrice') +
          sum(passengersOfType, 'taxes') +
          sum(passengersOfType, 'ait') +
          authoritativeServiceCharge +
          passengerDiscount,
        sum(passengersOfType, 'supplierTotalPrice'),
        `serviceCharge-derived total for ${type}`,
      );
    }
  }

  const supplierPayable = sum(reportFares, 'supplierTotalPrice');
  if (minor(supplierPayable) !== minor(input.payable)) {
    throw new SupplierFareReconciliationError(
      'Supplier passenger/type fares do not reconcile to the authoritative ticketing payable.',
    );
  }

  const supplierFares = order.flatMap((type): SupplierFarePricing[] => {
    const matching = reportFares.filter((fare) => fare.passengerType === type);
    if (matching.length === 0) return [];
    return [{
      passengerType: type,
      count: sum(matching, 'count'),
      basePrice: sum(matching, 'basePrice'),
      taxes: sum(matching, 'taxes'),
      ait: sum(matching, 'ait'),
      serviceCharge: sum(matching, 'serviceCharge'),
      supplierTotalPrice: sum(matching, 'supplierTotalPrice'),
    }];
  });
  return {
    supplierFares,
    supplierGross: sum(reportFares, 'basePrice') +
      sum(reportFares, 'taxes') + sum(reportFares, 'ait') +
      sum(reportFares, 'serviceCharge'),
    supplierDiscount: sum(reportFares, 'discount'),
  };
}
