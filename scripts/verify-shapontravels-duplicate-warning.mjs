import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
function load(path, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Response, URL, Buffer, AbortSignal, Error, Date, console,
    require(name) {
      if (name === 'server-only') return {};
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error('Unexpected dependency: ' + name);
    },
    ...globals,
  });
  new vm.Script(compiled.outputText, { filename: path }).runInContext(context);
  return module.exports;
}

const messages = load('lib/flights/booking-failure-message.ts');
const bookingId = '11111111-1111-4111-8111-111111111111';
const reference = 'STR26101813503709';
const pending = {
  bookingId, state: 'outcome_unknown', requiresReconciliation: true, automaticRetryAllowed: false,
  warning: { code: 'SUPPLIER_DUPLICATE_REPORTED',
    title: '<script>private supplier text</script>', message: 'private passenger',
    existingBookingReference: 'STR26101814242115' },
};
let cases = 0;
for (const [body, header, expected] of [
  [pending, reference, true],
  [pending, null, true],
  [pending, '<script>bad</script>', true],
  [{ ...pending, warning: undefined }, reference, false],
  [{ ...pending, state: 'pending' }, reference, false],
  [{ ...pending, automaticRetryAllowed: true }, reference, false],
  [{ ...pending, requiresReconciliation: false }, reference, false],
  [{ ...pending, bookingId: 'invalid' }, reference, false],
  [{ ...pending, warning: { code: 'OTHER', message: 'Duplicate booking for Passenger: private' } }, reference, false],
]) {
  let writes = 0, before = 0, received = 0;
  const client = load('lib/shapontravels/client.ts', {}, {
    process: { env: {
      SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
      CLIENT_ID: '55555555-5555-4555-8555-555555555555', CLIENT_SECRET: 'fixture-secret',
    } },
    fetch: async url => {
      if (url.pathname === '/auth/token') {
        return new Response(JSON.stringify({ access_token: 'stm_fixture', token_type: 'Bearer', expires_in: 1800 }));
      }
      assert.equal(url.pathname, '/api/Book');
      writes++;
      return new Response(JSON.stringify(body), {
        status: 202, headers: header ? { 'x-booking-reference': header } : {},
      });
    },
  });
  let failure;
  try {
    await client.shapontravelsBookRequest({ fixture: true }, 'fixture-key', {
      beforeRequest: async () => { before++; },
      onResponse: async value => { assert.equal(value.httpStatus, 202); received++; },
    });
    assert.fail('202 must remain unresolved');
  } catch (error) {
    assert.ok(error instanceof client.ShapontravelsWriteError);
    failure = error;
  }
  assert.equal(failure.kind, 'pending');
  assert.equal(failure.code, 'BOOKING_OUTCOME_UNKNOWN');
  assert.equal(writes, 1);
  assert.equal(before, 1);
  assert.equal(received, 1);
  const warning = messages.duplicateBookingWarning(failure.message);
  assert.equal(Boolean(warning), expected);
  if (expected) {
    assert.equal(warning.currentRequestReference, header === reference ? reference : null);
    assert.equal(warning.existingBookingReference, null);
    assert.equal(warning.action, 'contact_support');
    const customerMessage = messages.unverifiedBookingMessage(failure.message, true);
    assert.ok(!messages.unverifiedBookingMessage(failure.message).includes('Current request reference:'));
    assert.ok(customerMessage.includes('Supplier Reported a Duplicate Booking'));
    assert.ok(!customerMessage.includes('private passenger'));
    assert.ok(!customerMessage.includes('STR26101814242115'));
    assert.ok(!customerMessage.includes('<script>'));
    // Restoring the persisted error gives the same warning after a reload.
    assert.equal(JSON.stringify(messages.duplicateBookingWarning(JSON.parse(JSON.stringify(failure.message)))), JSON.stringify(warning));
  }
  const classification = load('lib/booking-lifecycle/supplier-uncertainty.ts', {
    '@/lib/shapontravels/client': client,
    '@/lib/triplover/client': { TriploverError: class extends Error {} },
    '@/lib/booking-lifecycle/supplier-write-hooks': { SupplierWriteBoundaryError: class extends Error {} },
  });
  for (const directTicketing of [false, true]) {
    const result = classification.classifySupplierWriteFailure(failure, {
      supplierCallStarted: true, supplierResponseObserved: true, supplierResponseRecorded: true, httpStatus: 202,
    }, { directTicketing });
    assert.equal(result.failureClass, 'uncertain');
    assert.equal(result.fundsMustRemainProtected, true);
    assert.equal(result.automaticReplayAllowed, false);
  }
  cases++;
}
for (const raw of [
  'Duplicate booking for Passenger: private passenger',
  'Shapontravels Book BOOKING_OUTCOME_UNKNOWN',
  'Shapontravels Book BOOKING_OUTCOME_UNKNOWN bookingId=' + bookingId + ' reference=<script> warning=SUPPLIER_DUPLICATE_REPORTED',
]) {
  assert.equal(messages.duplicateBookingWarning(raw), null);
}
const warning = messages.duplicateBookingWarning(
  'Shapontravels Book BOOKING_OUTCOME_UNKNOWN bookingId=' + bookingId + ' reference=' + reference + ' warning=SUPPLIER_DUPLICATE_REPORTED'
);
const Notice = load('components/flights/BookingFailureNotice.tsx', {
  'next/link': { default: props => React.createElement('a', props) },
}).default;
const html = renderToStaticMarkup(React.createElement(Notice, { message: 'fallback', warning }));
assert.ok(html.includes('Current request reference:'));
assert.ok(html.includes(reference));
assert.ok(html.includes('Supplier Reported a Duplicate Booking'));
assert.ok(html.includes('href="/contact-us"'));
assert.ok(html.includes('Contact Support'));
assert.ok(!html.includes('View Existing Booking'));
assert.ok(!html.includes('fallback'));
assert.ok(renderToStaticMarkup(React.createElement(Notice, { message: 'Ordinary failure' })).includes('Ordinary failure'));
console.log('PASS duplicate warning: ' + cases + ' HTTP variants, durable restoration, private-text filtering, safe rendering, Hold/Direct uncertainty and no replay');

