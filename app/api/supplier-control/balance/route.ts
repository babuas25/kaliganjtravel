import { type NextRequest, NextResponse } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { checkActionLimit } from '@/lib/rate-limit';
import { getShapontravelsBalance } from '@/lib/shapontravels/balance';
import { ShapontravelsReadError } from '@/lib/shapontravels/client';
import { getTriploverBalance } from '@/lib/triplover/balance';
import { TriploverError } from '@/lib/triplover/client';

export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return reply({ error: 'Authentication required.' }, 401);
  if (session.role !== 'superadmin') return reply({ error: 'Super Admin access is required.' }, 403);

  const supplier = request.nextUrl.searchParams.get('supplier') ?? 'triplover';
  if (supplier !== 'triplover' && supplier !== 'shapontravels') {
    return reply({ error: 'Unsupported balance supplier.' }, 400);
  }

  const limit = await checkActionLimit('viewSupplierBalance', `${session.clerkId}:${supplier}`);
  if (!limit.ok) {
    return reply({ error: 'Too many balance requests.' }, 429, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  try {
    const balance = supplier === 'triplover' ? await getTriploverBalance() : await getShapontravelsBalance();
    return reply(balance);
  } catch (error) {
    const unconfigured = (error instanceof TriploverError && error.kind === 'unconfigured') ||
      (error instanceof ShapontravelsReadError &&
        (error.code === 'NOT_CONFIGURED' || error.code === 'INVALID_CONFIGURATION'));
    if (unconfigured) return reply({ error: 'Supplier is not configured.' }, 503);

    const timedOut = error instanceof TriploverError && error.diagnostic?.transport === 'timeout';
    return reply({ error: 'Supplier balance could not be loaded.' }, timedOut ? 504 : 502);
  }
}
