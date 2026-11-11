import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadTypeScript(file, dependencies = {}, env = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function('exports', 'require', 'process', outputText)(
    exports,
    name => name === 'server-only' ? {} : (dependencies[name] ?? require(name)),
    { env },
  );
  return exports;
}

const verifier = loadTypeScript('lib/shapontravels/deadline-webhook.ts', {
  './deadline-time': loadTypeScript('lib/shapontravels/deadline-time.ts'),
});
const current = Buffer.alloc(32, 31);
const previous = Buffer.alloc(32, 44);
const secret = key => 'whsec_' + key.toString('base64');
const enabled = {
  SHAPONTRAVELS_DEADLINE_WEBHOOK_ENABLED: 'true',
  SHAPONTRAVELS_DEADLINE_WEBHOOK_SECRET: secret(current),
};
const event = {
  type: 'booking.ticketing_deadline.changed',
  id: '1aa59ec2-25c1-4d63-844c-000000000001',
  bookingId: '86d768ef-0674-4116-8ba6-32e58813c91f',
  reference: 'STR26111112000001',
  revision: 1,
  occurredAt: '2026-11-11T06:00:00.123Z',
  deadline: '2028-02-29T17:10:53.123456789+06:00',
};

function signature(key, eventId, timestamp, raw) {
  const hmac = createHmac('sha256', key);
  hmac.update(`${eventId}.${timestamp}.`, 'ascii').update(raw);
  return 'v1,' + hmac.digest('base64');
}

function request(options = {}) {
  const raw = options.raw ?? JSON.stringify(event, null, 2);
  const eventId = options.eventId ?? event.id;
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signingKeys = options.signingKeys ?? [current];
  const headers = new Headers({
    'content-type': 'application/json',
    'webhook-id': eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signingKeys.map(key => signature(key, eventId, timestamp, raw)).join(' '),
  });
  options.headers?.(headers);
  return new Request('https://receiver.example.test/api/webhooks/shapon-ticketing-deadline', {
    method: 'POST', headers, body: options.body ?? raw, duplex: 'half',
  });
}

test('requires dedicated enabled configuration and validates both rotation keys', () => {
  assert.equal(verifier.deadlineWebhookKeys({}), null);
  assert.equal(verifier.deadlineWebhookKeys({ ...enabled, SHAPONTRAVELS_DEADLINE_WEBHOOK_ENABLED: 'false' }), null);
  for (const value of [undefined, 'another-key', 'whsec_fake', secret(Buffer.alloc(31))]) {
    assert.equal(verifier.deadlineWebhookKeys({ ...enabled, SHAPONTRAVELS_DEADLINE_WEBHOOK_SECRET: value }), null);
  }
  assert.equal(verifier.deadlineWebhookKeys({ ...enabled, SHAPONTRAVELS_DEADLINE_WEBHOOK_PREVIOUS_SECRET: 'invalid' }), null);
  assert.deepEqual(verifier.deadlineWebhookKeys({
    ...enabled, SHAPONTRAVELS_DEADLINE_WEBHOOK_PREVIOUS_SECRET: secret(previous),
  }), [current, previous]);
});

test('authenticates exact bytes and supports overlapping keys and signature tokens', async () => {
  const keys = [current, previous];
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request(), keys), { event });
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ signingKeys: [previous] }), keys), { event });
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ signingKeys: [previous, current] }), [current]), { event });
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request(), [previous]), { status: 401 });
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ body: JSON.stringify(event) }), keys), { status: 401 });
});

test('rejects missing or folded duplicate headers, stale and future signatures, and invalid content type', async () => {
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ headers: headers => headers.delete(name) }), [current]), { status: 400 });
    assert.deepEqual(await verifier.verifyDeadlineWebhook(request({
      headers: headers => headers.append(name, headers.get(name)),
    }), [current]), { status: 400 });
  }
  for (const skew of [-301, 301]) {
    assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ timestamp: String(2000 + skew) }), [current], 2000), { status: 401 });
  }
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({
    headers: headers => headers.set('content-type', 'text/plain'),
  }), [current]), { status: 415 });
});

