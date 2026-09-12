import { NextRequest } from 'next/server';
import { z } from 'zod';

import { expireTicketManagementQuotes } from '@/lib/db/ticket-management';
import {
  ticketManagementFail,
  ticketManagementOk,
  ticketManagementResultResponse,
} from '@/lib/ticket-management/http';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return ticketManagementFail(
      503,
      'SCHEDULER_NOT_CONFIGURED',
      'Ticket Management expiry is not configured.'
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return ticketManagementFail(401, 'UNAUTHORIZED', 'Unauthorized.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management expiry is not enabled.'
    );
  }
  const parsedLimit = z.coerce.number().int().min(1).max(1000).safeParse(
    request.nextUrl.searchParams.get('limit') ?? 200
  );
  if (!parsedLimit.success) {
    return ticketManagementFail(400, 'INVALID_LIMIT', 'Invalid expiry limit.');
  }
  const result = await expireTicketManagementQuotes(parsedLimit.data);
  return result.ok
    ? ticketManagementOk(result)
    : ticketManagementResultResponse(result);
}
