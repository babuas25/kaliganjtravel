import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const source = fs.readFileSync('components/dashboard/bookings/TriploverSupplierStatusPanel.tsx', 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const baseTime = Date.parse('2026-10-13T08:00:00Z');

function nodes(tree, found = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, found));
  else if (tree && typeof tree === 'object') {
    found.push(tree);
    nodes(tree.props?.children, found);
  }
  return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function statusCheck(overrides = {}) {
  return { checkId: 'synthetic-check', checkedAt: new Date(baseTime).toISOString(),
    expiresAt: new Date(baseTime + 300_000).toISOString(), verified: true, verifiedStatus: 'issued',
    supplierStatus: 'Issued', pnr: 'KT1234', airlinePnrs: ['XY1234'],
    tickets: [0, 1, 2].map(passengerIndex => ({ passengerIndex, ticketNumbers: ['XY1234'] })),
    reason: null, source: 'ticket_report', localStatus: 'unconfirmed', paymentState: 'reconciliation', ...overrides };
}
function walletPreview(overrides = {}) {
  return { ok: true, eligible: true, checkId: 'synthetic-check', previewHash: 'synthetic-preview-hash',
    walletEffect: 'capture_hold', amount: 300_000, currency: 'BDT', availableBefore: 500_000,
    availableAfter: 500_000, holdBefore: 350_000, holdAfter: 50_000, ...overrides };
}
function confirmationResult(overrides = {}) {
  return { ok: true, replay: false, bookingReference: 'KTT-SYNTHETIC', bookingStatus: 'confirmed',
    paymentState: 'captured', walletEffect: 'capture_hold', amount: 300_000, currency: 'BDT', ...overrides };
}

function fixture() {
  const slots = [], effects = [], timers = new Map(), responses = [], calls = [];
  let hookIndex = 0, dirty = false, clock = baseTime, refreshes = 0, nonce = 0;
  let props = { bookingReference: 'KTT-SYNTHETIC', localStatus: 'unconfirmed', paymentState: 'reconciliation',
    passengers: ['ALPHA', 'BRAVO', 'CHARLIE'].map(firstName => ({ firstName, lastName: 'TEST' })) };
  class FakeDate extends Date {
    constructor(...arguments_) { super(...(arguments_.length ? arguments_ : [clock])); }
    static now() { return clock; }
  }
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === 'function' ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback, dependencies) {
      const index = hookIndex++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const module = { exports: {} };
  const money = (minor, currency) => new Intl.NumberFormat('en-BD', {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).format(minor / 100);
  new vm.Script(output).runInNewContext({
    module, exports: module.exports, Date: FakeDate, Intl, console,
    crypto: { randomUUID: () => `synthetic-request-${++nonce}` },
    window: { setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); } },
    async fetch(url, options) {
      calls.push({ url, body: JSON.parse(options.body) });
      assert.ok(responses.length, 'All transport must use a queued synthetic response');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return await next;
    },
    require(name) {
      const imports = { react: hooks, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
        'next/navigation': { useRouter: () => ({ refresh: () => { refreshes += 1; } }) },
        '@/lib/wallet/money': { formatWalletMoney: money } };
      assert.ok(Object.hasOwn(imports, name), `Unexpected UI import ${name}`);
      return imports[name];
    },
  });
  const Component = module.exports.default;
  function render() {
    let tree;
    for (let pass = 0; pass < 10; pass += 1) {
      dirty = false; hookIndex = 0;
      tree = Component(props);
      while (effects.length) effects.shift()();
      if (!dirty) return tree;
    }
    throw new Error('Fixture hooks did not settle');
  }
  function button(label) {
    return nodes(render()).find(node => node.type === 'button' && text(node).trim() === label);
  }
  function respond(data, status = 200) {
    responses.push({ ok: status >= 200 && status < 300, status, json: async () => plain(data) });
  }
  async function click(label) {
    const target = button(label);
    assert.ok(target, `${label} is visible`);
    assert.equal(target.props.disabled, false, `${label} is enabled`);
    target.props.onClick();
    await flush(); render();
  }
  async function checked() {
    respond({ success: true, data: { check: statusCheck() } });
    await click('Refresh Status');
  }
  async function previewed() {
    await checked();
    respond({ success: true, data: { preview: walletPreview() } });
    await click('Review confirmation');
  }
  function consent() {
    nodes(render()).find(node => node.type === 'input' && node.props.type === 'checkbox')
      .props.onChange({ target: { checked: true } });
    render();
  }
  return { calls, responses, render, button, respond, click, checked, previewed, consent, money,
    get refreshes() { return refreshes; },
    advance(milliseconds) { clock += milliseconds; for (const callback of timers.values()) callback(); render(); },
    update(value) { props = { ...props, ...value }; return render(); },
  };
}

