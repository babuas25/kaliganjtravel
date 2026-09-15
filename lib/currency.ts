/** Booking prices, fixed markups and wallet amounts currently use BDT only. */
export const BOOKING_CURRENCY = 'BDT';
export const UNSUPPORTED_CURRENCY_MESSAGE =
  'Only BDT is supported. Currency conversion is not available.';

export class UnsupportedCurrencyError extends Error {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor() {
    super(UNSUPPORTED_CURRENCY_MESSAGE);
    this.name = 'UnsupportedCurrencyError';
  }
}

export function isBookingCurrency(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === BOOKING_CURRENCY;
}

/**
 * Supplier contracts allow an omitted currency to mean BDT. Check every
 * reported currency so a BDT alias cannot hide a conflicting amount currency.
 * This validates the denomination; it never converts or relabels foreign money.
 */
export function currencyForBdtContract(...values: unknown[]): typeof BOOKING_CURRENCY {
  for (const value of values) {
    if (value === null || value === undefined ||
        (typeof value === 'string' && !value.trim())) continue;
    if (!isBookingCurrency(value)) throw new UnsupportedCurrencyError();
  }
  return BOOKING_CURRENCY;
}
