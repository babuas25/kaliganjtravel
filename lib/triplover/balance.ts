import 'server-only';

import { triploverCall, TriploverError } from '@/lib/triplover/client';

function plainDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;

  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  const decimalPosition = whole.length + Number(exponent);
  if (Math.abs(decimalPosition) > 64) return null;

  const splitAt = Math.max(0, decimalPosition);
  const integer = digits.slice(0, splitAt).padEnd(splitAt, '0');
  const fractional = '0'.repeat(Math.max(0, -decimalPosition)) + digits.slice(splitAt);
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const amount = fractional ? `${sign}${normalizedInteger}.${fractional}` : `${sign}${normalizedInteger}`;
  return amount.length <= 64 ? amount : null;
}

export async function getTriploverBalance() {
  const { data } = await triploverCall('GetByUserId', '/api/User/GetByUserId', undefined, {
    supplier: 'triplover',
    method: 'GET',
    topLevelPayload: true,
    timeoutMs: 10_000,
  });

  const user = data as { currentBalance?: unknown; isSuccess?: unknown };
  const currentBalance = plainDecimal(user.currentBalance);
  if (currentBalance === null || (user.isSuccess !== undefined && user.isSuccess !== true)) {
    throw new TriploverError('protocol', 'TripLover returned an invalid balance.');
  }

  return { current_balance: currentBalance, currency: 'BDT' as const };
}
