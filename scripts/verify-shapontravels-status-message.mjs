import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new vm.Script(compiled.outputText, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Intl,
    require: relative => load(path.resolve(path.dirname(file), `${relative}.ts`)),
  });
  return module.exports;
}

const { formatShapontravelsBookingStatus: format } = load('lib/shapontravels/booking-status-message.ts');
const selectedTime = '2026-10-03T14:43:33+06:00';
const laterTime = '2026-10-03T09:01:02Z';
const current = {
  status: 'cancelled', bookingState: 'held', supplierStatus: 'Cancelled',
  supplierCheckedAt: selectedTime, verified: true, source: 'supplier_pnr',
  checkedAt: selectedTime, reviewRequired: false,
  lastCheck: { checkedAt: selectedTime, verified: true, reasonCode: null },
};
const check = {
  result: 'verified', currentStatus: current, currentStatusState: 'available',
  originalBookingStatus: 'Created', supplierStatus: 'Cancelled',
  supplierPublicRef: 'STRTESTCURRENT01',
  checkedAt: '2026-10-03T16:00:00Z',
};
const text = value => [value.headline, ...value.details].join('\n');
let cases = 0;

// Use the normalized seven-status contract, never the immutable Created receipt.
for (const [status, label] of [
  ['cancelled', 'Cancelled'], ['confirmed', 'Confirmed'], ['on-hold', 'On Hold'],
  ['pending', 'Pending'], ['in-progress', 'In Progress'], ['expired', 'Expired'],
  ['unconfirmed', 'Unconfirmed'],
]) {
  assert.equal(format({ ...check, currentStatus: { ...current, status } }).headline,
    `Current API booking status: ${label}.`);
  cases++;
}
const cancelled = text(format(check));
assert.match(cancelled, /14:43:33 \(Bangladesh time\)/);
assert.match(cancelled, /Supplier reference: STRTESTCURRENT01/);
assert.doesNotMatch(cancelled, /Created|22:00:00|Last verified supplier status|staff review/);
assert.match(cancelled, /Wallet and payment are unchanged/);
assert.doesNotMatch(text(format({ ...check, currentStatus: {
  ...current, checkedAt: '2026-10-03T08:43:33Z',
} })), /Last verified supplier status/, 'equal instants with different offsets are not duplicate evidence');
cases++;

// Receipt identity verification does not turn an Admin decision into a verified PNR read.
const admin = text(format({ ...check, currentStatus: {
  ...current, status: 'confirmed', source: 'admin_decision', verified: false,
  checkedAt: '2026-10-03T08:40:00Z', reviewRequired: true,
} }));
assert.match(admin, /Current API booking status: Confirmed/);
assert.match(admin, /Admin decision \(not machine-verified\)/);
assert.match(admin, /Last verified supplier status: Cancelled/);
assert.match(admin, /14:40:00/);
assert.match(admin, /14:43:33/);
assert.match(admin, /staff review before further booking or financial action/);
assert.doesNotMatch(admin, /Created/);
cases++;

const pending = text(format({ ...check, result: 'pending', currentStatus: {
  ...current, status: 'pending', source: 'saved_booking', verified: false,
  checkedAt: null, supplierStatus: null, supplierCheckedAt: null, lastCheck: null,
} }));
assert.match(pending, /Current API booking status: Pending/);
assert.match(pending, /Saved booking record \(not machine-verified\)/);
assert.match(pending, /No source timestamp/);
cases++;

// A failed latest check keeps the selected evidence and its original timestamp.
for (const reasonCode of [null, 'SUPPLIER_TIMEOUT', 'SUPPLIER_READ_FAILED', 'SUPPLIER_RECONCILIATION_FAILED']) {
  const failed = text(format({ ...check, currentStatus: {
    ...current, lastCheck: { checkedAt: laterTime, verified: false, reasonCode },
  } }));
  assert.match(failed, /Current API booking status: Cancelled/);
  assert.match(failed, /14:43:33/);
  assert.match(failed, /Latest supplier check was not verified at .*15:01:02/);
  assert.match(failed, /prior status and supplier evidence above are retained/);
  cases++;
}

