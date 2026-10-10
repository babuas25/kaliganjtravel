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
    externalTicketConfirmation: { eligible: true, amount: 12500.25, currency: 'BDT' },
    supplierTicket: { result: 'verified', ticketCount: 1 },
  },
};
const completed = charged => envelope({ success: true, data: { confirmed: true, charged } });

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
  let confirm = request => completed(request.chargeWallet);
  const props = {
    status: 'on-hold', directTicketing: false, allowCancellation: true,
    allowTicketing: true, allowShaponStatusCheck: true,
    allowExternalTicketConfirmation: true,
    bookingReference: 'KTT261010111116', passengerCopies: [], paymentState: 'unpaid',
    ...overrides,
  };
  const imports = {
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
    async click(text) {
      const node = action(text);
      assert.ok(node, `Missing action ${text}`);
      assert.ok(!node.props.disabled, `${text} should be enabled`);
      node.props.onClick({ preventDefault() {} });
      await settle();
    },
    async verify() { await this.click('Verify Supplier Status'); },
  };
}

for (const charged of [true, false]) {
  const test = harness();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'confirmation starts hidden');
  await test.verify();
  const nodes = allNodes(test.tree());
  assert.ok(nodes.findIndex(node => node.type === 'button' && label(node.props.children) === 'Confirm Issued Ticket') >
    nodes.findIndex(node => node.type === 'button' && label(node.props.children) === 'Verify Supplier Status'),
  'the confirmation button is below Refresh');
  assert.ok(label(test.tree()).includes('Charge the booking owner’s wallet?'), 'the question is English');
  assert.ok(label(test.tree()).includes('12,500.25'), 'the saved selling amount is displayed');
  assert.equal(test.posts().length, 0, 'Refresh has no financial write');
  await test.click(charged ? 'Charge & Confirm' : 'Confirm Without Charge');
  assert.equal(test.posts().length, 1);
  assert.deepEqual(test.posts()[0].request, {
    bookingReference: test.props.bookingReference, requestId: 'confirmation-2', chargeWallet: charged,
  }, 'the server selects the booking owner and amount; the client sends only the decision');
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'success hides stale held confirmation');
  assert.ok(test.routerRefreshes > 0, 'success refreshes server-rendered booking and wallet');
  assert.ok(label(test.tree()).includes(charged
    ? 'Booking confirmed. The booking owner’s wallet was charged.'
    : 'Booking confirmed without a wallet charge.'));
  assert.ok(test.calls.every(call => call.url !== '/api/flights/booking/issue'), 'no supplier Issue write occurs');
}

for (const changes of [
  { allowExternalTicketConfirmation: false }, { allowShaponStatusCheck: false },
  { status: 'confirmed' }, { status: 'cancelled' }, { directTicketing: true },
  { importedBooking: true }, { manualBooking: true },
]) {
  const test = harness(changes);
  // An absent Shapon Refresh still cannot reveal confirmation through another route.
  if (changes.allowShaponStatusCheck === false) test.props.allowSupplierRefresh = true;
  if (changes.allowShaponStatusCheck !== false) await test.verify();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, `ineligible UI: ${JSON.stringify(changes)}`);
}

for (const result of [
  { supplierTicket: { result: 'verified', ticketCount: 1 } },
  { externalTicketConfirmation: { eligible: false, amount: 12500.25, currency: 'BDT' } },
  { externalTicketConfirmation: { eligible: true, amount: 0, currency: 'BDT' } },
  { externalTicketConfirmation: { eligible: true, amount: 12500.25, currency: 'USD' } },
]) {
  const test = harness();
  test.setRefresh(() => envelope({ success: true, data: result }));
  await test.verify();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'only an explicit valid server candidate unlocks confirmation');
}

for (const status of ['on-hold', 'pending', 'expired', 'unconfirmed']) {
  const test = harness({ status });
  await test.verify();
  assert.ok(test.button('Confirm Issued Ticket'), `${status} can use a fresh server-approved candidate`);
  await test.click('Confirm Without Charge');
  assert.equal(test.posts()[0].request.chargeWallet, false);
}

