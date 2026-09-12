import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { isUserActive } from '@/lib/account-access';
import { canonicalAppOrigin } from '@/lib/app-url';
import { confirmedBookingTicketPdf } from '@/lib/email/booking-ticket-pdf';
import { bookingEmailDocumentFromEventSnapshot } from '@/lib/email/booking-event-snapshot';
import { sendEmail, type EmailMessage } from '@/lib/email/mailer';
import {
  accountCreatedEmail,
  bookingStatusEmail,
  depositRequestConfirmationEmail,
  depositRequestDecisionEmail,
  depositRequestReviewEmail,
  invitationEmail,
  pendingTicketAlertEmail,
  roleChangedEmail,
  welcomeEmail,
} from '@/lib/email/templates';
import { resolveRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase/server';
import type { BookingTraveller, PublicBooking } from '@/lib/flights/booking';
import type { BookingStatus } from '@/lib/flights/booking-status';

const DEPOSIT_REVIEWER_ROLES = new Set(['superadmin', 'admin', 'staff_account']);

const BOOKING_EMAIL_ICON_NAMES = [
  'phone',
  'mail',
  'map-pin',
  'users',
  'plane',
  'receipt',
  'ticket',
] as const;

function bookingEmailAttachments() {
  return [{
    filename: 'kaliganj-logo.png',
    path: path.join(process.cwd(), 'public', 'brand', 'kaliganj-logo.png'),
    cid: 'kaliganj-logo',
  }, ...BOOKING_EMAIL_ICON_NAMES.map((name) => ({
    filename: `${name}.png`,
    path: path.join(process.cwd(), 'public', 'email-icons', `${name}.png`),
    cid: `kaliganj-${name}`,
  }))];
}

export async function sendInvitationEmail(input: {
  to: string;
  invitationId: string;
  roleLabel: string;
}): Promise<void> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const content = invitationEmail({
    roleLabel: input.roleLabel,
    invitationUrl: `${origin}/invite/${encodeURIComponent(input.invitationId)}`,
  });
  await sendEmail({ to: input.to, ...content });
}

export async function sendAccountCreatedEmail(input: {
  to: string;
  firstName: string;
}): Promise<void> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const content = accountCreatedEmail({
    firstName: input.firstName,
    signInUrl: `${origin}/sign-in`,
  });
  await sendEmail({ to: input.to, ...content });
}

export async function sendWelcomeEmail(input: {
  to: string;
  firstName: string;
  userId: string;
}): Promise<void> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const content = welcomeEmail({
    firstName: input.firstName,
    dashboardUrl: `${origin}/dashboard`,
  });
  await sendEmail({
    to: input.to,
    ...content,
    // Clerk retries webhook deliveries after non-2xx responses. Reusing the
    // message ID gives recipient servers a stable de-duplication key.
    messageId: `<welcome-clerk-${input.userId}@kaliganjtravel.com>`,
  });
}

export async function sendRoleChangedEmail(input: {
  to: string;
  firstName: string;
  previousRoleLabel: string;
  nextRoleLabel: string;
}): Promise<void> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const content = roleChangedEmail({
    firstName: input.firstName,
    previousRoleLabel: input.previousRoleLabel,
    nextRoleLabel: input.nextRoleLabel,
    dashboardUrl: `${origin}/dashboard`,
  });
  await sendEmail({ to: input.to, ...content });
}

async function depositReviewerEmails(): Promise<string[]> {
  const client = await clerkClient();
  const recipients = new Set<string>();
  const pageSize = 100;

  for (let offset = 0; ; offset += pageSize) {
    const { data, totalCount } = await client.users.getUserList({
      limit: pageSize,
      offset,
      orderBy: '-created_at',
    });
    for (const user of data) {
      if (!isUserActive(user) || !DEPOSIT_REVIEWER_ROLES.has(resolveRole(user.publicMetadata?.role))) {
        continue;
      }
      const address =
        user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      if (address) recipients.add(address.trim().toLowerCase());
    }
    if (!data.length || offset + data.length >= totalCount) break;
  }

  return Array.from(recipients);
}

