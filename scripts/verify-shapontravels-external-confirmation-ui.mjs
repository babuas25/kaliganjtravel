import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const file = 'components/flights/BookingActions.tsx';
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const Wrapper = ({ children }) => children;
const wrappers = names => Object.fromEntries(names.map(name => [name, Wrapper]));
const settle = () => new Promise(resolve => setImmediate(resolve));
const envelope = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const candidate = {
  success: true,
  data: {
    externalTicketConfirmation: { eligible: true, amount: 12500.25, currency: 'BDT', paymentEffect: 'charge_wallet' },
    supplierTicket: { result: 'verified', ticketCount: 1 },
  },
};
const completed = (paymentEffect, changes = {}) => envelope({ success: true, data: {
  confirmed: true, charged: paymentEffect !== 'already_paid', paymentEffect, ...changes,
} });

function allNodes(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => allNodes(child, result));
  else if (tree && typeof tree === 'object') {
    result.push(tree);
    allNodes(tree.props?.children, result);
  }
  return result;
}
function label(tree) {
  if (Array.isArray(tree)) return tree.map(label).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? label(tree.props?.children) : '';
}

function harness(overrides = {}) {
  const slots = [];
  const calls = [];
  let slot = 0;
  let uuid = 0;
  let routerRefreshes = 0;
  let refresh = () => envelope(candidate);
  let confirm = request => completed(request.expectedPaymentEffect);
  const props = {
    status: 'on-hold', directTicketing: false, allowCancellation: true,
    allowTicketing: true, allowShaponStatusCheck: true,
    allowExternalTicketConfirmation: true,
    bookingReference: 'KTT261011111116', passengerCopies: [], paymentState: 'unpaid',
    ...overrides,
  };
  const imports = {
    './BookingActions.module.css': { default: {} },
    '@/lib/flights/booking-status': { CANCELLABLE_BOOKING_STATUSES: ['on-hold', 'pending', 'expired', 'unconfirmed'] },
    'react/jsx-runtime': jsxRuntime,
    react: {
      useState(initial) {
        const index = slot++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useRef(initial) {
        const index = slot++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useEffect() {},
      useCallback: callback => callback,
    },
    'lucide-react': icons,
    'next/navigation': { useRouter: () => ({ refresh() { routerRefreshes++; } }) },
    '@/components/feedback/StatusFeedback': { useStatusFeedback: () => () => {} },
    '@/lib/shapontravels/booking-status-message': {
      formatShapontravelsBookingStatus: () => ({ headline: 'Supplier confirmed', details: [] }),
    },
    '@/components/flights/PostTicketActionsPreview': { default: () => null },
    '@/components/ui/dropdown-menu': wrappers([
      'DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel',
      'DropdownMenuSeparator', 'DropdownMenuTrigger',
    ]),
    '@/components/ui/alert-dialog': wrappers([
      'AlertDialog', 'AlertDialogAction', 'AlertDialogCancel', 'AlertDialogContent',
      'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogHeader',
      'AlertDialogTitle', 'AlertDialogTrigger',
    ]),
  };
  const module = { exports: {} };
  new vm.Script(compiled, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
    console, AbortController,
    crypto: { randomUUID: () => `confirmation-${++uuid}` },
    window: { setTimeout: () => 0, clearTimeout() {} },
    fetch: async (url, options = {}) => {
      const request = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, request, method: options.method ?? 'GET' });
      if (url === '/api/flights/booking/shapon-status') return refresh();
      if (url === '/api/flights/booking/confirm-external-ticket') return confirm(request);
      assert.ok(url.startsWith('/api/flights/booking/issue/status?'), `Unexpected API ${url}`);
      return envelope({ success: true, data: {
        lifecycleStatus: props.status, paymentState: 'unpaid', operationState: null,
        reconciliationRequired: false, canSubmit: false, wallet: null, requiredAmount: 1250025,
      } });
    },
  });
  const Actions = module.exports.default;
  function tree() { slot = 0; return Actions(props); }
  function action(text) {
    return allNodes(tree()).find(node => label(node.props?.children) === text && node.props?.onClick);
  }
  return {
    props, calls, tree, action,
    button(text) {
      return allNodes(tree()).find(node => node.type === 'button' && label(node.props?.children) === text);
    },
    get routerRefreshes() { return routerRefreshes; },
    setRefresh(fn) { refresh = fn; },
    setConfirm(fn) { confirm = fn; },
    posts() { return calls.filter(call => call.url === '/api/flights/booking/confirm-external-ticket'); },
    retainedAttempt() { return slots.find(value => value?.current?.requestId)?.current; },
    async click(text) {
      const node = action(text);
      assert.ok(node, `Missing action ${text}`);
      assert.ok(!node.props.disabled, `${text} should be enabled`);
      node.props.onClick({ preventDefault() {} });
      await settle();
    },
    async verify() { await this.click('Refresh Status'); },
  };
}

