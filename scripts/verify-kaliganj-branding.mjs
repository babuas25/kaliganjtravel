import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const read = (file) => fs.readFileSync(file, 'utf8');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
// Historical migration source is deliberately outside the runtime scan. The
// applied baseline must remain byte-for-byte identical to its installation receipt.
const forbidden = /best deal trip|bdtripint|BDTI|shapon|shopon|0016548|9638[- ]?032941|1921[- ]?232941|1989[- ]?715039|dhankhola|meherpur|shomobai/i;
const runtimeFiles = ['app', 'components', 'lib', 'public'].flatMap(files)
  .filter((file) => /\.(?:tsx?|jsx?|mjs|css|json|svg|html)$/.test(file));
const integrationFiles = new Set([
  'app/(dashboard)/dashboard/bookings/[reference]/page.tsx',
  'app/api/flights/booking/cancel/route.ts',
  'app/api/flights/booking/issue/route.ts',
  'app/api/flights/booking/route.ts',
  'app/api/flights/booking/shapon-status/route.ts',
  'components/flights/BookingActions.tsx',
  'components/flights/BookingDetails.tsx',
  'app/api/webhooks/shapon-ticketing-deadline/route.ts',
  'lib/db/booking-ticketing-time.ts',
  'lib/db/flight-bookings.ts',
  'lib/db/shapontravels-cancellation.ts',
  'lib/email/booking-event-snapshot.ts',
  'lib/flights/booking.ts',
  'lib/reports/issued-tickets.ts',
  'lib/sms/booking-issued-snapshot.ts',
]);
const integrationNames = new Set([
  'apply_shapon_booking_deadline', 'SHAPON_DEADLINE_EVENT_CONFLICT', 'SHAPON_DEADLINE_REVISION_CONFLICT',
  'shaponBooking', 'shaponPlatformCancellation', 'ShaponPlatformCancellation', 'ShaponSavedCancellation',
  'advanceShaponCancellationRetry', 'finalizeShaponPlatformCancellation', 'readShaponCancellationPublicRef',
  'readShaponCancellationState', 'isShaponPreClosureRefusal', 'retryShaponCancellation',
  'isShaponCancellationReadUnavailable',
  'SHAPON_CANCEL_RETRY_UNAVAILABLE', 'SHAPON_CANCEL_REFUSED', 'SHAPON_SAVED_CLOSURE_UNVERIFIED',
  'SHAPON_CLOSURE_STORAGE_UNAVAILABLE', 'SHAPON_CANCELLABLE_STATUSES', 'shapon_platform_cancel',
  'finalize_shapon_platform_cancel_v1', 'advance_shapon_platform_cancel_retry_v1',
  'resolve_shapon_cancellation_not_sent_v1', 'shaponIssueObservedAt', 'shaponCurrentStatus',
  'closedShaponReference', 'setClosedShaponReference', 'shaponClosed', 'shaponCancelRequest',
  'shaponCancelChecking', 'setShaponCancelChecking', 'shaponCancelRetry', 'setShaponCancelRetry',
  'saveShaponCancelRequest', 'checkShaponCancellation',
  'shapon_unverified_airline_pnr', 'shapon_passenger_ticket_refs', 'shaponPassengerTicketRefs',
]);
function withoutIntegrationNames(file, source) {
  if (!integrationFiles.has(file) && !file.startsWith('lib/shapontravels/')) return source;
  return source
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, name => integrationNames.has(name) ? '' : name)
    .replace(/\bshapon-cancel:/g, '')
    .replace(/\bShapon(?:['’]s)?(?= platform (?:closure|display state)\b| passenger receipt\b| did not close on this retry\b| declined (?:cancellation|this retry)\b)/g, '')
    .replace(/(?<=sent to |closed on |booking on )Shapon\b/g, '');
}
for (const file of integrationFiles) {
  assert.doesNotMatch(withoutIntegrationNames(file, 'shaponPlatformCancellation; Shapon platform closure'), forbidden);
  for (const identity of ['Shapon Travels', 'Best Deal Trip', 'Dhankhola']) {
    assert.match(withoutIntegrationNames(file, identity), forbidden);
  }
}
// Supplier identifiers and their status-check code paths are not site identity.
// Keep guarding standalone legacy company-name mentions in the runtime.
for (const file of runtimeFiles) {
  const identityText = read(file)
    .replace(/shapon(?:travels|[-_]?status)/gi, '')
    .replace(/\b(?:shapon_current_status|record_shapon_booking_current_status_v1|restoreUnsentShaponCancellation|restore_shapon_cancellation_not_sent_v1|canConfirmShaponExternalTicket|canOfferShaponExternalTicketConfirmation|verifyShaponExternalTicketConfirmation|shapon_external_ticket_confirmations|confirm_shapon_external_ticket_v1|previewShaponTicketPayment|verifyShaponCancellationRecovery|isShaponTicketingRecovery|resolve_shapon_cancelled_refresh_v1|preview_shapon_ticket_payment_v1|shapon_saved_status|shapon_saved_booking_v1)\b/g, '')
    .replace(/\bShapon(?:['’]s)?(?= (?:saved|booking|ticket|receipt|portal|status|returned|cancellation)\b)/g, '');
  assert.doesNotMatch(withoutIntegrationNames(file, identityText), forbidden, file);
}
function load(file) {
  const compiled = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('exports', 'module', compiled)(module.exports, module);
  return module.exports;
}
const site = load('lib/site.ts');
assert.equal(site.SITE_EMAIL, 'support@kaliganjtravel.com');
assert.equal(site.SITE_PHONE_HREF, 'tel:+8801795271171');
assert.equal(site.SITE_WHATSAPP_HREF, 'https://wa.me/8801795271171');
assert.equal(site.SITE_LICENSE_NUMBER, '');
assert.ok(fs.statSync(`public${site.SITE_LOGO_PATH}`).size > 1000);
const { colors } = load('lib/colors.ts');
assert.equal(colors.navy[950], '#171717');
assert.equal(colors.brand.orange, '#f68712');
for (const [level, color] of Object.entries(colors.navy)) {
  assert.ok(read('app/globals.css').includes(`--navy-${level}: ${color}`) ||
    read('app/globals.css').includes(`--navy-${level}:  ${color}`));
  assert.ok(read('tailwind.config.ts').includes(color));
}
for (const color of Object.values(colors.brand)) assert.ok(read('tailwind.config.ts').includes(color));
const receipt = JSON.parse(read('supabase/fresh-install/installation.json'));
const baseline = read('supabase/fresh-install/supabase/migrations/20260911000000_kaliganj_baseline.sql');
assert.equal(createHash('sha256').update(baseline).digest('hex'), receipt.baselineSha256);
assert.doesNotMatch(baseline, forbidden);
const contactMigration = read('supabase/fresh-install/supabase/migrations/20260911010000_kaliganj_company_contact.sql');
for (const value of [site.SITE_EMAIL, site.SITE_PHONE, site.SITE_ADDRESS]) assert.ok(contactMigration.includes(value));
assert.doesNotMatch(contactMigration, /insert\s+into|delete\s+from|drop\s+|alter\s+/i);
assert.match(read('lib/email/booking-template.ts'), /cid:kaliganj-logo/);
assert.match(read('lib/email/notifications.ts'), /cid: 'kaliganj-logo'/);
assert.doesNotMatch(read('lib/email/mailer.ts'), /support@kaliganjtravel\.com/,
  'A public contact address must not silently become an SMTP sender or hidden BCC');
console.log(JSON.stringify({ status: 'passed', runtimeFilesScanned: runtimeFiles.length,
  legacyIdentityAbsent: true, themeConsistent: true, baselineUnchanged: true,
  companyContactConsistent: true, bookingLogoEmbedded: true }, null, 2));
