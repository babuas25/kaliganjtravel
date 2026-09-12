import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
let session = { clerkId: 'test-user', role: 'admin' };
let allowed = true;
const dailyCounts = new Map();
let rejectDelivery = false;
const deliveries = [];
const deliver = async (type, payload) => {
  if (rejectDelivery) throw new Error('Provider failure');
  deliveries.push({ type, ...payload });
};
const mocks = {
  zod: require('zod'),
  '@/lib/dashboard/session': { getDashboardSession: async () => session },
  '@/lib/email/mailer': { sendEmail: (payload) => deliver('email', payload) },
  '@/lib/sms/bulksmsbd': { sendBulkSmsBdText: (payload) => deliver('sms', payload) },
  '@/lib/rate-limit': {
    checkActionLimit: async () => ({ ok: allowed, retryAfterSeconds: 60 }),
    rateLimitMessage: () => 'Try again later.',
    checkB2bItinerarySmsDailyLimit: async (userId) => {
      const count = dailyCounts.get(userId) || 0;
      if (count >= 5) return { ok: false, retryAfterSeconds: 60 };
      dailyCounts.set(userId, count + 1);
      return { ok: true };
    },
  },
  '@/lib/wallet/http': {
    walletOk: (data) => Response.json({ success: true, data }),
    walletFail: (status, errorCode, errorMessage) => Response.json({ success: false, error: { errorCode, errorMessage } }, { status }),
  },
};
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync('app/api/flights/share-itinerary/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: module.exports, require: (id) => {
  assert.ok(id in mocks, `Unexpected dependency ${id}`);
  return mocks[id];
} });
const post = (overrides = {}) => module.exports.POST(new Request('http://localhost/api/flights/share-itinerary', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ channel: 'sms', recipient: '01712345678', subject: 'Flight itinerary', message: '✈️ Test airline\n🛫 DAC → SIN', ...overrides }),
}));
session = null;
assert.equal((await post()).status, 401);
session = { clerkId: 'test-user', role: 'staff_media' };
assert.equal((await post()).status, 403);
session.role = 'admin';
assert.equal((await post({ recipient: 'hello' })).status, 400);
assert.equal((await post({ channel: 'email', recipient: 'invalid' })).status, 400);
assert.equal((await post({ subject: 'Invalid\nSubject' })).status, 400);
assert.equal((await post({ message: 'x'.repeat(2001) })).status, 400);
assert.equal(deliveries.length, 0);
allowed = false;
assert.equal((await post()).status, 429);
assert.equal(deliveries.length, 0);
allowed = true;
assert.equal((await post()).status, 200);
assert.equal(deliveries[0].to, '8801712345678');
assert.match(deliveries[0].message, /✈️/);
assert.equal((await post({ recipient: '+880 1712-345678' })).status, 200);
assert.equal(deliveries[1].to, '8801712345678');
assert.equal((await post({ channel: 'email', recipient: 'recipient@example.com', message: '<script>alert(1)</script>\nFlight details' })).status, 200);
assert.equal(deliveries[2].to, 'recipient@example.com');
assert.ok(deliveries[2].html.includes('&lt;script&gt;'));
assert.ok(!deliveries[2].html.includes('<script>'));
rejectDelivery = true;
assert.equal((await post()).status, 503);
assert.equal(deliveries.length, 3);
console.log('Itinerary sharing: auth, recipient validation, rate limits, SMS normalization, email escaping, provider success and failure passed. No real messages sent.');

rejectDelivery = false;
for (const role of ['b2b', 'b2b_sub']) {
  session = { clerkId: `test-${role}`, role };
  for (let i = 0; i < 5; i++) assert.equal((await post()).status, 200);
  const before = deliveries.length;
  const blocked = await post();
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.errorCode, 'DAILY_SMS_LIMIT');
  assert.equal(deliveries.length, before);
  assert.equal((await post({ channel: 'email', recipient: 'recipient@example.com' })).status, 200);
}
session = { clerkId: 'test-admin', role: 'admin' };
for (let i = 0; i < 6; i++) assert.equal((await post()).status, 200);
console.log('B2B and sub-user daily SMS cap: five allowed, sixth blocked; email and admin unaffected.');

const rateModule = { exports: {} };
const rateCalls = [];
vm.runInNewContext(ts.transpileModule(readFileSync('lib/rate-limit.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: rateModule.exports, console, process, require: (id) => {
  if (id === 'server-only') return {};
  if (id === '@/lib/supabase/server') return { supabaseAdmin: () => ({ rpc: async (name, args) => {
    rateCalls.push(args);
    return { data: { allowed: true }, error: null };
  } }) };
  throw new Error(`Unexpected dependency ${id}`);
} });
await rateModule.exports.checkB2bItinerarySmsDailyLimit('user', new Date('2026-09-07T17:59:59Z'));
await rateModule.exports.checkB2bItinerarySmsDailyLimit('user', new Date('2026-09-07T18:00:00Z'));
assert.ok(rateCalls[0].p_key.endsWith('2026-09-07'));
assert.ok(rateCalls[1].p_key.endsWith('2026-09-08'));
assert.equal(rateCalls[0].p_limit, 5);
assert.equal(rateCalls[0].p_window_ms, 86400000);
console.log('Shared quota uses five sends per user and switches keys at Bangladesh midnight.');
