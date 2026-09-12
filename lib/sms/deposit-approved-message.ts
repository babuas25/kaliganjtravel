type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function approvedAmount(currencyValue: unknown, amountMinorValue: unknown): string {
  const currency = cleanText(currencyValue).toUpperCase() || 'BDT';
  const amountMinor = typeof amountMinorValue === 'number'
    ? amountMinorValue
    : Number(cleanText(amountMinorValue));
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error('Deposit approval SMS amount is invalid.');
  }
  return `${currency}- ${(amountMinor / 100).toLocaleString('en-US', {
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Builds the B2B partner confirmation after an approved wallet credit. */
export function depositApprovedSmsMessage(value: unknown): string {
  const snapshot = record(value);
  if (!snapshot || snapshot.version !== 1) {
    throw new Error('Deposit approval SMS snapshot is invalid.');
  }
  const amount = approvedAmount(snapshot.currency, snapshot.amountMinor);
  return [
    'Dear Client,',
    `your payment request for ${amount} has been Approved. Your account on our platform has been credited with the funds.`,
    '',
    'Thank you for being with us.',
    'Enjoy Booking!',
  ].join('\n');
}
