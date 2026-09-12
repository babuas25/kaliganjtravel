import 'server-only';

export const TICKET_MANAGEMENT_ROLLOUT_ENV =
  'TICKET_MANAGEMENT_ENABLED' as const;

/**
 * Ticket Management is visible by default during local development so its UI
 * can be reviewed without maintaining a private env override. Production is a
 * financial workflow and therefore fails closed unless explicitly enabled.
 */
export function ticketManagementRolloutEnabled(): boolean {
  const configured = process.env[TICKET_MANAGEMENT_ROLLOUT_ENV]?.trim();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
