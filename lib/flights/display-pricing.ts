import type { FlightFareOption } from '@/lib/flights/types';

/**
 * An LCC service margin may make the agency's actual payable amount higher
 * than the supplier gross. Showing that lower gross as the card price would
 * advertise an amount the agency cannot pay, so the payable becomes primary.
 *
 * This is presentation logic only. Pricing calculations and snapshots remain
 * authoritative in the markup engine.
 */
export function agencyPayableExceedsGross(option: FlightFareOption): boolean {
  return Boolean(
    option.serviceMargin > 0 &&
      option.agencyPricing &&
      option.agencyPricing.agentFare > option.agencyPricing.grossPrice
  );
}

/** Price used by result-level UI such as airline minimum-price tabs. */
export function resultDisplayPrice(
  option: FlightFareOption,
  showAuditFares: boolean,
  showAgencyFares: boolean
): number {
  if (showAuditFares && option.auditPricing) {
    return option.auditPricing.grossPrice;
  }
  if (showAgencyFares && option.agencyPricing) {
    return agencyPayableExceedsGross(option)
      ? option.agencyPricing.agentFare
      : option.agencyPricing.grossPrice;
  }
  return option.totalPrice;
}
