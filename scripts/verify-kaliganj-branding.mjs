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
const forbidden = /shapon|shopon|0016548|9638[- ]?032941|1921[- ]?232941|1989[- ]?715039|dhankhola|meherpur|shomobai/i;
const runtimeFiles = ['app', 'components', 'lib', 'public'].flatMap(files)
  .filter((file) => /\.(?:tsx?|jsx?|mjs|css|json|svg|html)$/.test(file));
for (const file of runtimeFiles) assert.doesNotMatch(read(file), forbidden, file);
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