// The visible check has distinct local/supplier facts, passenger-aligned PNRs,
// a Dhaka read time and an exact capture-only preview requiring user consent.
{
  const f = fixture();
  await f.previewed();
  const visible = text(f.render());
  assert.ok(visible.includes('Unconfirmed') && visible.includes('Reconciliation') && visible.includes('Issued'));
  assert.ok(visible.includes('14:00') && visible.includes('Dhaka'));
  assert.ok(visible.includes('ALPHA TEST') && visible.includes('BRAVO TEST') && visible.includes('CHARLIE TEST'));
  for (const amount of [300_000, 500_000, 350_000, 50_000]) assert.ok(visible.includes(f.money(amount, 'BDT')));
  assert.equal(f.button('Confirm issued ticket').props.disabled, true);
  f.consent();
  assert.equal(f.button('Confirm issued ticket').props.disabled, false);
  f.respond({ success: true, data: { result: confirmationResult() } });
  await f.click('Confirm issued ticket');
  assert.equal(f.refreshes, 1);
  const confirm = f.calls.at(-1);
  assert.deepEqual(confirm.body, { action: 'confirm', bookingReference: 'KTT-SYNTHETIC', checkId: 'synthetic-check',
    previewHash: 'synthetic-preview-hash', requestId: 'synthetic-request-1', confirmed: true });
}

