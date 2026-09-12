import { getDashboardSession } from '@/lib/dashboard/session';
import { listTicketManagementFinancialAssignees } from '@/lib/db/ticket-management';
import {
  ticketManagementFail,
  ticketManagementOk,
} from '@/lib/ticket-management/http';
import { canAssignTicketManagementSettlement } from '@/lib/ticket-management/permissions';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
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
  if (!canAssignTicketManagementSettlement(session.role)) {
    return ticketManagementFail(
      403,
      'ASSIGNMENT_FORBIDDEN',
      'Settlement assignment access is required.'
    );
  }
  try {
    return ticketManagementOk(await listTicketManagementFinancialAssignees());
  } catch (error) {
    console.error('[ticket-management] assignees failed:', error);
    return ticketManagementFail(
      503,
      'ASSIGNEES_UNAVAILABLE',
      'Financial assignees are temporarily unavailable.'
    );
  }
}
