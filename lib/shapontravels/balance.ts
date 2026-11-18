import 'server-only';

import { z } from 'zod';

import { shapontravelsRead, ShapontravelsReadError } from '@/lib/shapontravels/client';

const walletBalance = z.object({
  currency: z.literal('BDT'),
  scale: z.literal(2),
  availableMinor: z.string().regex(/^-?(?:0|[1-9]\d{0,18})(?![\s\S])/),
});

export async function getShapontravelsBalance() {
  const parsed = walletBalance.safeParse(await shapontravelsRead('WalletBalance'));
  if (!parsed.success) throw new ShapontravelsReadError('INVALID_WALLET_BALANCE');

  const { currency, scale, availableMinor } = parsed.data;
  const negative = availableMinor.startsWith('-');
  const digits = (negative ? availableMinor.slice(1) : availableMinor).padStart(scale + 1, '0');
  const amount = `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return { current_balance: amount, currency };
}
