import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';

import { sendEmail } from '@/lib/email/mailer';
import { sendWelcomeEmail } from '@/lib/email/notifications';

export const runtime = 'nodejs';

/**
 * Relays Clerk-generated authentication content through our Zoho transport.
 * Clerk still owns the verification token; it no longer owns delivery once
 * "Delivered by Clerk" is disabled for the corresponding template.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request);
  } catch (error) {
    console.error('[email] rejected invalid Clerk webhook:', error);
    return new Response('Invalid webhook signature.', { status: 400 });
  }

  if (event.type === 'email.created') {
    const email = event.data;
    // Clerk emits the event for its own deliveries too. Relaying those would
    // create duplicates during setup or if a template is switched back on.
    if (email.delivered_by_clerk) {
      return new Response('Already delivered by Clerk.', { status: 200 });
    }
    if (!email.to_email_address || !email.subject || !email.body) {
      console.error('[email] Clerk webhook is missing recipient or content:', email.id);
      return new Response('Incomplete email payload.', { status: 422 });
    }

    try {
      await sendEmail({
        to: email.to_email_address,
        subject: email.subject,
        html: email.body,
        text: email.body_plain || email.subject,
        messageId: `<clerk-${email.id}@kaliganjtravel.com>`,
      });
      return new Response('Delivered.', { status: 200 });
    } catch (error) {
      console.error('[email] Clerk email relay failed:', email.id, error);
      // A non-2xx response asks Clerk's webhook delivery service to retry.
      return new Response('Email delivery failed.', { status: 503 });
    }
  }

  if (event.type === 'user.created') {
    const user = event.data;
    // Admin-created accounts already receive a purpose-built notice from the
    // dashboard action, so do not send a second welcome message for them.
    if (user.private_metadata?.provisioningSource === 'admin') {
      return new Response('Admin-created account already notified.', { status: 200 });
    }

    const primaryEmail =
      user.email_addresses.find(
        (address) => address.id === user.primary_email_address_id
      )?.email_address ?? user.email_addresses[0]?.email_address;

    if (!primaryEmail) {
      console.error('[email] new Clerk user has no email address:', user.id);
      return new Response('New user has no email address.', { status: 422 });
    }

    try {
      await sendWelcomeEmail({
        to: primaryEmail,
        firstName: user.first_name || '',
        userId: user.id,
      });
      return new Response('Welcome email delivered.', { status: 200 });
    } catch (error) {
      console.error('[email] welcome email failed:', user.id, error);
      return new Response('Welcome email delivery failed.', { status: 503 });
    }
  }

  return new Response('Ignored.', { status: 200 });
}