const legacy = text(format({ ...check, currentStatus: null, currentStatusState: 'absent', supplierStatus: 'Created' }));
assert.match(legacy, /Current API booking status unavailable/);
assert.match(legacy, /Historical Book receipt status: Created/);
assert.doesNotMatch(legacy, /Current API booking status: Created/);
const invalid = text(format({ ...check, currentStatus: null, currentStatusState: 'invalid', supplierStatus: 'Created' }));
assert.match(invalid, /invalid current-status metadata/);
assert.doesNotMatch(invalid, /Historical Book receipt status: Created|Current API booking status: Created/);
cases += 2;

for (const result of ['mismatch', 'unverified', 'not_found']) {
  const message = text(format({ ...check, result }));
  assert.match(message, /Current API booking status unavailable/);
  assert.doesNotMatch(message, /Current API booking status: Cancelled|Source: Supplier|Supplier reference/);
  cases++;
}
assert.match(text(format({ ...check, result: 'pending', currentStatus: null, currentStatusState: 'absent', originalBookingStatus: null })), /processing is still pending/);
cases++;

const saved = text(format({ ...check, currentStatusStorage: 'saved', projectionUpdated: true }));
assert.match(saved, /Saved display evidence updated/);
assert.doesNotMatch(saved, /local booking status.*unchanged|local booking status.*not change/);
const unsaved = text(format({ ...check, currentStatusStorage: 'unavailable', projectionUpdated: false }));
assert.match(unsaved, /Current API booking status: Cancelled/);
assert.match(unsaved, /supplier lookup succeeded, but the saved display snapshot could not be updated/);
cases += 2;

const localConflict = text(format({ ...check, currentStatus: {
  ...current, status: 'confirmed', source: 'ticket_operation',
}, displayStatus: 'on-hold', displayReviewRequired: true }));
assert.match(localConflict, /Current API booking status: Confirmed/);
assert.match(localConflict, /Saved local booking status: On Hold/);
assert.match(localConflict, /staff review before further booking or financial action/);
assert.doesNotMatch(localConflict, /local booking status: Confirmed/i);
cases++;

const attempt = text(format(check, 'attempt'));
assert.match(attempt, /Current API booking status: Cancelled/);
assert.match(attempt, /Supplier reference: STRTESTCURRENT01/);
assert.match(attempt, /Keep this case open until staff resolve it/);
assert.match(attempt, /Do not submit Book again/);
assert.match(attempt, /Wallet and payment are unchanged\. No ticket request was sent by this check/);
cases++;