function deliveryMessageId(
  kind: 'confirmation' | 'review' | 'approved' | 'rejected',
  requestReference: string,
  email: string
) {
  const reference = requestReference.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const recipientHash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  return `<deposit-${kind}-${reference}-${recipientHash}@kaliganjtravel.com>`;
}

/**
 * Sends the requester confirmation and a separate, privacy-safe alert to
 * every active Super Admin, Admin, and Accounts Staff member. The caller may
 * safely treat delivery as best effort after the deposit record is committed.
 */
export async function sendDepositRequestEmails(input: {
  requesterEmail: string;
  requesterName: string;
  agency?: string | null;
  requestReference: string;
  amount: string;
  paymentMethod: string;
  transactionReference?: string | null;
  depositDate?: string | null;
}): Promise<{ delivered: number; failed: number }> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');

  const details = {
    requestReference: input.requestReference,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
    transactionReference: input.transactionReference,
    depositDate: input.depositDate,
  };
  const requester = input.requesterEmail.trim().toLowerCase();
  const requesterContent = requester
    ? depositRequestConfirmationEmail({
        ...details,
        requesterName: input.requesterName,
        dashboardUrl: `${origin}/dashboard/deposits`,
      })
    : null;
  const reviewerContent = depositRequestReviewEmail({
    ...details,
    requesterName: input.requesterName,
    agency: input.agency,
    dashboardUrl: `${origin}/dashboard/deposits`,
  });

  // A Clerk lookup failure must not suppress the requester confirmation.
  let reviewers: string[] = [];
  let reviewerLookupFailed = false;
  try {
    reviewers = await depositReviewerEmails();
  } catch (error) {
    reviewerLookupFailed = true;
    console.error('[email] deposit reviewer lookup failed:', error);
  }

  const deliveries = [
    ...(requesterContent
      ? [
          sendEmail({
            to: requester,
            ...requesterContent,
            agencyConfirmationCopy: true,
            messageId: deliveryMessageId('confirmation', input.requestReference, requester),
          }),
        ]
      : []),
    ...reviewers.map((to) =>
      sendEmail({
        to,
        ...reviewerContent,
        messageId: deliveryMessageId('review', input.requestReference, to),
      })
    ),
  ];
  const results = await Promise.allSettled(deliveries);
  return {
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failed:
      results.filter((result) => result.status === 'rejected').length +
      (reviewerLookupFailed ? 1 : 0),
  };
}

/** Sends the requester the final result of a completed deposit review. */
export async function sendDepositRequestDecisionEmail(input: {
  requesterUserId: string;
  requestReference: string;
  amount: string;
  paymentMethod: string;
  transactionReference?: string | null;
  depositDate?: string | null;
  decision: 'approved' | 'rejected';
  reviewRemarks?: string | null;
}): Promise<void> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');

  const supabase = supabaseAdmin();
  const userResult = supabase
    ? await supabase
        .from('app_users')
        .select('email, first_name, last_name')
        .eq('clerk_id', input.requesterUserId)
        .maybeSingle()
    : { data: null, error: null };
  if (userResult.error) {
    throw new Error(`The deposit requester email could not be loaded: ${userResult.error.message}`);
  }

  let email = userResult.data?.email?.trim() || '';
  let requesterName = [
    userResult.data?.first_name,
    userResult.data?.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  // The local registry is written on every dashboard visit. Clerk remains a
  // fallback for an older request whose requester has no mirrored email yet.
  if (!email) {
    const client = await clerkClient();
    const user = await client.users.getUser(input.requesterUserId);
    email =
      user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? '';
    requesterName =
      requesterName ||
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
      user.username ||
      '';
  }
  if (!email) throw new Error('The deposit requester has no email address.');
  const content = depositRequestDecisionEmail({
    requestReference: input.requestReference,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
    transactionReference: input.transactionReference,
    depositDate: input.depositDate,
    requesterName: requesterName || 'there',
    decision: input.decision,
    reviewRemarks: input.reviewRemarks,
    dashboardUrl: `${origin}/dashboard/deposits`,
  });
  const recipient = email.toLowerCase();
  await sendEmail({
    to: recipient,
    ...content,
    agencyConfirmationCopy: true,
    messageId: deliveryMessageId(input.decision, input.requestReference, recipient),
  });
}