test('bounds both declared and streamed payload sizes before processing', async () => {
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({
    headers: headers => headers.set('content-length', '4097'),
  }), [current]), { status: 413 });
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4090));
      controller.enqueue(new Uint8Array(7));
    },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ body: stream }), [current]), { status: 413 });
  assert.equal(cancelled, true);
});

test('rejects signed malformed data and accepts a signed clear without rounding a timestamp', async () => {
  for (const invalid of [
    { id: '1aa59ec2-25c1-4d63-844c-000000000002' },
    { bookingId: 'KTTABCDEF' },
    { reference: 'STR26111112000000' },
    { revision: 1.5 },
    { revision: 9007199254740992 },
    { occurredAt: '2026-11-31T06:00:00Z' },
    { deadline: '2029-02-29T17:10:53+06:00' },
    { deadline: '2028-02-29T17:10:53Z' },
    { type: 'booking.status.changed' },
    { status: 'confirmed' },
  ]) {
    const raw = JSON.stringify({ ...event, ...invalid });
    assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ raw }), [current]), { status: 400 });
  }
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ raw: Buffer.from([0xff]) }), [current]), { status: 400 });
  const clear = { ...event, deadline: null };
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ raw: JSON.stringify(clear) }), [current]), { event: clear });
  const leapSecond = { ...event, deadline: '2017-01-01T05:59:60+06:00' };
  assert.deepEqual(await verifier.verifyDeadlineWebhook(request({ raw: JSON.stringify(leapSecond) }), [current]), { event: leapSecond });
});

test('calls the single scoped RPC only after verification and acknowledges committed results', async () => {
  const calls = [];
  let database;
  const { POST } = loadTypeScript('app/api/webhooks/shapon-ticketing-deadline/route.ts', {
    '@/lib/shapontravels/deadline-webhook': verifier,
    '@/lib/supabase/server': { supabaseAdmin: () => database },
  }, enabled);
  let answer;
  database = { rpc: async (...args) => { calls.push(args); return answer; } };
  assert.equal((await POST(request({ signingKeys: [previous] }))).status, 401);
  assert.equal(calls.length, 0);
  for (const result of ['updated', 'unchanged', 'stale', 'duplicate', 'ignored']) {
    answer = { data: { result }, error: null };
    const response = await POST(request());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
    assert.deepEqual(calls.at(-1), ['apply_shapon_booking_deadline', {
      p_booking_id: null,
      p_supplier_booking_id: event.bookingId,
      p_supplier_public_ref: event.reference,
      p_expected_updated_at: null,
      p_revision: event.revision,
      p_deadline_at: event.deadline,
      p_event_id: event.id,
    }]);
  }
  for (const result of ['missing', 'deferred', 'changed', 'unknown']) {
    answer = { data: { result }, error: null };
    assert.equal((await POST(request())).status, 503);
  }
  for (const message of ['SHAPON_DEADLINE_EVENT_CONFLICT', 'SHAPON_DEADLINE_REVISION_CONFLICT']) {
    answer = { data: null, error: { code: '22023', message } };
    assert.equal((await POST(request())).status, 409);
  }
  for (const message of ['SHAPON_DEADLINE_INPUT_INVALID', 'SHAPON_DEADLINE_IDENTITY_MISMATCH']) {
    answer = { data: null, error: { code: '22023', message } };
    assert.equal((await POST(request())).status, 400);
  }
  answer = { data: null, error: { code: '57014' } };
  assert.equal((await POST(request())).status, 503);
  database = { rpc: async () => { throw new Error('Storage unavailable'); } };
  assert.equal((await POST(request())).status, 503);
  database = null;
  assert.equal((await POST(request())).status, 503);
});

test('disabled route performs no database action', async () => {
  const { POST } = loadTypeScript('app/api/webhooks/shapon-ticketing-deadline/route.ts', {
    '@/lib/shapontravels/deadline-webhook': verifier,
    '@/lib/supabase/server': { supabaseAdmin: () => assert.fail('Database must stay untouched') },
  });
  assert.equal((await POST(request())).status, 503);
});
