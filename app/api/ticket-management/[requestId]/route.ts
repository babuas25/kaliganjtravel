import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { readTicketManagementRequestDetail } from '@/lib/db/ticket-management';
import {
  ticketManagementFail,
  ticketManagementOk,
} from '@/lib/ticket-management/http';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> }
) {
  const session = await getDashboardSession();
  if (!session) {
    return ticketManagementFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management is not enabled.'
    );
  }
  if (session.role === 'staff_media') {
    return ticketManagementFail(
      403,
      'TICKET_MANAGEMENT_READ_FORBIDDEN',
      'Ticket Management access is required.'
    );
  }
  const parsedId = requestIdSchema.safeParse((await context.params).requestId);
  if (!parsedId.success) {
    return ticketManagementFail(400, 'INVALID_REQUEST_ID', 'Invalid request ID.');
  }
  try {
    const detail = await readTicketManagementRequestDetail(parsedId.data, {
      clerkId: session.clerkId,
      role: session.role,
      agencyCode: session.agencyCode,
    });
    return detail
      ? ticketManagementOk(detail)
      : ticketManagementFail(404, 'REQUEST_NOT_FOUND', 'Request not found.');
  } catch (error) {
    console.error('[ticket-management] detail failed:', error);
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_READ_UNAVAILABLE',
      'The request is temporarily unavailable.'
    );
  }
}
