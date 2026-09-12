/** Wallet amounts cross the database boundary only as integer minor units. */
export function majorToMinor(value: number | string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  const minor = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error('Amount is outside the supported range.');
  }
  return minor;
}

export function minorToMajor(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(amount) ? amount / 100 : 0;
}

export function formatWalletMoney(amountMinor: number, currency = 'BDT'): string {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minorToMajor(amountMinor));
}