// Exercise the actual local recovery endpoint with durable attempt data and owner checks.
let owner = 'owner', account = 'shapontravels', savedState = 'unknown';
const durableMessage = 'Shapontravels Book BOOKING_OUTCOME_UNKNOWN bookingId=' + bookingId +
  ' reference=' + reference + ' warning=SUPPLIER_DUPLICATE_REPORTED';
const recovery = load('app/api/flights/booking/status/route.ts', {
  zod: require('zod'),
  'next/server': { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) } },
  '@/lib/flights/booking-failure-message': messages,
  '@/lib/db/booking-read-error': { BOOKING_READ_ERROR_CODE: 'BOOKING_READ_UNAVAILABLE', BOOKING_READ_ERROR_MESSAGE: 'Unavailable' },
  '@/lib/dashboard/session': { getDashboardSession: async () => ({ clerkId: 'owner' }) },
  '@/lib/dashboard/bookings': { bookingScopeFor: () => ({ kind: 'user', clerkId: 'owner' }) },
  '@/lib/db/booking-attempts': { readBookingAttempt: async () => ({
    id: bookingId, user_id: owner, state: savedState, supplier_account: account, supplier_message: durableMessage,
  }) },
  '@/lib/db/flight-bookings': {
    readBookingByAttemptId: async () => ({ id: bookingId, status: 'on-hold' }),
    publicBookingWithHeaderContact: async row => row,
  },
});
const recover = () => recovery.POST(new Request('https://client.example.test/api/flights/booking/status', {
  method: 'POST', body: JSON.stringify({ bookingId, accessToken: 'a'.repeat(64) }),
}));
let recovered = await recover();
assert.equal(recovered.status, 503);
let envelope = await recovered.json();
assert.equal(envelope.error.errorCode, 'BOOKING_OUTCOME_UNKNOWN');
assert.equal(envelope.error.warning.currentRequestReference, reference);
assert.equal(envelope.error.warning.existingBookingReference, null);
owner = 'other-owner';
recovered = await recover();
assert.equal(recovered.status, 404);
assert.ok(!(await recovered.text()).includes(reference));
owner = 'owner'; account = 'triplover';
envelope = await (await recover()).json();
assert.equal(envelope.error.warning, undefined, 'native supplier text cannot spoof the API warning');
assert.ok(!envelope.error.errorMessage.includes(reference));
account = 'shapontravels'; savedState = 'succeeded';
envelope = await (await recover()).json();
assert.equal(envelope.success, true);
assert.equal(envelope.error, undefined);
console.log('PASS recovery endpoint: same-owner durable warning, foreign-owner denial, supplier boundary and resolved status');