export async function sendBookingStatusNotification(input: {
  recipients: string[];
  status: BookingStatus;
  booking: PublicBooking;
  travellers: BookingTraveller[];
}): Promise<{ delivered: number; failed: number }> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const booking = { ...input.booking, status: input.status };
  const content = bookingStatusEmail(
    {
      booking,
      travellers: input.travellers,
      bookingUrl: `${origin}/dashboard/bookings/${encodeURIComponent(booking.publicRef)}`,
    },
    input.status
  );
  const recipients = Array.from(
    new Set(input.recipients.map((email) => email.trim().toLowerCase()))
  ).filter(Boolean);
  const attachments: NonNullable<EmailMessage['attachments']> =
    bookingEmailAttachments();
  if (input.status === 'confirmed') {
    attachments.push({
      filename: `${booking.publicRef}-ticket.pdf`,
      content: await confirmedBookingTicketPdf({
        booking,
        travellers: input.travellers,
      }),
      contentType: 'application/pdf',
      contentDisposition: 'attachment',
    });
  }
  const results = await Promise.allSettled(
    recipients.map((to) =>
      sendEmail({
        to,
        ...content,
        agencyConfirmationCopy: input.status === 'on-hold' || input.status === 'confirmed',
        messageId: `<booking-${input.status}-${booking.publicRef}-${to.replace(/[^a-z0-9]/g, '-')}@kaliganjtravel.com>`,
        attachments,
      })
    )
  );
  return {
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

/** Sends one independently claimed visible recipient for one event occurrence. */
export async function sendBookingStatusEventDelivery(input: {
  to: string;
  status: BookingStatus;
  occurrenceId: string;
  recipientAddressHash: string;
  eventSnapshot: unknown;
  content: { subject: string; html: string; text: string };
}): Promise<void> {
  const attachments: NonNullable<EmailMessage['attachments']> =
    bookingEmailAttachments();
  if (input.status === 'confirmed') {
    const document = bookingEmailDocumentFromEventSnapshot(
      input.eventSnapshot,
      input.status
    );
    attachments.push({
      filename: `${document.booking.publicRef}-ticket.pdf`,
      content: await confirmedBookingTicketPdf(document),
      contentType: 'application/pdf',
      contentDisposition: 'attachment',
    });
  }
  await sendEmail({
    to: input.to,
    ...input.content,
    agencyConfirmationCopy: input.status === 'on-hold' || input.status === 'confirmed',
    messageId: `<booking-event-${input.occurrenceId}-${input.recipientAddressHash}@kaliganjtravel.com>`,
    attachments,
  });
}

export async function sendPendingTicketAlerts(input: {
  bookingReference: string;
  pnr: string;
  amountMinor: number;
  currency: string;
  supplierReason: string;
}): Promise<{ delivered: number; failed: number }> {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');

  const client = await clerkClient();
  const recipients = new Set<string>();
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data, totalCount } = await client.users.getUserList({
      limit: pageSize,
      offset,
      orderBy: '-created_at',
    });
    for (const user of data) {
      if (!isUserActive(user) || resolveRole(user.publicMetadata?.role) !== 'superadmin') continue;
      const address = user.primaryEmailAddress?.emailAddress
        ?? user.emailAddresses[0]?.emailAddress;
      if (address) recipients.add(address.trim().toLowerCase());
    }
    if (!data.length || offset + data.length >= totalCount) break;
  }
  if (recipients.size === 0) throw new Error('No active Super Admin email recipients were found.');

  const amount = new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency: input.currency,
    minimumFractionDigits: 2,
  }).format(input.amountMinor / 100);
  const content = pendingTicketAlertEmail({
    bookingReference: input.bookingReference,
    pnr: input.pnr,
    amount,
    supplierReason: input.supplierReason,
    bookingUrl: `${origin}/dashboard/bookings/${encodeURIComponent(input.bookingReference)}`,
  });
  const results = await Promise.allSettled(
    Array.from(recipients).map((to) => sendEmail({ to, ...content }))
  );
  return {
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}