const paymentEffects = ['charge_wallet', 'capture_hold', 'already_paid'];
function approvedCandidate(paymentEffect = 'charge_wallet') {
  return { success: true, data: { ...candidate.data, externalTicketConfirmation: {
    ...candidate.data.externalTicketConfirmation, paymentEffect,
    ...(paymentEffect === 'capture_hold' ? { existingHoldAmount: 12500.25, recovery: true } : {}),
  } } };
}

for (const paymentEffect of paymentEffects) {
  const test = harness({
    status: paymentEffect === 'charge_wallet' ? 'on-hold' : 'in-progress',
    paymentState: paymentEffect === 'already_paid' ? 'captured' : paymentEffect === 'capture_hold' ? 'reconciliation' : 'unpaid',
  });
  test.setRefresh(() => envelope(approvedCandidate(paymentEffect)));
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'confirmation starts hidden');
  await test.verify();
  const nodes = allNodes(test.tree());
  assert.ok(nodes.findIndex(node => node.type === 'button' && label(node.props.children) === 'Confirm Issued Ticket') >
    nodes.findIndex(node => node.type === 'button' && label(node.props.children) === 'Refresh Status'),
  'the confirmation button is below Refresh');
  assert.ok(label(test.tree()).includes('Confirm the issued ticket?'));
  assert.ok(label(test.tree()).includes('12,500.25'), 'the saved payment amount is displayed');
  assert.equal(test.action('Confirm Without Charge'), undefined, 'there is no discretionary payment bypass');
  assert.equal(test.action('Charge & Confirm'), undefined, 'there is one confirmation action');
  assert.equal(test.posts().length, 0, 'Refresh has no confirmation or financial write');
  if (paymentEffect === 'capture_hold') {
    assert.ok(label(test.tree()).includes('Confirming captures that original hold once.'));
    assert.ok(label(test.tree()).includes('No additional wallet debit will be made.'));
    assert.equal(label(test.tree()).includes('releases that hold'), false);
  } else if (paymentEffect === 'already_paid') {
    assert.ok(label(test.tree()).includes('The recorded payment of'));
    assert.ok(label(test.tree()).includes('will be reused. No additional wallet debit will be made.'));
  } else {
    assert.ok(label(test.tree()).includes('Confirming deducts the saved payable amount of'));
  }
  await test.click('Confirm Booking');
  assert.equal(test.posts().length, 1);
  assert.deepEqual(test.posts()[0].request, {
    bookingReference: test.props.bookingReference, requestId: 'confirmation-2', chargeWallet: true,
    expectedPaymentEffect: paymentEffect, expectedAmount: 12500.25,
  }, 'the request confirms the displayed server-derived effect and amount');
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'success hides stale confirmation');
  assert.ok(test.routerRefreshes > 0, 'success refreshes server-rendered booking and wallet');
  assert.ok(label(test.tree()).includes(paymentEffect === 'already_paid'
    ? 'The recorded payment was reused without an additional wallet debit.'
    : paymentEffect === 'capture_hold'
      ? 'The original wallet hold was captured once, without an additional wallet debit.'
      : 'The saved payable amount was charged to the booking owner’s wallet.'));
  assert.ok(test.calls.every(call => !['/api/flights/booking/issue', '/api/flights/booking/cancel'].includes(call.url)),
    'recovery never resubmits a supplier Issue or Cancel');
}

