# Email Notifications System

The email notifications system handles automated email communications for booking confirmations, on-hold notifications, and other customer-facing messages. The system uses Nodemailer with SMTP integration and includes PDF generation for ticket attachments.

## Email Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Business Event                                 │
│          (Booking Confirmed, On Hold, etc.)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Trigger Email
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Email Trigger Function                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  sendConfirmedBookingEmailOnce()                           │  │
│  │  sendOnHoldBookingEmailOnce()                             │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Idempotency Check
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Email Tracking Table                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  email_tracking                                            │  │
│  │  - booking_id                                              │  │
│  │  - email_type                                              │  │
│  │  - last_attempt_at                                        │  │
│  │  - sent_at                                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Generate Content
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Email Template System                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  booking-confirmation.ts - Confirmation email               │  │
│  │  booking-on-hold.ts - On-hold notification                 │  │
│  │  booking-ticket-pdf.ts - Ticket PDF generation             │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Send Email
                              │
┌─────────────────────────────────────────────────────────────────┐
│              SMTP Client (Nodemailer)                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Zoho SMTP server                                          │  │
│  │  - Authentication                                          │  │
│  │  - TLS encryption                                          │  │
│  │  - Timeout handling                                        │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Delivery
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Customer Inbox                                       │
└─────────────────────────────────────────────────────────────────┘
```

## SMTP Configuration

### Environment Variables

The email system requires the following environment variables:

```bash
SMTP_HOST=smtp.zoho.com
SMTP_PORT=587
SMTP_USER=shapontravels@gmail.com
SHAPON_TRAVELS_SMTP_PASSWORD=********
EMAIL_FROM_ADDRESS=shapontravels@gmail.com
EMAIL_FROM_NAME=Shapon Travels International
EMAIL_REPLY_TO=support@shapontravels.com
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

### Configuration Loading

```typescript
// lib/email/mailer.ts
function emailConfig(): EmailConfig {
  const host = process.env.SMTP_HOST?.trim();
  const rawPort = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SHAPON_TRAVELS_SMTP_PASSWORD || process.env.SMTP_PASSWORD;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS?.trim();
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || 'Shapon Travels International';
  const replyTo = process.env.EMAIL_REPLY_TO?.trim();

  if (!host || !rawPort || !user || !password || !fromAddress) {
    throw new Error(
      'Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SHAPON_TRAVELS_SMTP_PASSWORD, and EMAIL_FROM_ADDRESS.'
    );
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.');
  }

  return {
    from: { name: fromName, address: fromAddress },
    replyTo: replyTo || undefined,
    host,
    port,
    secure: booleanValue(process.env.SMTP_SECURE, port === 465),
    requireTLS: booleanValue(process.env.SMTP_REQUIRE_TLS, port === 587),
    user,
    password,
  };
}
```

### Security Features

- **TLS Encryption**: Required TLS 1.2+ for all connections
- **Authentication**: SMTP authentication required
- **Certificate Validation**: TLS certificate validation enabled
- **Timeout Protection**: Connection, greeting, and socket timeouts configured

## Email Types

### Booking Confirmation Email

**Trigger**: Booking status changes to `confirmed`

**Purpose**: Notify customer that tickets have been issued

**Content**:
- Booking reference (STR number)
- Flight itinerary details
- Passenger information
- Ticket numbers
- Pricing breakdown
- Contact information

**Attachments**: Ticket PDF (if tickets issued)

**Implementation**: `lib/email/booking-confirmation.ts`

For `IMP_EXP` bookings, the shared public booking projection supplies the
airline-authored fare rows and Supplier Gross to both the HTML email and PDF
attachment. User Payable remains the wallet/payment amount and is not printed as
the imported ticket fare total.

### On-Hold Booking Email

**Trigger**: Booking status changes to `on-hold`

**Purpose**: Notify customer that booking is held and awaiting ticket issuance

**Content**:
- Booking reference (STR number)
- Flight itinerary details
- Ticketing deadline
- Payment status
- Contact information

**Attachments**: None

