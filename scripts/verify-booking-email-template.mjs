import { airlinePnrModule } from './helpers/airline-pnr.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = process.cwd();
const BOOKING_ICON_NAMES = [
  'phone',
  'mail',
  'map-pin',
  'users',
  'plane',
  'receipt',
  'ticket',
];
const sourcePath = path.join(root, 'lib', 'email', 'booking-template.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});

const errors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(errors.length, 0, 'booking email template must transpile');

const module = { exports: {} };
const context = vm.createContext({
  module,
  exports: module.exports,
  require(specifier) {
    if (specifier === '@/lib/flights/airline-pnr') return airlinePnrModule;
    throw new Error(`Unexpected runtime import in pure email renderer: ${specifier}`);
  },
  Intl,
  Date,
  Number,
  encodeURIComponent,
  Buffer,
});
new vm.Script(transpiled.outputText, { filename: sourcePath }).runInContext(context);

const { bookingConfirmationEmail, bookingStatusEmail, confirmedBookingEmail } = module.exports;
assert.equal(typeof bookingConfirmationEmail, 'function');
assert.equal(typeof bookingStatusEmail, 'function');
assert.equal(typeof confirmedBookingEmail, 'function');

const travellers = [
  {
    passengerType: 'ADT',
    title: 'Mr',
    firstName: 'Ashif',
    lastName: 'Babu',
    gender: 'Male',
    dateOfBirth: '1990-04-02',
    nationality: 'BD',
  },
];

const booking = {
  bookingId: '2f53af8f-56d8-4a1b-b856-ece0f466ec34',
  publicRef: 'STR260806000013',
  status: 'on-hold',
  paymentState: 'unpaid',
  headerContact: {
    name: 'Example Travel Agency',
    licenseNo: 'TEST-LICENSE-123',
    mobile: '+8801700000000',
    email: 'agency@example.test',
    address: 'Airport Market, Airport, Jashore',
    logoUrl: null,
  },
  currency: 'BDT',
  totalPrice: 4049,
  serviceMargin: 0,
  passengerCounts: { ADT: 1 },
  travelDate: '2026-09-30',
  directTicketing: false,
  passportRequired: false,
  itinerary: {
    carrierCode: 'BS',
    carrierName: 'US-Bangla Airlines',
    refundable: true,
    legs: [
      {
        from: 'DAC',
        to: 'CGP',
        stops: 0,
        duration: '55m',
        departure: '2026-09-30 15:45:00',
        arrival: '2026-09-30 16:40:00',
        segments: [
          {
            from: 'DAC',
            fromAirport: 'Hazrat Shahjalal International Airport',
            to: 'CGP',
            toAirport: 'Shah Amanat International Airport',
            departure: '2026-09-30 15:45:00',
            arrival: '2026-09-30 16:40:00',
            airline: 'US-Bangla Airlines',
            airlineCode: 'BS',
            flightNumber: '349',
            cabinClass: 'Economy',
            bookingClass: 'Q',
            duration: '55m',
            aircraft: 'Boeing 737-800',
            baggage: '20 Kg',
            handBaggage: '7 Kg',
            seatsLeft: null,
          },
        ],
      },
    ],
  },
  fares: [
    {
      passengerType: 'ADT',
      count: 1,
      basePrice: 2924,
      taxes: 1125,
      ait: 0,
      serviceMargin: 0,
      totalPrice: 4049,
    },
  ],
  repricedAt: '2026-08-06T17:40:00.000Z',
  pnr: '0A5ZR3',
  airlinesPnr: ['0A5ZR3'],
  bookingRefNumber: 'BOOK-13',
  bookingStatus: 'Created',
  ticketingTimeLimit: '2026-08-07 05:42:00',
  ticketingDeadlineAt: '2026-08-06T23:42:00.000Z',
  ticketNumbers: [],
  warnings: [],
  bookedAt: '2026-08-06T17:42:00.000Z',
  issuedAt: null,
  cancelledAt: null,
};

const bookingUrl = 'https://kaliganjtravel.com/dashboard/bookings/STR260806000013';
const onHold = bookingConfirmationEmail({ booking, travellers, bookingUrl });

assert.equal(onHold.subject, 'Booking on hold — STR260806000013');
for (const expected of [
  'Example Travel Agency',
  'License No: TEST-LICENSE-123',
  'agency@example.test',
  'STR260806000013',
  'ON HOLD',
  'Booking confirmation — seats held with the airline.',
  'Ticketing deadline:',
  '0A5ZR3',
  'PAYMENT',
  'Unpaid',
  'PASSENGER &amp; TICKET DETAILS',
  'MR ASHIF BABU',
  'BANGLADESH',
  'FLIGHT ITINERARY',
  'US-Bangla Airlines',
  'Flight BS349',
  'Economy',
  '15:45',
  '16:40',
  'Hazrat Shahjalal International Airport',
  'Shah Amanat International Airport',
  '20 Kg',
  'Boeing 737-800',
  'RBD',
  'FARE BREAKDOWN',
  'BASE FARE',
  'TAX &amp; OTHER',
  'AIT / VAT',
  'BDT 4,049.00',
  'FARE CONDITIONS',
  'Validating carrier',
  'System generated document',
  'View Booking',
  'Kaliganj Travels',
  'https://wa.me/8801795271171',
  'WhatsApp +880 1795-271171',
  bookingUrl,
]) {
  assert.ok(onHold.html.includes(expected), `ON HOLD HTML must include ${expected}`);
}

for (const forbidden of ['undefined', 'NaN', '[object Object]', 'REFUNDED', 'successfully issued']) {
  assert.ok(!onHold.html.includes(forbidden), `ON HOLD HTML must not include ${forbidden}`);
}
assert.ok(!onHold.html.includes('https://wa.me/8800000000000'));
assert.ok(!onHold.html.includes('booking-email-shell" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:840px;background:#ffffff;border:1px solid #dce7f3;border-radius'));
assert.ok(!onHold.html.includes('TICKET NUMBER'), 'ON HOLD must not invent a ticket column');
assert.ok(onHold.html.includes('images.kiwi.com/airlines/64x64/BS.png'));
assert.ok(onHold.html.includes('class="booking-header-contact"'));
assert.ok(onHold.html.includes('class="booking-contact-value"'));
assert.ok(onHold.html.includes('class="booking-itinerary-fact"'));
assert.ok(onHold.html.includes('class="booking-fare-table"'));
assert.ok(onHold.html.includes('class="booking-fare-money"'));
assert.ok(onHold.html.includes('white-space:nowrap;word-break:normal'));
assert.ok(onHold.html.includes('<col style="width:25%">'));
assert.ok(
  onHold.html.indexOf('License No: TEST-LICENSE-123') > onHold.html.indexOf('class="booking-header-brand"'),
  'license must stay with the brand content instead of overflowing the narrow logo column'
);
assert.ok((onHold.html.match(/role="presentation"/g) ?? []).length >= 10);
assert.ok(onHold.text.includes('Payment status: Unpaid'));
assert.ok(onHold.text.includes('Ticketing deadline:'));
assert.ok(!onHold.html.includes('ota.kaliganjtravel.com@gmail.com'));
assert.ok(!onHold.text.includes('ota.kaliganjtravel.com@gmail.com'));

const confirmedBooking = {
  ...booking,
  status: 'confirmed',
  paymentState: 'captured',
  issuedAt: '2026-08-07T02:15:00.000Z',
  ticketNumbers: ['BS-1234567890'],
};
const confirmed = confirmedBookingEmail({
  booking: confirmedBooking,
  travellers,
  bookingUrl,
});
assert.equal(confirmed.subject, 'Booking confirmed — STR260806000013');
assert.ok(confirmed.html.includes('CONFIRMED'));
assert.ok(confirmed.html.includes('ISSUED AT'));
assert.ok(confirmed.html.includes('TICKET NUMBER'));
assert.ok(confirmed.html.includes('BS-1234567890'));
assert.ok(confirmed.html.includes('Paid'));
assert.ok(!confirmed.html.includes('ota.kaliganjtravel.com@gmail.com'));
assert.ok(!confirmed.text.includes('ota.kaliganjtravel.com@gmail.com'));

for (const [status, subject, label] of [
  ['pending', 'Booking pending', 'PENDING'],
  ['in-progress', 'Booking in progress', 'IN PROGRESS'],
  ['expired', 'Booking expired', 'EXPIRED'],
  ['unconfirmed', 'Booking unconfirmed', 'UNCONFIRMED'],
  ['cancelled', 'Booking cancelled', 'CANCELLED'],
]) {
  const content = bookingStatusEmail(
    {
      booking: {
        ...booking,
        status,
        cancelledAt: status === 'cancelled' ? '2026-08-07T03:00:00.000Z' : null,
      },
      travellers,
      bookingUrl,
    },
    status
  );
  assert.ok(content.subject.includes(subject), `${status} subject must identify the status`);
  assert.ok(content.html.includes(label), `${status} HTML must identify the status`);
  assert.ok(content.text.includes(`Status: ${label}`), `${status} text must identify the status`);
  assert.ok(!content.html.includes('ota.kaliganjtravel.com@gmail.com'));
  assert.ok(!content.text.includes('ota.kaliganjtravel.com@gmail.com'));
  for (const forbidden of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!content.html.includes(forbidden), `${status} HTML must not include ${forbidden}`);
  }
}