for (const changes of [
  { allowExternalTicketConfirmation: false }, { allowShaponStatusCheck: false },
  { status: 'confirmed' }, { status: 'cancelled' }, { directTicketing: true },
  { importedBooking: true }, { manualBooking: true },
]) {
  const test = harness(changes);
  if (changes.allowShaponStatusCheck === false) test.props.allowSupplierRefresh = true;
  if (changes.allowShaponStatusCheck !== false) await test.verify();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, `ineligible UI: ${JSON.stringify(changes)}`);
}

for (const result of [
  { supplierTicket: { result: 'verified', ticketCount: 1 } },
  ...[
    { eligible: false }, { amount: 0 }, { currency: 'USD' },
    { existingHoldAmount: -1 }, { existingHoldAmount: '12500.25' },
    { paymentEffect: undefined }, { paymentEffect: 'no_charge' },
    { paymentEffect: 'capture_hold' },
    { paymentEffect: 'capture_hold', existingHoldAmount: 12500 },
  ].map(change => ({ externalTicketConfirmation: { ...candidate.data.externalTicketConfirmation, ...change } })),
]) {
  for (const status of ['on-hold', 'in-progress']) {
    const test = harness({ status });
    test.setRefresh(() => envelope({ success: true, data: result }));
    await test.verify();
    assert.equal(test.button('Confirm Issued Ticket'), undefined,
      'only an explicit valid server candidate and payment effect unlock confirmation');
  }
}

for (const status of ['on-hold', 'pending', 'expired', 'unconfirmed', 'in-progress']) {
  const test = harness({ status });
  await test.verify();
  assert.ok(test.button('Confirm Issued Ticket'), `${status} can use a fresh server-approved candidate`);
  await test.click('Confirm Booking');
  assert.equal(test.posts()[0].request.chargeWallet, true);
}

for (const paymentEffect of paymentEffects) {
  const test = harness({ status: 'in-progress' });
  test.setRefresh(() => envelope(approvedCandidate(paymentEffect)));
  await test.verify();
  let attempt = 0;
  test.setConfirm(request => {
    if (++attempt === 1) throw new Error('Connection lost after confirmation');
    return completed(request.expectedPaymentEffect);
  });
  await test.click('Confirm Booking');
  assert.equal(test.action('Refresh Status').props.disabled, true,
    'a lost response retains the original payment intent across Refresh');
  assert.ok(allNodes(test.tree()).some(node => label(node.props?.children) === 'Not Now' && node.props.disabled),
    'the unresolved financial dialog cannot be dismissed');
  assert.ok(label(test.tree()).includes('Retry confirmation to check the saved result safely.'));
  assert.equal(test.action('Confirm Without Charge'), undefined);
  await test.click('Confirm Booking');
  assert.equal(test.posts().length, 2);
  assert.deepEqual(test.posts()[0].request, test.posts()[1].request,
    'retry retains the request ID, mandatory payment policy, displayed effect and exact amount');
  assert.equal(test.button('Confirm Issued Ticket'), undefined);
}

for (const failure of [
  () => envelope({ success: false, error: { errorCode: 'INSUFFICIENT_FUNDS' } }, 500),
  () => envelope({ success: false, error: { errorCode: 'ALREADY_CONFIRMED' } }, 409),
  () => ({ ok: true, status: 200, text: async () => '{malformed' }),
  () => envelope({ success: true, data: {} }),
  () => envelope({ success: true, data: { confirmed: true } }),
  () => completed('already_paid'),
  () => completed('charge_wallet', { charged: false }),
  () => completed('unknown'),
]) {
  const test = harness();
  await test.verify();
  test.setConfirm(failure);
  await test.click('Confirm Booking');
  assert.equal(test.button('Confirm Issued Ticket') !== undefined, true,
    'server failures and contradictory payment effects cannot appear as success');
  assert.equal(test.action('Refresh Status').props.disabled, true);
  test.setConfirm(() => completed('charge_wallet'));
  await test.click('Confirm Booking');
  assert.deepEqual(test.posts()[0].request, test.posts()[1].request);
}

