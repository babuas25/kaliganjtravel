import 'server-only';

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export {
  bookingConfirmationEmail,
  bookingStatusEmail,
  confirmedBookingEmail,
} from '@/lib/email/booking-template';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function layout(input: {
  preheader: string;
  eyebrow: string;
  title: string;
  intro: string;
  buttonLabel: string;
  buttonUrl: string;
  footer: string;
  details?: ReadonlyArray<{ label: string; value: string }>;
}): string {
  const preheader = escapeHtml(input.preheader);
  const eyebrow = escapeHtml(input.eyebrow);
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const buttonLabel = escapeHtml(input.buttonLabel);
  const buttonUrl = escapeHtml(input.buttonUrl);
  const details = (input.details ?? [])
    .filter((detail) => detail.label.trim() && detail.value.trim())
    .map(
      (detail, index, all) => `<tr>
        <td style="padding:12px 16px;color:#6b7280;font-size:12px;border-bottom:${index === all.length - 1 ? '0' : '1px solid #e5e5e5'}">${escapeHtml(detail.label)}</td>
        <td align="right" style="padding:12px 16px;color:#262626;font-size:14px;font-weight:700;border-bottom:${index === all.length - 1 ? '0' : '1px solid #e5e5e5'}">${escapeHtml(detail.value)}</td>
      </tr>`
    )
    .join('');
  const detailsHtml = details
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;border:1px solid #e5e5e5;border-radius:10px;background:#faf9f6">${details}</table>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;background:#f7f5f2;color:#111827;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f5f2;padding:32px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e5e5;border-radius:4px;overflow:hidden">
          <tr><td style="height:8px;background:#f68712;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="background:#262626;padding:24px 32px;color:#ffffff;font-size:22px;font-weight:700">Kaliganj Travels<div style="margin-top:8px;color:#f0e8df;font-size:10px;font-weight:400;letter-spacing:2px">YOUR JOURNEY, OUR LOCAL KNOW-HOW</div></td></tr>
          <tr><td style="padding:34px 32px">
            <div style="color:#ad4f08;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">${eyebrow}</div>
            <h1 style="margin:10px 0 16px;font-size:26px;line-height:1.25;color:#262626">${title}</h1>
            <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.65">${intro}</p>
            ${detailsHtml}
            <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:4px;background:#f68712">
              <a href="${buttonUrl}" style="display:inline-block;padding:13px 22px;color:#171717;text-decoration:none;font-size:15px;font-weight:700">${buttonLabel}</a>
            </td></tr></table>
            <p style="margin:24px 0 0;color:#6b7280;font-size:13px;line-height:1.6">If the button does not work, <a href="${buttonUrl}" style="color:#ad4f08;font-weight:600">open the secure link in your browser</a>.</p>
          </td></tr>
          ${automatedEmailFooterHtml(input.footer)}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function invitationEmail(input: {
  invitationUrl: string;
  roleLabel: string;
}): RenderedEmail {
  const subject = 'Your invitation to join Kaliganj Travels';
  const intro = `Your place at Kaliganj Travels is ready with ${input.roleLabel} access. Use the invitation below to finish setting up your account.`;
  return {
    subject,
    html: layout({
      preheader: 'Accept your secure Kaliganj Travels account invitation.',
      eyebrow: 'Account invitation',
      title: 'Your place is ready',
      intro,
      buttonLabel: 'Accept invitation',
      buttonUrl: input.invitationUrl,
      footer:
        'This invitation expires automatically. If you were not expecting it, you can safely ignore this email.',
    }),
    text: `${subject}\n\n${intro}\n\nAccept invitation: ${input.invitationUrl}\n\nThis invitation expires automatically. If you were not expecting it, you can safely ignore this email.\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

export function accountCreatedEmail(input: {
  signInUrl: string;
  firstName: string;
}): RenderedEmail {
  const subject = 'Your Kaliganj Travels account is ready';
  const greeting = input.firstName ? `${input.firstName}, your` : 'Your';
  const intro = `${greeting} account is ready. Sign in with the credentials provided to you by your administrator, then change your password from your account settings.`;
  return {
    subject,
    html: layout({
      preheader: 'Your Kaliganj Travels account is ready.',
      eyebrow: 'Account created',
      title: 'Your journey with Kaliganj Travels starts here',
      intro,
      buttonLabel: 'Sign in',
      buttonUrl: input.signInUrl,
      footer:
        'For your security, this email never includes your password. Contact support if you did not expect this account.',
    }),
    text: `${subject}\n\n${intro}\n\nSign in: ${input.signInUrl}\n\nFor your security, this email never includes your password.\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

export function welcomeEmail(input: {
  dashboardUrl: string;
  firstName: string;
}): RenderedEmail {
  const subject = 'Your journey with Kaliganj Travels starts here';
  const greeting = input.firstName ? `Welcome, ${input.firstName}.` : 'Welcome.';
  const intro = `${greeting} You can now explore flights and keep your bookings together in your dashboard.`;
  return {
    subject,
    html: layout({
      preheader: 'Your Kaliganj Travels account is ready.',
      eyebrow: 'Registration complete',
      title: 'Your journey with Kaliganj Travels starts here',
      intro,
      buttonLabel: 'Open dashboard',
      buttonUrl: input.dashboardUrl,
      footer:
        'If you did not create this account, contact support so we can help secure it.',
    }),
    text: `${subject}\n\n${intro}\n\nOpen dashboard: ${input.dashboardUrl}\n\nIf you did not create this account, contact support.\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

export function roleChangedEmail(input: {
  dashboardUrl: string;
  firstName: string;
  previousRoleLabel: string;
  nextRoleLabel: string;
}): RenderedEmail {
  const subject = 'Your Kaliganj Travels account role has been updated';
  const greeting = input.firstName ? `${input.firstName}, your` : 'Your';
  const intro = `${greeting} account role was changed from ${input.previousRoleLabel} to ${input.nextRoleLabel}. Your dashboard access now reflects your updated responsibilities.`;
  return {
    subject,
    html: layout({
      preheader: `Your account role is now ${input.nextRoleLabel}.`,
      eyebrow: 'Access updated',
      title: 'A new level of access',
      intro,
      buttonLabel: 'Review dashboard',
      buttonUrl: input.dashboardUrl,
      footer:
        'If you were not expecting this change, contact support immediately.',
    }),
    text: `${subject}\n\n${intro}\n\nReview dashboard: ${input.dashboardUrl}\n\nIf you were not expecting this change, contact support immediately.\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

type DepositRequestEmailDetails = {
  requestReference: string;
  amount: string;
  paymentMethod: string;
  transactionReference?: string | null;
  depositDate?: string | null;
};

function depositRequestDetails(
  input: DepositRequestEmailDetails,
  extras: ReadonlyArray<{ label: string; value: string }> = []
) {
  return [
    { label: 'Request ID', value: input.requestReference },
    { label: 'Amount', value: input.amount },
    { label: 'Payment method', value: input.paymentMethod },
    ...(input.transactionReference
      ? [{ label: 'Transaction / reference ID', value: input.transactionReference }]
      : []),
    ...(input.depositDate ? [{ label: 'Deposit date', value: input.depositDate }] : []),
    ...extras,
  ];
}

function depositRequestDetailsText(
  input: DepositRequestEmailDetails,
  extras: ReadonlyArray<{ label: string; value: string }> = []
): string {
  return depositRequestDetails(input, extras)
    .map((detail) => `${detail.label}: ${detail.value}`)
    .join('\n');
}

/** Confirmation sent to the customer or B2B user after a request is stored. */
export function depositRequestConfirmationEmail(
  input: DepositRequestEmailDetails & {
    requesterName: string;
    dashboardUrl: string;
  }
): RenderedEmail {
  const subject = `Deposit request received — ${input.requestReference}`;
  const greeting = input.requesterName.trim() ? `Hi ${input.requesterName.trim()},` : 'Hello,';
  const intro = `${greeting} we received your ${input.paymentMethod.toLowerCase()} deposit request for ${input.amount}. It is now awaiting review. Your wallet balance will remain unchanged until the request is approved.`;
  const footer = 'Keep your payment receipt and request ID for reference. We will notify you when the review is complete.';

  return {
    subject,
    html: layout({
      preheader: `Your deposit request ${input.requestReference} is awaiting review.`,
      eyebrow: 'Deposit request received',
      title: 'We have your payment request',
      intro,
      details: depositRequestDetails(input),
      buttonLabel: 'View payment request',
      buttonUrl: input.dashboardUrl,
      footer,
    }),
    text: `${subject}\n\n${intro}\n\n${depositRequestDetailsText(input)}\n\nView payment request: ${input.dashboardUrl}\n\n${footer}\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

/** Operational alert sent individually to every financial deposit reviewer. */
export function depositRequestReviewEmail(
  input: DepositRequestEmailDetails & {
    requesterName: string;
    agency?: string | null;
    dashboardUrl: string;
  }
): RenderedEmail {
  const subject = `Action required: deposit request ${input.requestReference}`;
  const requester = input.requesterName.trim() || 'A wallet user';
  const agency = input.agency?.trim();
  const extraDetails = [
    { label: 'Requested by', value: requester },
    ...(agency ? [{ label: 'Agency', value: agency }] : []),
  ];
  const intro = `${requester} submitted a ${input.paymentMethod.toLowerCase()} deposit request for ${input.amount}. Review the payment evidence and request details before changing the wallet balance.`;
  const footer = 'This operational alert was sent to active Super Admin, Admin, and Accounts Staff users. The requester has been notified that the request is awaiting review.';

  return {
    subject,
    html: layout({
      preheader: `A deposit request for ${input.amount} requires financial review.`,
      eyebrow: 'Financial review required',
      title: 'Payment review: your next action',
      intro,
      details: depositRequestDetails(input, extraDetails),
      buttonLabel: 'Review deposit request',
      buttonUrl: input.dashboardUrl,
      footer,
    }),
    text: `${subject}\n\n${intro}\n\n${depositRequestDetailsText(input, extraDetails)}\n\nReview deposit request: ${input.dashboardUrl}\n\n${footer}\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

/** Final customer notice after an Accounts reviewer approves or rejects a request. */
export function depositRequestDecisionEmail(
  input: DepositRequestEmailDetails & {
    requesterName: string;
    decision: 'approved' | 'rejected';
    reviewRemarks?: string | null;
    dashboardUrl: string;
  }
): RenderedEmail {
  const approved = input.decision === 'approved';
  const subject = approved
    ? `Your deposit request is approved — ${input.requestReference}`
    : `Your deposit request was rejected — ${input.requestReference}`;
  const greeting = input.requesterName.trim() ? `Hi ${input.requesterName.trim()},` : 'Hello,';
  const intro = approved
    ? `${greeting} your ${input.paymentMethod.toLowerCase()} deposit request for ${input.amount} has been approved. The approved amount is now available in your wallet.`
    : `${greeting} we could not approve your ${input.paymentMethod.toLowerCase()} deposit request for ${input.amount}. Your wallet balance has not changed.`;
  const reviewRemarks = input.reviewRemarks?.trim();
  const details = depositRequestDetails(input, [
    { label: 'Decision', value: approved ? 'Approved' : 'Rejected' },
    ...(reviewRemarks
      ? [
          {
            label: approved ? 'Review note' : 'Rejection reason',
            value: reviewRemarks,
          },
        ]
      : []),
  ]);
  const footer = approved
    ? 'Your wallet balance has been updated. Keep this email and your payment receipt for your records.'
    : 'Please resolve the reason above before submitting another deposit request. Keep your payment receipt and request ID for reference.';

  return {
    subject,
    html: layout({
      preheader: approved
        ? `Your deposit request ${input.requestReference} has been approved.`
        : `Your deposit request ${input.requestReference} has been rejected.`,
      eyebrow: approved ? 'Deposit approved' : 'Deposit rejected',
      title: approved ? 'Your travel wallet is topped up' : 'Your deposit needs attention',
      intro,
      details,
      buttonLabel: 'View payment request',
      buttonUrl: input.dashboardUrl,
      footer,
    }),
    text: `${subject}\n\n${intro}\n\n${depositRequestDetailsText(input, [
      { label: 'Decision', value: approved ? 'Approved' : 'Rejected' },
      ...(reviewRemarks
        ? [
            {
              label: approved ? 'Review note' : 'Rejection reason',
              value: reviewRemarks,
            },
          ]
        : []),
    ])}\n\nView payment request: ${input.dashboardUrl}\n\n${footer}\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

const AUTOMATED_EMAIL_FOOTER_TEXT = `Questions about your journey? Talk to the Kaliganj team.

Email: support@kaliganjtravel.com
Customer Care: +880 1795-271171

From your first booking to your next destination, thank you for travelling with Kaliganj Travels.

Kaliganj Travels
1st Floor, Janata Super Market
Kaligonj, Jhenaidah
Bangladesh

Keep in touch
Facebook: https://www.facebook.com/KaligonjTourTravel/
WhatsApp: +880 1795-271171 (https://wa.me/8801795271171)
Website: https://kaliganjtravel.com`;

function automatedEmailFooterHtml(note?: string): string {
  const noteHtml = note
    ? `<p style="margin:0 0 18px;color:#6b7280;font-size:12px;line-height:1.6">${escapeHtml(note)}</p>`
    : '';
  return `<tr><td style="background:#faf9f6;border-top:1px solid #e5e5e5;padding:24px 32px;color:#4b5563;font-size:13px;line-height:1.65">
    ${noteHtml}
    <p style="margin:0 0 12px"><strong style="color:#262626">Let’s plan the next step.</strong> Our Kaliganj team can help with your booking and travel questions.</p>
    <p style="margin:0 0 16px"><strong>Email:</strong> <a href="mailto:support@kaliganjtravel.com" style="color:#ad4f08;text-decoration:none">support@kaliganjtravel.com</a><br><strong>Customer Care:</strong> <a href="tel:+8801795271171" style="color:#ad4f08;text-decoration:none">+880 1795-271171</a></p>
    <p style="margin:0 0 16px">Your next destination starts here. Thank you for travelling with <strong style="color:#262626">Kaliganj Travels</strong>.</p>
    <p style="margin:0 0 16px"><strong style="color:#262626">Kaliganj Travels</strong><br>1st Floor, Janata Super Market<br>Kaligonj, Jhenaidah<br>Bangladesh</p>
    <p style="margin:0"><strong style="color:#262626">Keep in touch</strong><br><a href="https://www.facebook.com/KaligonjTourTravel/" style="color:#ad4f08;text-decoration:none">Facebook</a> &nbsp;·&nbsp; <a href="https://wa.me/8801795271171" style="color:#ad4f08;text-decoration:none">WhatsApp +880 1795-271171</a> &nbsp;·&nbsp; <a href="https://kaliganjtravel.com" style="color:#ad4f08;text-decoration:none">kaliganjtravel.com</a></p>
  </td></tr>`;
}

export function ticketManagementNotificationEmail(input: {
  audience: 'customer' | 'internal';
  actionLabel: string;
  eventLabel: string;
  requestReference: string;
  statusLabel: string;
  effectiveAt: string;
  dashboardUrl: string;
  amount?: string | null;
  confirmationDeadline?: string | null;
}): RenderedEmail {
  const internal = input.audience === 'internal';
  const subject = internal
    ? `Ticket Management: ${input.actionLabel} ${input.eventLabel} — ${input.requestReference}`
    : `Your ${input.actionLabel.toLowerCase()} request: ${input.eventLabel}`;
  const intro = internal
    ? `A Ticket Management ${input.actionLabel.toLowerCase()} request has been updated. Review the request and take the next required action.`
    : `Here is the latest on your ${input.actionLabel.toLowerCase()} request. Open My Bookings to see the decision and any next steps.`;
  const details = [
    { label: 'Request reference', value: input.requestReference },
    { label: 'Request type', value: input.actionLabel },
    { label: 'Action', value: input.eventLabel },
    { label: 'Current status', value: input.statusLabel },
    { label: 'Updated', value: input.effectiveAt },
    ...(input.amount ? [{ label: 'Final customer amount', value: input.amount }] : []),
    ...(input.confirmationDeadline
      ? [{ label: 'Confirmation deadline', value: input.confirmationDeadline }]
      : []),
  ];
  const footer = internal
    ? 'This operational confirmation was sent to authorized Ticket Management staff.'
    : 'Questions about this update? Contact our team with the request reference above.';
  return {
    subject,
    html: layout({
      preheader: `${input.actionLabel} request ${input.eventLabel.toLowerCase()}.`,
      eyebrow: 'Ticket Management',
      title: `${input.actionLabel} request ${input.eventLabel.toLowerCase()}`,
      intro,
      buttonLabel: internal ? 'Open Ticket Management' : 'View request timeline',
      buttonUrl: input.dashboardUrl,
      details,
      footer,
    }),
    text: `${subject}\n\n${intro}\n\n${details.map((detail) => `${detail.label}: ${detail.value}`).join('\n')}\n\nOpen request: ${input.dashboardUrl}\n\n${footer}\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}

export function pendingTicketAlertEmail(input: {
  bookingReference: string;
  pnr: string;
  amount: string;
  bookingUrl: string;
  supplierReason: string;
}): RenderedEmail {
  const reference = escapeHtml(input.bookingReference);
  const pnr = escapeHtml(input.pnr || '—');
  const amount = escapeHtml(input.amount);
  const reason = escapeHtml(input.supplierReason);
  const bookingUrl = escapeHtml(input.bookingUrl);
  const subject = `Urgent action required: Issue ticket ${input.bookingReference}`;

  return {
    subject,
    html: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;background:#f7f5f2;color:#111827;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">A paid booking is waiting for immediate manual ticket issuance.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f5f2;padding:32px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e5e5e5;border-radius:4px;overflow:hidden">
          <tr><td style="height:6px;background:#f68712;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="background:#262626;padding:24px 32px;color:#ffffff">
            <div style="font-size:20px;font-weight:700">Kaliganj Travels</div>
            <div style="margin-top:5px;color:#f0e8df;font-size:12px">KALIGANJ OPERATIONS / TICKETING</div>
          </td></tr>
          <tr><td style="padding:32px">
            <div style="display:inline-block;border-radius:999px;background:#fff0f1;padding:7px 11px;color:#ad4f08;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Urgent action required</div>
            <h1 style="margin:14px 0 10px;font-size:26px;line-height:1.25;color:#262626">Payment received. Ticket issuance needs you.</h1>
            <p style="margin:0 0 22px;color:#4b5563;font-size:15px;line-height:1.65">The customer wallet was charged successfully, but the supplier API wallet has insufficient balance. Fund the supplier account and issue this ticket immediately.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e5e5;border-radius:10px;background:#faf9f6">
              <tr><td style="padding:13px 16px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e5e5">Booking reference</td><td align="right" style="padding:13px 16px;color:#262626;font-size:14px;font-weight:700;border-bottom:1px solid #e5e5e5">${reference}</td></tr>
              <tr><td style="padding:13px 16px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e5e5">Airline PNR</td><td align="right" style="padding:13px 16px;color:#111827;font-size:14px;font-weight:700;border-bottom:1px solid #e5e5e5">${pnr}</td></tr>
              <tr><td style="padding:13px 16px;color:#6b7280;font-size:12px">Amount captured</td><td align="right" style="padding:13px 16px;color:#ad4f08;font-size:14px;font-weight:700">${amount}</td></tr>
            </table>
            <div style="margin:18px 0 24px;border-left:4px solid #f68712;background:#fff7f7;padding:13px 15px;color:#7f1d1d;font-size:13px;line-height:1.55"><strong>Supplier response:</strong> ${reason}</div>
            <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:4px;background:#f68712">
              <a href="${bookingUrl}" style="display:inline-block;padding:14px 23px;color:#171717;text-decoration:none;font-size:15px;font-weight:700">Review &amp; issue ticket</a>
            </td></tr></table>
            <p style="margin:20px 0 0;color:#6b7280;font-size:12px;line-height:1.6">This is an operational alert sent to all active Super Administrators. The customer must not be charged again.</p>
          </td></tr>
          ${automatedEmailFooterHtml('Keep the booking reference with your issuance confirmation.')}
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
    text: `${subject}\n\nA paid booking is waiting for manual issuance.\n\nBooking: ${input.bookingReference}\nAirline PNR: ${input.pnr || '—'}\nAmount captured: ${input.amount}\nSupplier response: ${input.supplierReason}\n\nReview and issue: ${input.bookingUrl}\n\nThe customer must not be charged again.\n\n${AUTOMATED_EMAIL_FOOTER_TEXT}`,
  };
}