const pdfSourcePath = path.join(root, 'lib', 'email', 'booking-ticket-pdf.ts');
const pdfSource = fs.readFileSync(pdfSourcePath, 'utf8');
for (const required of [
  "['Passenger', 'Type', 'Gender', 'Date of Birth', 'Ticket Number']",
  'contact.logoUrl',
  'https://images.kiwi.com/airlines/64x64/',
  "['images.kiwi.com']",
  'segment.departureTerminal',
  'segment.arrivalTerminal',
  'booking.headerContact.email',
  "sectionTitle('Passenger & Ticket Details'",
  "sectionTitle('Flight Itinerary'",
  "sectionTitle('Fare Breakdown'",
  'bottomRoundedRect(left, y, width, 32, 4).fill(COLORS.blue)',
]) {
  assert.ok(pdfSource.includes(required), `Confirmed ticket PDF layout needs ${required}`);
}
const pdfTranspiled = ts.transpileModule(pdfSource, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: pdfSourcePath,
  reportDiagnostics: true,
});
const pdfErrors = (pdfTranspiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(pdfErrors.length, 0, 'confirmed ticket PDF renderer must transpile');
const nodeRequire = createRequire(import.meta.url);
const pdfModule = { exports: {} };
const pdfContext = vm.createContext({
  module: pdfModule,
  exports: pdfModule.exports,
  require(specifier) {
    if (specifier === '@/lib/flights/airline-pnr') return airlinePnrModule;
    if (specifier === 'server-only') return {};
    if (specifier === 'pdfkit') return nodeRequire('pdfkit');
    if (specifier === 'node:path') return nodeRequire('node:path');
    throw new Error(`Unexpected runtime import in ticket PDF renderer: ${specifier}`);
  },
  Intl,
  Date,
  Number,
  Buffer,
  Promise,
  URL,
  AbortSignal,
  fetch,
  process: { cwd: () => root },
});
new vm.Script(pdfTranspiled.outputText, { filename: pdfSourcePath }).runInContext(pdfContext);
const ticketPdf = await pdfModule.exports.confirmedBookingTicketPdf({
  booking: confirmedBooking,
  travellers,
});
assert.ok(Buffer.isBuffer(ticketPdf));
assert.ok(
  ticketPdf.length > 2_500,
  `confirmed ticket PDF should contain a full document (${ticketPdf.length} bytes)`
);
assert.equal(ticketPdf.subarray(0, 5).toString('ascii'), '%PDF-');

const notificationSource = fs.readFileSync(
  path.join(root, 'lib', 'email', 'notifications.ts'),
  'utf8'
);
assert.ok(notificationSource.includes("filename: `${booking.publicRef}-ticket.pdf`"));
assert.ok(notificationSource.includes("contentType: 'application/pdf'"));
assert.ok(notificationSource.includes('attachments,'));

const nextConfigSource = fs.readFileSync(path.join(root, 'next.config.js'), 'utf8');
assert.ok(
  nextConfigSource.includes("'pdfkit',"),
  'PDFKit must remain external so its built-in font assets resolve on the server'
);
const statusDeliverySource = fs.readFileSync(
  path.join(root, 'lib', 'email', 'booking-status-delivery.ts'),
  'utf8'
);
assert.ok(statusDeliverySource.includes('claimBookingNotificationOutboxes'));
assert.ok(statusDeliverySource.includes('failBookingNotificationDelivery'));
assert.ok(statusDeliverySource.includes('markBookingNotificationDeliverySent'));
assert.ok(statusDeliverySource.includes('bookingStatusEmailFromEventSnapshot'));
assert.ok(statusDeliverySource.includes('finalizeBookingNotificationOutbox'));
assert.doesNotMatch(
  statusDeliverySource,
  /pendingBookingStatusEmailJobs|claimBookingStatusEmail|alreadySentByLegacyPath/,
  'Occurrence worker must not return to the legacy booking/status ledger'
);

const mailerSource = fs.readFileSync(path.join(root, 'lib', 'email', 'mailer.ts'), 'utf8');
assert.ok(mailerSource.includes('process.env.SYSTEM_EMAIL_BCC?.trim()'));
assert.ok(mailerSource.includes('bcc:'));

const statusEmailMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0041_booking_status_emails.sql'),
  'utf8'
);
for (const required of [
  'booking_status_email_deliveries',
  'claim_booking_status_email',
  'pending_booking_status_email_jobs',
  "interval '15 minutes'",
  "outcome = 'sent'",
  "'baseline'",
  'to service_role',
]) {
  assert.ok(statusEmailMigration.includes(required), `Status email migration needs ${required}`);
}
const statusCronMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0042_supabase_booking_status_email_cron.sql'),
  'utf8'
);
for (const required of [
  'pg_cron',
  'pg_net',
  'vault.decrypted_secrets',
  'booking_status_app_url',
  'booking_status_cron_secret',
  'booking-status-emails-every-15-minutes',
  '*/15 * * * *',
  "'Authorization'",
  'cron.schedule',
]) {
  assert.ok(statusCronMigration.includes(required), `Status cron migration needs ${required}`);
}
assert.ok(
  !fs.existsSync(path.join(root, 'vercel.json')),
  'Vercel Hobby deployment must not contain a frequent Vercel Cron schedule'
);
const confirmedRetryMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0035_confirmed_email_retry_safety.sql'),
  'utf8'
);
for (const required of [
  'for update',
  "interval '15 minutes'",
  'confirmed_email_attempt_count',
  'confirmed_email_last_error',
  'fail_confirmed_booking_email',
  'to service_role',
]) {
  assert.ok(confirmedRetryMigration.includes(required), `Confirmed retry migration needs ${required}`);
}

