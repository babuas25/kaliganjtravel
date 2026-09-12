import 'server-only';

import type { clerkClient } from '@clerk/nextjs/server';

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

const SESSION_PAGE_SIZE = 100;
const MAX_REVOCATION_PASSES = 20;

/**
 * Ends every active Clerk session for a user.
 *
 * The first page is read repeatedly at offset zero because revoking a session
 * changes the collection as it is being paged. The bound prevents a broken
 * backend response from turning a status change into an unbounded request.
 */
export async function revokeActiveUserSessions(
  client: ClerkClient,
  clerkId: string
): Promise<void> {
  for (let pass = 0; pass < MAX_REVOCATION_PASSES; pass += 1) {
    const { data } = await client.sessions.getSessionList({
      userId: clerkId,
      status: 'active',
      limit: SESSION_PAGE_SIZE,
      offset: 0,
    });

    if (!data.length) return;

    const results = await Promise.allSettled(
      data.map((session) => client.sessions.revokeSession(session.id))
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }

  throw new Error('Too many active sessions to revoke safely.');
}
