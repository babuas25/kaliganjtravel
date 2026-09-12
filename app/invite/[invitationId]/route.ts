import { clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

const PAGE_SIZE = 100;
const INVITATION_ID = /^inv_[A-Za-z0-9]+$/;

/**
 * Keeps invitation emails on the site's own domain without exposing Clerk's
 * very long ticket URL. The opaque invitation id is resolved server-side and
 * only while the invitation remains pending.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ invitationId: string }> }
): Promise<Response> {
  const { invitationId } = await context.params;
  const unavailable = new URL('/sign-up?invitation=unavailable', request.url);
  if (!INVITATION_ID.test(invitationId)) {
    return Response.redirect(unavailable, 303);
  }

  try {
    const client = await clerkClient();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, totalCount } =
        await client.invitations.getInvitationList({
          status: 'pending',
          limit: PAGE_SIZE,
          offset,
        });
      const invitation = data.find((row) => row.id === invitationId);
      if (invitation?.url) {
        const destination = new URL(invitation.url);
        if (destination.protocol !== 'https:') {
          throw new Error('Invitation URL did not use HTTPS.');
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: destination.toString(),
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          },
        });
      }
      if (!data.length || offset + data.length >= totalCount) break;
    }
  } catch (error) {
    console.error('[email] invitation link resolution failed:', invitationId, error);
  }

  return Response.redirect(unavailable, 303);
}
