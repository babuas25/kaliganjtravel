import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const mailer = read('lib', 'email', 'mailer.ts');
const notifications = read('lib', 'email', 'notifications.ts');
const worker = read('lib', 'email', 'booking-status-delivery.ts');
const template = read('lib', 'email', 'booking-template.ts');
const snapshotMigration = read(
  'supabase',
  'migrations',
  '0073_booking_notification_render_snapshot.sql'
);
const deliveryMigration = read(
  'supabase',
  'migrations',
  '0074_booking_notification_recipient_delivery.sql'
);

assert.ok(
  mailer.includes('process.env.SYSTEM_EMAIL_BCC?.trim()') &&
    mailer.includes('bcc:') &&
    mailer.includes('BCC is part of the SMTP envelope only'),
  'Central mailer must inject the hidden archive copy at the SMTP envelope'
);
assert.doesNotMatch(
  mailer.slice(
    mailer.indexOf('export type EmailMessage'),
    mailer.indexOf('type EmailConfig')
  ),
  /bcc/i,
  'Callers must not control or expose the hidden BCC through EmailMessage'
);
assert.match(
  notifications,
  /sendBookingStatusEventDelivery[\s\S]*?await sendEmail\(\{/i,
  'Occurrence delivery must pass through the central envelope mailer'
);
assert.doesNotMatch(
  `${worker}\n${template}\n${snapshotMigration}`,
  /ota\.shapontravels\.com@gmail\.com|SYSTEM_EMAIL_BCC|\bbcc\b/i,
  'Hidden archive identity must not enter worker, content, or event snapshot'
);
assert.match(
  deliveryMigration,
  /and not candidate\.is_hidden_copy/i,
  'Visible-recipient claims must not expose an internal hidden-copy row'
);
assert.doesNotMatch(
  worker,
  /system_copy|isHiddenCopy|recipientKind.*hidden/i,
  'Customer worker must process visible recipients only'
);

// Execute the real mailer with isolated configuration and a fake transport.
// No local credentials or network services are used by this check.
const env = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'sender@example.test',
  SMTP_PASSWORD: 'synthetic-password',
  SAMPLE_TRAVELS_SMTP_PASSWORD: 'obsolete-password',
  EMAIL_FROM_ADDRESS: 'sender@example.test',
};
const sent = [];
const transports = [];
const module = { exports: {} };
const compiled = ts.transpileModule(mailer, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  process: { env },
  require(name) {
    if (name === 'server-only') return {};
    assert.equal(name, 'nodemailer');
    return {
      createTransport(options) {
        transports.push(options);
        return {
          async sendMail(message) { sent.push(message); },
          close() {},
        };
      },
    };
  },
});
const message = {
  to: 'customer@example.test',
  subject: 'Synthetic test',
  html: '<p>Test</p>',
  text: 'Test',
};
await module.exports.sendEmail(message);
assert.equal(sent.at(-1).bcc, undefined, 'No configured archive means no BCC');
assert.equal(sent.at(-1).from.name, 'Kaliganj Travels');
assert.equal(transports[0].auth.pass, 'synthetic-password');
env.SYSTEM_EMAIL_BCC = '  Archive@example.test  ';
await module.exports.sendEmail(message);
assert.equal(sent.at(-1).bcc, 'Archive@example.test');
assert.equal(sent.at(-1).to, message.to);
assert.equal(sent.at(-1).html, message.html);
assert.equal(sent.at(-1).text, message.text);
await module.exports.sendEmail({ ...message, to: 'archive@EXAMPLE.test' });
assert.equal(sent.at(-1).bcc, undefined, 'Do not send duplicate archive copies');
env.SYSTEM_EMAIL_BCC = '   ';
await module.exports.sendEmail(message);
assert.equal(sent.at(-1).bcc, undefined);
await module.exports.sendEmail({ ...message, agencyConfirmationCopy: true });
assert.equal(sent.at(-1).bcc, 'kaliganjtravels@gmail.com');
assert.equal(sent.at(-1).html, message.html);
await module.exports.sendEmail({ ...message, agencyConfirmationCopy: true, to: 'KaliganjTravels@gmail.com' });
assert.equal(sent.at(-1).bcc, undefined);
env.SYSTEM_EMAIL_BCC = 'kaliganjtravels@gmail.com';
await module.exports.sendEmail({ ...message, agencyConfirmationCopy: true });
assert.equal(sent.at(-1).bcc, 'kaliganjtravels@gmail.com');
env.SYSTEM_EMAIL_BCC = 'archive@example.test';
await module.exports.sendEmail({ ...message, agencyConfirmationCopy: true });
assert.equal(sent.at(-1).bcc, 'archive@example.test, kaliganjtravels@gmail.com');
const count = sent.length;
for (const invalid of ['invalid', 'a@example.test,b@example.test', 'a@example.test\r\nBcc: b@example.test']) {
  env.SYSTEM_EMAIL_BCC = invalid;
  await assert.rejects(module.exports.sendEmail(message), /SYSTEM_EMAIL_BCC/);
}
assert.equal(sent.length, count, 'Invalid archive configuration must prevent sending');
delete env.SYSTEM_EMAIL_BCC;
delete env.SMTP_PASSWORD;
await assert.rejects(module.exports.sendEmail(message), /Email is not configured/);
assert.equal(sent.length, count, 'Obsolete company password must not enable sending');

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      hiddenCopyLayer: 'smtp_envelope_only',
      callerControlledBcc: false,
      snapshotContainsBcc: false,
      renderedContentContainsBcc: false,
      visibleDeliveryRowsExposeBcc: false,
    },
    null,
    2
  )
);
