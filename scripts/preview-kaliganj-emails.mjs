import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { createRequire } from 'node:module';
const nativeRequire = createRequire(import.meta.url);
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)((name) => name === 'server-only' ? {} : name.startsWith('@/') ? load(`${name.slice(2)}.ts`) : nativeRequire(name), module, module.exports);
  return module.exports;
}
const t = load('lib/email/templates.ts');
const url = 'https://kaliganjtravel.com/dashboard';
const deposit = { requestReference: 'KT-DEP-DEMO', amount: 'BDT 12,500.00', paymentMethod: 'Bank transfer', transactionReference: 'DEMO-123', depositDate: '12 September 2026', requesterName: 'Ayesha', dashboardUrl: url };
const cases = [
  ['welcome', t.welcomeEmail({ firstName: 'Ayesha', dashboardUrl: url })],
  ['invitation', t.invitationEmail({ roleLabel: 'Agent', invitationUrl: url })],
  ['account', t.accountCreatedEmail({ firstName: 'Ayesha', signInUrl: url })],
  ['access', t.roleChangedEmail({ firstName: 'Ayesha', previousRoleLabel: 'Customer', nextRoleLabel: 'Agent', dashboardUrl: url })],
  ['deposit-received', t.depositRequestConfirmationEmail(deposit)],
  ['deposit-review', t.depositRequestReviewEmail({ ...deposit, requesterEmail: 'demo@example.com', agencyName: 'Demo agency' })],
  ...['approved', 'rejected'].map(decision => [`deposit-${decision}`, t.depositRequestDecisionEmail({ ...deposit, decision, reviewRemarks: 'Demo review note' })]),
  ...['customer', 'internal'].map(audience => [`ticket-${audience}`, t.ticketManagementNotificationEmail({ audience, actionLabel: 'Refund', eventLabel: 'Approved', requestReference: 'KT-REQ-DEMO', statusLabel: 'Approved', effectiveAt: '12 September 2026', dashboardUrl: url, amount: 'BDT 4,000.00' })]),
  ['ticket-alert', t.pendingTicketAlertEmail({ bookingReference: 'KT-DEMO', pnr: 'DEMO12', amount: 'BDT 12,500.00', bookingUrl: url, supplierReason: 'Demo: supplier balance insufficient' })],
];
const output = 'output/email-preview';
fs.mkdirSync(output, { recursive: true });
for (const [name, content] of cases) {
  assert.doesNotMatch(content.html + content.text, /shapon|shopon|undefined|\[object Object\]/i, name);
  assert.ok(content.html.includes('#f68712') && content.html.includes('Kaliganj Travels'), name);
  fs.writeFileSync(path.join(output, `${name}.html`), content.html);
}
const unsafe = t.welcomeEmail({ firstName: '<script>alert(1)</script>', dashboardUrl: url });
assert.ok(unsafe.html.includes('&lt;script&gt;') && !unsafe.html.includes('<script>'));
const links = [...cases.map(([name]) => name), 'booking', 'issued'];
fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kaliganj email previews</title><style>body{font:16px Arial;background:#f7f5f2;color:#262626;max-width:900px;margin:40px auto;padding:20px}a{display:inline-block;padding:14px;margin:5px;border:1px solid #ddd;color:#ad4f08;background:white}h1{border-top:6px solid #f68712;padding-top:20px}</style><h1>Kaliganj Travels · Email previews</h1><p>Demo data only. No emails sent.</p>${links.map(name => `<a href="${name}.html">${name}</a>`).join('')}<a href="../itinerary-offer-preview.html">Flight offer</a><a href="../pdf/kaliganj-ticket-preview.pdf">Issued ticket PDF</a></html>`);
console.log(`Rendered and checked ${cases.length} notification variants in ${output}.`);