for (const errorCode of ['PAYMENT_PREVIEW_CHANGED', 'PAYMENT_PREVIEW_REQUIRED']) {
  const test = harness();
  await test.verify();
  test.setConfirm(() => envelope({ success: false, error: { errorCode,
    errorMessage: 'Refresh and review the payment position before confirming.',
  } }, 409));
  await test.click('Confirm Booking');
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'stale payment previews are invalidated');
  assert.equal(test.action('Refresh Status').props.disabled, false, 'a new read is required');
  assert.equal(test.retainedAttempt(), undefined, 'a definite preflight refusal clears the old command');
}

for (const paymentEffect of paymentEffects) {
  const test = harness({ status: 'in-progress' });
  test.setRefresh(() => envelope(approvedCandidate(paymentEffect)));
  await test.verify();
  test.setConfirm(() => completed(paymentEffect, { charged: paymentEffect === 'already_paid' }));
  await test.click('Confirm Booking');
  assert.equal(test.action('Refresh Status').props.disabled, true,
    'a contradictory charged flag never completes the displayed payment effect');
  test.setConfirm(() => completed(paymentEffect));
  await test.click('Confirm Booking');
  assert.deepEqual(test.posts()[0].request, test.posts()[1].request);
}

{
  const test = harness();
  await test.verify();
  test.setConfirm(() => envelope({ success: false, error: {
    errorCode: 'INSUFFICIENT_FUNDS', errorMessage: 'The booking owner has insufficient wallet funds.',
  } }, 409));
  await test.click('Confirm Booking');
  assert.equal(test.action('Confirm Without Charge'), undefined, 'insufficient funds cannot expose a payment bypass');
  assert.equal(test.action('Refresh Status').props.disabled, false);
  test.setConfirm(() => completed('charge_wallet'));
  await test.click('Confirm Booking');
  assert.notEqual(test.posts()[0].request.requestId, test.posts()[1].request.requestId,
    'a definite rejection can start a new approved confirmation attempt');
  assert.equal(test.posts()[1].request.chargeWallet, true);
}

{
  const test = harness();
  await test.verify();
  let release;
  test.setConfirm(() => new Promise(resolve => { release = resolve; }));
  const action = test.action('Confirm Booking');
  action.props.onClick({ preventDefault() {} });
  action.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 1, 'repeated clicks before a render submit once');
  assert.equal(test.action('Confirming…').props.disabled, true);
  release(completed('charge_wallet'));
  await settle();
}

{
  const test = harness();
  await test.verify();
  const oldConfirm = test.action('Confirm Booking');
  let release;
  test.setRefresh(() => new Promise(resolve => { release = resolve; }));
  test.action('Refresh Status').props.onClick();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'new Refresh invalidates old evidence');
  release(envelope({ success: true, data: { supplierTicket: { result: 'pending' } } }));
  await settle();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'pending Refresh cannot reuse eligibility');
  oldConfirm.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 0, 'stale handlers cannot use invalidated evidence');
}

{
  const test = harness();
  await test.verify();
  const oldConfirm = test.action('Confirm Booking');
  test.props.bookingReference = 'KTT261011111117';
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'evidence cannot carry over to another booking');
  oldConfirm.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 0, 'old handlers cannot submit after navigating to another booking');
}

// A previous deployed UI could retain an unresolved no-charge request. It may
// recover that already committed decision, but no current action creates one.
for (const chargeWallet of [true, false]) {
  const test = harness();
  await test.verify();
  test.setConfirm(() => { throw new Error('Synthetic legacy response loss'); });
  await test.click('Confirm Booking');
  const legacy = test.retainedAttempt();
  legacy.chargeWallet = chargeWallet;
  delete legacy.expectedPaymentEffect;
  delete legacy.expectedAmount;
  test.setConfirm(() => envelope({ success: true, data: { confirmed: true, charged: chargeWallet, replay: true } }));
  await test.click('Confirm Booking');
  assert.deepEqual(test.posts()[1].request, {
    bookingReference: test.props.bookingReference, requestId: legacy.requestId, chargeWallet,
  }, 'legacy replay preserves its original command without manufacturing a new decision');
  assert.equal(test.button('Confirm Issued Ticket'), undefined);
}

