export type DuplicateBookingWarning = {
  code: 'SUPPLIER_DUPLICATE_REPORTED';
  title: string;
  message: string;
  currentRequestReference: string | null;
  existingBookingReference: null;
  action: 'contact_support';
  actionLabel: string;
};

/** Decode only our durable, sanitized Book error; never render raw supplier text. */
export function duplicateBookingWarning(supplierMessage?: unknown): DuplicateBookingWarning | null {
  if (typeof supplierMessage !== 'string') return null;
  const match = /^Shapontravels Book BOOKING_OUTCOME_UNKNOWN bookingId=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?: reference=(STR[A-Z0-9]{6,32}))? warning=SUPPLIER_DUPLICATE_REPORTED$/.exec(supplierMessage);
  if (!match) return null;
  return {
    code: 'SUPPLIER_DUPLICATE_REPORTED',
    title: 'Supplier Reported a Duplicate Booking',
    message: 'The supplier reported an existing booking for this passenger but did not provide its reference. Please contact support before booking again.',
    currentRequestReference: match[1] ?? null,
    existingBookingReference: null,
    action: 'contact_support',
    actionLabel: 'Contact Support',
  };
}

/** Only allowlisted supplier reasons become customer-facing text. */
export function unverifiedBookingMessage(supplierMessage?: unknown, allowDuplicateWarning = false): string {
  const warning = allowDuplicateWarning ? duplicateBookingWarning(supplierMessage) : null;
  if (warning) {
    return `${warning.title}. ${warning.message}` +
      (warning.currentRequestReference ? ` Current request reference: ${warning.currentRequestReference}.` : '');
  }
  if (typeof supplierMessage === 'string' &&
      /^Unable to Satisfy,\s*Need Confirmed Flight Status\.?$/i.test(supplierMessage.trim())) {
    return 'The supplier could not confirm the selected flight. The booking outcome is unverified. Do not submit again; contact support.';
  }
  return 'The booking outcome could not be verified. Do not submit again; contact support.';
}