// A double click cannot send a second mutation. An uncertain answer freezes
// choices and retries the identical request even after its supplier check expires.
{
  const f = fixture();
  await f.previewed(); f.consent();
  let reject;
  f.responses.push(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
  const confirm = f.button('Confirm issued ticket');
  confirm.props.onClick(); confirm.props.onClick();
  assert.equal(f.calls.filter(call => call.body.action === 'confirm').length, 1);
  reject(new Error('Synthetic connection lost'));
  await flush(); f.render();
  assert.equal(f.button('Refresh Status').props.disabled, true);
  assert.equal(f.button('Review confirmation'), undefined);
  assert.ok(f.button('Retry same confirmation'));
  const original = f.calls.at(-1).body;
  f.advance(360_000);
  f.respond({ success: true, data: { result: confirmationResult({ replay: true }) } });
  await f.click('Retry same confirmation');
  assert.deepEqual(f.calls.at(-1).body, original, 'An expiry must not change a pending mutation identity or intent');
  assert.equal(f.refreshes, 1);
}

// Failed pre-mutation requests can be reviewed again, while unknown-outcome
// errors remain locked even if represented as a parsed HTTP 4xx response.
for (const [status, code, frozen] of [[409, 'CHECK_SUPERSEDED', false], [503, 'RECEIPT_UNAVAILABLE', true], [409, 'CONFIRMATION_OUTCOME_UNKNOWN', true]]) {
  const f = fixture(); await f.previewed(); f.consent();
  f.respond({ success: false, error: { errorCode: code, errorMessage: 'Synthetic confirmation failure' } }, status);
  await f.click('Confirm issued ticket');
  assert.equal(f.button('Refresh Status').props.disabled, frozen);
  assert.equal(Boolean(f.button('Retry same confirmation')), frozen);
}
{
  const f = fixture(); await f.previewed(); f.consent();
  f.responses.push(new Error('Synthetic response lost'));
  await f.click('Confirm issued ticket');
  const original = f.calls.at(-1).body;
  f.update({ localStatus: 'confirmed', paymentState: 'captured' });
  assert.equal(f.button('Refresh Status').props.disabled, true);
  assert.equal(f.button('Review confirmation'), undefined);
  f.respond({ success: true, data: { result: confirmationResult({ replay: true }) } });
  await f.click('Retry same confirmation');
  assert.deepEqual(f.calls.at(-1).body, original,
    'A parent booking update preserves an ambiguous same-booking intent for receipt retrieval');
}
for (const result of [undefined, confirmationResult({ ok: false }), confirmationResult({ bookingReference: 'KTT-OTHER' }),
  confirmationResult({ amount: 1 }), confirmationResult({ paymentState: 'unpaid' }), confirmationResult({ walletEffect: 'debit_available' })]) {
  const f = fixture(); await f.previewed(); f.consent();
  f.respond({ success: true, data: result ? { result } : {} });
  await f.click('Confirm issued ticket');
  assert.equal(f.refreshes, 0, 'Malformed successful responses never claim confirmation');
  assert.equal(f.button('Refresh Status').props.disabled, true);
  assert.ok(f.button('Retry same confirmation'));
  const original = f.calls.at(-1).body;
  f.respond({ success: true, data: { result: confirmationResult({ replay: true }) } });
  await f.click('Retry same confirmation');
  assert.deepEqual(f.calls.at(-1).body, original);
  assert.equal(f.refreshes, 1);
}

// Expired checks and changed booking props invalidate the financial preview.
{
  const f = fixture(); await f.previewed(); f.consent();
  f.advance(300_001);
  assert.equal(f.button('Confirm issued ticket'), undefined);
  assert.equal(f.button('Review confirmation').props.disabled, true);
  assert.equal(f.button('Refresh Status').props.disabled, false);
}
{
  const f = fixture(); await f.previewed(); f.consent();
  f.update({ localStatus: 'confirmed', paymentState: 'captured' });
  assert.equal(f.button('Review confirmation'), undefined);
  assert.equal(f.button('Confirm issued ticket'), undefined);
  assert.ok(text(f.render()).includes('Confirmed') && text(f.render()).includes('Captured'));
}
{
  const f = fixture(); await f.previewed(); f.consent();
  f.respond({ success: true, data: { check: statusCheck({ checkId: 'new-check' }) } });
  await f.click('Refresh Status');
  assert.equal(f.button('Confirm issued ticket'), undefined);
  assert.equal(nodes(f.render()).some(node => node.type === 'input'), false);
}

// Ineligible, unverified and terminal supplier outcomes cannot offer a capture.
for (const value of [statusCheck({ verified: false, verifiedStatus: 'unknown', supplierStatus: null, reason: 'Needs staff review' }),
  statusCheck({ verifiedStatus: 'cancelled', supplierStatus: 'Cancelled' }), statusCheck({ localStatus: 'confirmed' })]) {
  const f = fixture(); f.respond({ success: true, data: { check: value } }); await f.click('Refresh Status');
  assert.equal(f.button('Review confirmation'), undefined);
}
{
  const f = fixture(); await f.checked();
  f.respond({ success: true, data: { preview: { ok: false, eligible: false, code: 'EXISTING_HOLD_REQUIRED' } } });
  await f.click('Review confirmation');
  assert.equal(f.button('Confirm issued ticket'), undefined);
  assert.ok(text(f.render()).includes('Existing Hold Required'));
}
{
  const f = fixture(); await f.checked();
  f.respond({ success: true, data: { preview: walletPreview({ walletEffect: 'debit_available' }) } });
  await f.click('Review confirmation');
  assert.equal(f.button('Confirm issued ticket'), undefined, 'The UI never enables a fresh wallet debit');
}

// Verify placement and the narrow native/Admin scope without calling any backend.
const page = fs.readFileSync('app/(dashboard)/dashboard/bookings/[reference]/page.tsx', 'utf8');
assert.match(page, /session\.role === 'admin' \|\| session\.role === 'superadmin'/);
assert.match(page, /usesStoredBookingReferences\(row\) && !row\.direct_ticketing/);
assert.match(page, /Boolean\(storedTicketReferences\(row\)\)/);
assert.match(page, /allowSupplierRefresh=\{\s*!showTriploverSupplierStatus/);
const sidebar = page.slice(page.indexOf('sidebarContent={'), page.indexOf('{visibilityContext?.ok'));
assert.ok(sidebar.indexOf('<TriploverSupplierStatusPanel') < sidebar.indexOf('<BookingLifecycleTimeline'));
console.log('Triplover status UI: scoped sidebar, verified facts, capture preview, consent, single mutation, stable ambiguous retry and stale-state checks passed.');