// Exercise the real client callbacks without running effects, network or a DB.
const jsx = (type, props) => ({ type, props });
const uiStub = new Proxy({}, { get: (_target, key) => {
  const component = () => null;
  Object.defineProperty(component, 'name', { value: String(key) });
  return component;
} });
function uiHarness(file) {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  let refreshes = 0;
  let response;
  const requests = [];
  const react = {
    useState: initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
      }];
    },
    useRef: initial => {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect: () => {},
    useCallback: callback => callback,
  };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new vm.Script(compiled.outputText, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Intl,
    crypto: { randomUUID: () => 'offline-status-request' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: response.success, json: async () => response };
    },
    require: name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'next/navigation') return { useRouter: () => ({ refresh: () => { refreshes++; } }) };
      if (name === '@/lib/shapontravels/booking-status-message') return { formatShapontravelsBookingStatus: format };
      if (name === '@/components/feedback/StatusFeedback') return { useStatusFeedback: () => () => {} };
      if (name === '@/lib/dashboard/booking-review-responsibility') return { bookingReviewResponsibility: () => 'Staff' };
      return uiStub;
    },
  });
  return {
    component: module.exports.default,
    render: (component, props) => {
      stateIndex = 0; refIndex = 0;
      return component(props);
    },
    respond: data => { response = data; },
    get refreshes() { return refreshes; },
    requests,
  };
}
function visibleText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  return node?.props ? visibleText(node.props.children) : '';
}
function find(node, matches) {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, matches); if (result) return result; }
  } else if (node?.props) {
    if (matches(node)) return node;
    return find(node.props.children, matches);
  }
  return null;
}
async function clickCheck(tree, name) {
  const button = find(tree, node => node.type === 'button' && visibleText(node).trim() === name);
  assert.ok(button, `${name} button rendered`);
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
}
const actions = uiHarness('components/flights/BookingActions.tsx');
const props = {
  status: 'on-hold', directTicketing: false, allowCancellation: false,
  bookingReference: 'KTTTEST01', passengerCopies: [], paymentState: 'unpaid',
  allowShaponStatusCheck: true, allowTicketing: false, manualBooking: true,
};
for (const projectionUpdated of [false, true]) {
  actions.respond({ success: true, data: { ...check, projectionUpdated, currentStatusStorage: 'saved',
    supplierTicket: { result: 'verified', ticketCount: 1 } } });
  await clickCheck(actions.render(actions.component, props), 'Verify Supplier Status');
  const rendered = visibleText(actions.render(actions.component, props));
  assert.match(rendered, /Current API booking status: Cancelled/);
  assert.match(rendered, /Supplier ticket evidence matches 1 passenger/);
  assert.equal(actions.refreshes, projectionUpdated ? 1 : 0, 'only a changed saved projection refreshes the page');
  cases++;
}
actions.respond({ success: false, error: { errorMessage: 'Offline check failed.' } });
await clickCheck(actions.render(actions.component, props), 'Verify Supplier Status');
const retained = visibleText(actions.render(actions.component, props));
assert.match(retained, /Current API booking status: Cancelled/);
assert.match(retained, /14:43:33/);
assert.match(retained, /Offline check failed/);
assert.equal(actions.refreshes, 1, 'a failed check cannot refresh or remove the prior presentation');
assert.ok(actions.requests.every(request => request.url === '/api/flights/booking/shapon-status'));
cases++;

const attempts = uiHarness('components/dashboard/bookings/BookingAttemptReconciliationPanel.tsx');
const panel = attempts.component({ attempts: [{
  caseId: 'offline-case', attemptId: 'offline-attempt', supplier: 'shapontravels',
  attemptState: 'unknown', directTicketing: false, recoveredBooking: null,
  readPlan: { strategy: 'manual_supplier_portal_only', supplierIdentity: { uniqueTransId: 'offline-identity' } },
  reconciliation: { assignedTeam: 'support', dueAt: null }, flags: { slaBreached: false },
  wallet: null, timestamps: { supplierCallStartedAt: null, supplierResponseReceivedAt: null },
}] });
const attemptCheck = find(panel, node => node.type?.name === 'SupplierAttemptStatusCheck');
assert.ok(attemptCheck);
attempts.respond({ success: true, data: { ...check, projectionUpdated: true } });
await clickCheck(attempts.render(attemptCheck.type, attemptCheck.props), 'Check supplier status');
let attemptRendered = visibleText(attempts.render(attemptCheck.type, attemptCheck.props));
assert.match(attemptRendered, /Current API booking status: Cancelled/);
assert.match(attemptRendered, /Keep this case open until staff resolve it/);
assert.equal(attempts.refreshes, 0, 'remote status never resolves or refreshes the attempt case');
attempts.respond({ success: false, error: { errorMessage: 'Offline attempt check failed.' } });
await clickCheck(attempts.render(attemptCheck.type, attemptCheck.props), 'Check supplier status');
attemptRendered = visibleText(attempts.render(attemptCheck.type, attemptCheck.props));
assert.match(attemptRendered, /Current API booking status: Cancelled/);
assert.match(attemptRendered, /Offline attempt check failed/);
assert.equal(attempts.refreshes, 0);
assert.ok(attempts.requests.every(request => request.url === '/api/admin/booking-lifecycle/attempts/offline-attempt/shapon-status'));
cases += 2;

console.log(`Shapontravels status messages verified (${cases} offline cases).`);
