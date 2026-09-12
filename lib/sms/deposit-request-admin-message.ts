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

function depositAmount(amountMinorValue: unknown): string {
  const amountMinor = typeof amountMinorValue === 'number'
    ? amountMinorValue
    : Number(cleanText(amountMinorValue));
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error('Deposit request SMS amount is invalid.');
  }
  return (amountMinor / 100).toLocaleString('en-US', {
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** Builds the static-admin alert for a newly submitted B2B deposit request. */
export function depositRequestAdminSmsMessage(value: unknown): string {
  const snapshot = record(value);
  if (!snapshot || snapshot.version !== 1) {
    throw new Error('Deposit request admin SMS snapshot is invalid.');
  }
  const agencyName = cleanText(snapshot.agencyName) || 'Unknown Agency';
  const paymentMethod = cleanText(snapshot.paymentMethod) || 'Unknown';
  const currency = cleanText(snapshot.currency).toUpperCase() || 'BDT';
  return [
    'Deposit Request Received',
    'Dear Admin,',
    'A new deposit request has been submitted.',
    `Agency Name: ${agencyName}`,
    `Payment Method: ${paymentMethod}`,
    `Deposit Amount: ${depositAmount(snapshot.amountMinor)} ${currency}`,
    'Please log in to your OTA portal to review and approve the transaction.',
  ].join('\n');
}