// Exercise the page's actual role/capability composition with read-only stubs.
const pageFile = 'app/(dashboard)/dashboard/bookings/[reference]/page.tsx';
const pageSource = fs.readFileSync(pageFile, 'utf8');
const pageAst = ts.createSourceFile(pageFile, pageSource, ts.ScriptTarget.Latest);
const pageImports = { 'react/jsx-runtime': jsxRuntime };
for (const statement of pageAst.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
  const exports = {};
  const clause = statement.importClause;
  if (clause.name) exports.default = () => null;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const named of clause.namedBindings.elements) {
      exports[named.propertyName?.text ?? named.name.text] = () => null;
    }
  }
  pageImports[statement.moduleSpecifier.text] = exports;
}
let pageRole = 'admin';
const baseRow = {
  id: 'booking-id', public_ref: 'KTT261011111116', supplier: 'shapontravels',
  supplier_account: 'shapontravels', import_source: null, status: 'on-hold',
  lifecycle_status: 'on-hold', direct_ticketing: false, passengers: {},
};
let pageRow = baseRow;
const BookingDetails = () => null;
Object.assign(pageImports, {
  '@/components/flights/BookingDetails': { default: BookingDetails },
  '@/lib/dashboard/session': { getDashboardSession: async () => ({ role: pageRole, clerkId: 'admin' }) },
  'next/navigation': {
    notFound() { throw new Error('Unexpected missing fixture booking'); },
    redirect() { throw new Error('Unexpected fixture redirect'); },
  },
  '@/lib/db/flight-bookings': {
    readBookingByPublicRef: async () => pageRow,
    readBookingByPublicRefForSuperAdmin: async () => pageRow,
    publicBookingWithHeaderContact: async () => ({ status: pageRow.status }),
  },
  '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: false }) },
  '@/lib/db/booking-payment-resolution': { readBookingPaymentReturnContext: async () => null },
  '@/lib/booking-lifecycle/rollout': { bookingLifecycleRolloutState: () => ({}) },
  '@/lib/db/ticket-management': { listTicketManagementRequestReferencesForBookings: async () => new Map() },
  '@/lib/ticket-management/booking-actions': { ticketManagementActionsForBooking: () => [] },
});
const pageModule = { exports: {} };
new vm.Script(ts.transpileModule(pageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { filename: pageFile }).runInNewContext({
  module: pageModule, exports: pageModule.exports, console,
  require(name) { assert.ok(Object.hasOwn(pageImports, name), `Unexpected page import ${name}`); return pageImports[name]; },
});
async function pageAllows(role, changes = {}) {
  pageRole = role;
  pageRow = { ...baseRow, ...changes };
  const tree = await pageModule.exports.default({ params: Promise.resolve({ reference: baseRow.public_ref }) });
  return tree.props.children.find(child => child?.type === BookingDetails).props.allowExternalTicketConfirmation;
}
for (const role of ['admin', 'superadmin']) {
  for (const status of ['on-hold', 'pending', 'in-progress']) assert.equal(await pageAllows(role, { status }), true);
  for (const changes of [
    { supplier: 'triplover' }, { supplier_account: 'other' }, { import_source: 'MANUAL' },
    { import_source: 'IMP_EXP' }, { direct_ticketing: true }, { status: 'confirmed' },
    { status: 'cancelled' },
  ]) assert.equal(await pageAllows(role, changes), false);
}
for (const role of ['customer', 'agency', 'staff_support', 'staff_account', 'staff_admin']) {
  assert.equal(await pageAllows(role), false, `only Admin/Super Admin get financial confirmation: ${role}`);
}

console.log(JSON.stringify({
  checks: 'passed', singlePolicyConfirmation: true, allPaymentEffectsExplained: true,
  refreshNonfinancial: true, explicitEligibilityRequired: true,
  lostResponseKeepsPreviewAndRequestId: true, duplicateClicksSubmitOnce: true,
  noPaymentBypass: true, staleEvidenceInvalidated: true,
  noSupplierIssueWrite: true,
  serverApprovedTicketingRecovery: true, originalPaymentReused: true,
  adminAndSuperadminOnly: true,
}, null, 2));
