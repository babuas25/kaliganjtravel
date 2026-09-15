/** Only allowlisted supplier reasons become customer-facing text. */
export function unverifiedBookingMessage(supplierMessage?: unknown): string {
  if (typeof supplierMessage === 'string' &&
      /^Unable to Satisfy,\s*Need Confirmed Flight Status\.?$/i.test(supplierMessage.trim())) {
    return 'The supplier could not confirm the selected flight. The booking outcome is unverified. Do not submit again; contact support.';
  }
  return 'The booking outcome could not be verified. Do not submit again; contact support.';
}