for (const chargeWallet of [true, false]) {
  const test = harness();
  await test.verify();
  let attempt = 0;
  test.setConfirm(request => {
    if (++attempt === 1) throw new Error('Connection lost after confirmation');
    return completed(request.chargeWallet);
  });
  const chosen = chargeWallet ? 'Charge & Confirm' : 'Confirm Without Charge';
  const opposite = chargeWallet ? 'Confirm Without Charge' : 'Charge & Confirm';
  const oldOpposite = test.action(opposite);
  await test.click(chosen);
  assert.equal(test.action(opposite).props.disabled, true, 'a lost response locks the other financial choice');
  assert.equal(test.action('Verify Supplier Status').props.disabled, true, 'a lost response retains the current intent across Refresh');
  assert.ok(allNodes(test.tree()).some(node => label(node.props?.children) === 'Not Now' && node.props.disabled),
    'the unresolved financial dialog cannot be dismissed');
  assert.ok(label(test.tree()).includes('Retry the same option'), 'recovery explains the safe retry');
  oldOpposite.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 1, 'a stale handler cannot switch the retained decision');
  await test.click(chosen);
  assert.equal(test.posts().length, 2);
  assert.deepEqual(test.posts()[0].request, test.posts()[1].request, 'retry reuses both the request ID and the choice');
  assert.equal(test.button('Confirm Issued Ticket'), undefined);
}

for (const failure of [
  () => envelope({ success: false, error: { errorCode: 'INSUFFICIENT_FUNDS' } }, 500),
  () => envelope({ success: false, error: { errorCode: 'ALREADY_CONFIRMED' } }, 409),
  () => ({ ok: true, status: 200, text: async () => '{malformed' }),
  () => envelope({ success: true, data: {} }),
  () => envelope({ success: true, data: { confirmed: true } }),
  () => completed(false),
]) {
  const test = harness();
  await test.verify();
  test.setConfirm(failure);
  await test.click('Charge & Confirm');
  assert.equal(test.action('Confirm Without Charge').props.disabled, true,
    'server failures, conflicting decisions, and malformed results retain the original choice');
  test.setConfirm(() => completed(true));
  await test.click('Charge & Confirm');
  assert.deepEqual(test.posts()[0].request, test.posts()[1].request);
}

{
  const test = harness();
  await test.verify();
  test.setConfirm(() => envelope({ success: false, error: {
    errorCode: 'INSUFFICIENT_FUNDS', errorMessage: 'The booking owner has insufficient wallet funds.',
  } }, 409));
  await test.click('Charge & Confirm');
  assert.equal(test.action('Confirm Without Charge').props.disabled, false, 'definite no-debit rejection allows the other option');
  assert.equal(test.action('Verify Supplier Status').props.disabled, false);
  test.setConfirm(() => completed(false));
  await test.click('Confirm Without Charge');
  assert.notEqual(test.posts()[0].request.requestId, test.posts()[1].request.requestId);
  assert.equal(test.posts()[1].request.chargeWallet, false);
}

{
  const test = harness();
  await test.verify();
  let release;
  test.setConfirm(() => new Promise(resolve => { release = resolve; }));
  const action = test.action('Charge & Confirm');
  action.props.onClick({ preventDefault() {} });
  action.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 1, 'repeated clicks before a render submit once');
  assert.equal(test.action('Confirm Without Charge').props.disabled, true);
  release(completed(true));
  await settle();
}

{
  const test = harness();
  await test.verify();
  const oldConfirm = test.action('Charge & Confirm');
  let release;
  test.setRefresh(() => new Promise(resolve => { release = resolve; }));
  const refresh = test.action('Verify Supplier Status');
  refresh.props.onClick();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'new Refresh immediately invalidates old ticket evidence');
  release(envelope({ success: true, data: { supplierTicket: { result: 'pending' } } }));
  await settle();
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'a subsequent unconfirmed refresh cannot reuse old eligibility');
  oldConfirm.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 0, 'a stale confirmation handler cannot reuse invalidated evidence');
}

{
  const test = harness();
  await test.verify();
  const oldConfirm = test.action('Charge & Confirm');
  test.props.bookingReference = 'KTT261010111117';
  assert.equal(test.button('Confirm Issued Ticket'), undefined, 'evidence never carries over to another booking');
  oldConfirm.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(test.posts().length, 0, 'old financial handlers cannot submit after navigating to another booking');
}

console.log(JSON.stringify({
  checks: 'passed', englishQuestion: true, bothChoicesConfirm: true,
  refreshNonfinancial: true, explicitEligibilityRequired: true,
  lostResponseKeepsDecisionAndRequestId: true, duplicateClicksSubmitOnce: true,
  definiteInsufficientFundsAllowsNoCharge: true, staleEvidenceInvalidated: true,
  noSupplierIssueWrite: true,
}, null, 2));