**Implementation**: `lib/email/booking-on-hold.ts`

## Email Template System

### Template Structure

Email templates are modular React components that generate HTML:

```typescript
// lib/email/templates.ts
export function BookingEmailTemplate({ booking, type }: BookingEmailProps) {
  return (
    <html>
      <head>
        <style>{emailStyles}</style>
      </head>
      <body>
        <EmailHeader />
        <EmailContent booking={booking} type={type} />
        <EmailFooter />
      </body>
    </html>
  );
}
```

### Styling

Emails use inline CSS for maximum client compatibility:

```typescript
const emailStyles = `
  body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #1a365d; color: white; padding: 20px; text-align: center; }
  .content { padding: 20px; background: #f7fafc; }
  .footer { padding: 20px; text-align: center; font-size: 12px; color: #718096; }
`;
```

## Ticket PDF Generation

### PDFKit Integration

Ticket PDFs are generated using PDFKit:

```typescript
// lib/email/booking-ticket-pdf.ts
import PDFDocument from 'pdfkit';

export async function generateTicketPDF(booking: PublicBooking): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Add ticket content
    doc.fontSize(20).text('Shapon Travels International', { align: 'center' });
    doc.fontSize(14).text(`Booking Reference: ${booking.publicRef}`);
    // ... more content

    doc.end();
  });
}
```

### PDF Content

Ticket PDFs include:
- Company branding and logo
- Booking reference (STR number)
- Flight itinerary details
- Passenger information
- Ticket numbers
- Pricing breakdown
- Terms and conditions

Imported ticket PDFs use Supplier Gross and supplier fare evidence as the face
value. This is presentation-only: PDF generation must never read User Payable as
the ticket total or mutate payment, ledger, or wallet state.

### PDF Attachment

PDFs are attached to confirmation emails:

```typescript
const pdfBuffer = await generateTicketPDF(booking);
const attachments = [{
  filename: `ticket-${booking.publicRef}.pdf`,
  content: pdfBuffer,
  contentType: 'application/pdf',
}];
```

## Email Retry Logic

### Idempotency

Emails are sent only once per booking per type:

```typescript
export async function sendConfirmedBookingEmailOnce(booking: PublicBooking): Promise<void> {
  const tracking = await readEmailTracking(booking.id, 'confirmation');
  if (tracking?.sent_at) {
    return; // Already sent
  }

  await recordEmailAttempt(booking.id, 'confirmation');
  
  try {
    await sendEmail({
      to: booking.headerContact.email,
      subject: `Booking Confirmed - ${booking.publicRef}`,
      html: generateConfirmationEmail(booking),
      text: generateConfirmationText(booking),
      attachments: booking.ticketNumbers.length > 0 ? [await generateTicketPDF(booking)] : [],
    });

    await markEmailSent(booking.id, 'confirmation');
  } catch (error) {
    console.error('[email] Failed to send confirmation email:', error);
    // Leave tracking record for retry
  }
}
```

### Retry Strategy

- **Failed sends**: Tracking record remains with `last_attempt_at` but no `sent_at`
- **Manual retry**: Can be retried by checking tracking and resending
- **No automatic retry**: Failed emails are not automatically retried to avoid spam
- **Logging**: All failures are logged for monitoring

## Email Tracking

### email_tracking Table

```sql
create table public.email_tracking (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings (id) on delete cascade,
  email_type text not null,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (booking_id, email_type)
);
```

### Tracking Functions

```typescript
async function recordEmailAttempt(bookingId: string, emailType: string): Promise<void> {
  await supabaseAdmin().from('email_tracking').upsert({
    booking_id: bookingId,
    email_type: emailType,
    last_attempt_at: new Date().toISOString(),
  });
}

async function markEmailSent(bookingId: string, emailType: string): Promise<void> {
  await supabaseAdmin().from('email_tracking')
    .update({ sent_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .eq('email_type', emailType);
}
```

## Error Handling

### SMTP Errors

```typescript
try {
  await transport.sendMail(mailOptions);
} catch (error) {
  if (error.code === 'EAUTH') {
    console.error('[email] Authentication failed');
  } else if (error.code === 'ECONNECTION') {
    console.error('[email] Connection failed');
  } else {
    console.error('[email] Send failed:', error);
  }
  throw error;
}
```

### Validation Errors

```typescript
if (!EMAIL_PATTERN.test(message.to)) {
  throw new Error('Refusing to send email to an invalid address.');
}

if (!message.subject.trim() || /[\r\n]/.test(message.subject)) {
  throw new Error('Refusing to send email with an invalid subject.');
}
```

## Configuration and Environment Variables

### Required Variables

All email configuration variables are required:

```bash
SMTP_HOST                    # SMTP server hostname
SMTP_PORT                    # SMTP server port
SMTP_USER                    # SMTP username
SHAPON_TRAVELS_SMTP_PASSWORD  # SMTP password
EMAIL_FROM_ADDRESS           # From email address
```

### Optional Variables

```bash
EMAIL_FROM_NAME              # From name (default: Shapon Travels International)
EMAIL_REPLY_TO               # Reply-to address
SMTP_SECURE                  # Use SSL (default: false for port 587)
SMTP_REQUIRE_TLS             # Require TLS (default: true for port 587)
```

### Boolean Parsing

Boolean values are parsed strictly:

```typescript
function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Email boolean environment variables must be true or false.');
}
```

## Error Handling and Delivery Tracking

### Transport Verification

Email transport can be verified without sending:

```typescript
export async function verifyEmailTransport(): Promise<void> {
  await emailTransport().transport.verify();
}
```

### Delivery Tracking

- **SMTP level**: Nodemailer provides delivery confirmation
- **Application level**: email_tracking table records attempts
- **Monitoring**: Failed sends are logged for alerting
- **No bounce handling**: Bounce handling not implemented (future enhancement)

## Ticket Management Notification Intents

Migration `0126_ticket_management_notification_outbox.sql` adds a dedicated
service-only outbox because Ticket Management statuses do not belong in the
booking-status notification schema. An after-insert trigger on immutable
Ticket Management request events creates occurrence-unique audience intents in
the same transaction as the lifecycle event.

Customer intents cover acceptance, staff rejection, quotation publication,
confirmation expiry, requotation, and completion. Internal intents cover new
requests, customer decisions, completion, and financial exceptions. Snapshots
contain render-safe request/quote facts and no recipient address or wallet
internals.

Phase 9 does not expand recipients, render a message, send email, or run a
delivery worker. The pending rows are durable intent only; delivery requires a
separately approved recipient and content policy.

## Related Documentation

- [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) - Booking status lifecycle
- [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) - Booking system
- [14-SECURITY.md](14-SECURITY.md) - Security practices

## Critical Invariants

### Idempotency
- Each email type must be sent only once per booking
- Email tracking must be checked before sending
- Sent emails must not be resent automatically

### Security
- SMTP credentials must never be exposed to client
- Email addresses must be validated before sending
- Subject lines must not contain newlines (header injection prevention)
- TLS must be required for all connections

### Content Safety
- Customer-facing emails must not contain sensitive internal data
- PDF attachments must be generated server-side
- Email content must be validated for XSS
- Imported confirmation email/PDF fare totals must use Supplier Gross; User Payable remains protected payment data

### Configuration
- All required environment variables must be set
- Invalid configuration must fail fast at startup
- Boolean values must be parsed strictly

## Before Modifying This System

1. **Test Email Templates**: Verify email rendering in multiple clients
2. **Check SMTP Configuration**: Ensure all environment variables are set
3. **Test PDF Generation**: Verify PDF generation and attachment
4. **Validate Idempotency**: Ensure emails are sent only once
5. **Test Error Handling**: Verify error handling for SMTP failures
6. **Update Tracking**: If email types change, update tracking table
7. **Security Review**: Ensure no sensitive data in emails
8. **Test Delivery**: Send test emails to verify delivery
9. **Monitor Logs**: Check for email failures in production
10. **Update Documentation**: Document any new email types