// A reservation locator must never be printed under the Airline PNR label.
const missingAirline = bookingStatusEmail({
  booking: { ...booking, airlinesPnr: ['BG', '  '], pnr: 'RESERVATION-ONLY' },
  travellers, bookingUrl,
}, 'confirmed');
assert.match(missingAirline.text, /Airline PNR: Not available/);
assert.ok(!missingAirline.html.includes('RESERVATION-ONLY'));
assert.ok(!missingAirline.text.includes('RESERVATION-ONLY'));

const companyBooking = { ...booking, headerContact: {
  name: 'Kaliganj Travels', licenseNo: '', mobile: '+880 1795-271171',
  email: 'support@kaliganjtravel.com',
  address: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh',
  logoUrl: '/brand/kaliganj-logo.png',
} };
const companyEmail = bookingStatusEmail({ booking: companyBooking, travellers, bookingUrl }, 'on-hold');
assert.match(companyEmail.html, /cid:kaliganj-logo/);
assert.ok(!companyEmail.html.includes('src="/brand/'), 'Emails must embed local branding with CID');
assert.match(companyEmail.html, /License No: --/);
assert.doesNotMatch(companyEmail.html + companyEmail.text, /shapon|shopon|0016548|9638032941|1921232941/i);
const companyPdf = await pdfModule.exports.confirmedBookingTicketPdf({
  booking: { ...confirmedBooking, headerContact: companyBooking.headerContact }, travellers,
});
assert.ok(companyPdf.length > 2500);
assert.match(notificationSource, /cid: 'kaliganj-logo'/);

const outputArg = process.argv.find((argument) => argument.startsWith('--output='));
if (outputArg) {
  const outputPath = path.resolve(root, outputArg.slice('--output='.length));
  const previewHtml = BOOKING_ICON_NAMES.reduce((html, name) => {
    const iconPath = path.join(root, 'public', 'email-icons', `${name}.png`);
    const dataUrl = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
    return html.replaceAll(`cid:kaliganj-${name}`, dataUrl);
  }, companyEmail.html).replaceAll('cid:kaliganj-logo', `data:image/png;base64,${fs.readFileSync(path.join(root, 'public/brand/kaliganj-logo.png')).toString('base64')}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, previewHtml, 'utf8');
  console.log(`ON HOLD booking email preview written to ${outputPath}`);
}

const pdfOutputArg = process.argv.find((argument) => argument.startsWith('--pdf-output='));
if (pdfOutputArg) {
  const outputPath = path.resolve(root, pdfOutputArg.slice('--pdf-output='.length));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, companyPdf);
  console.log(`CONFIRMED ticket PDF preview written to ${outputPath}`);
}

console.log('All booking status templates, delivery tracking, PDF, and hidden BCC verification passed.');
