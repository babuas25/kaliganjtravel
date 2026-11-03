import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';

// Run the actual client component with mocked hooks and HTTP. No browser,
// supplier, wallet, database or production transport is available in this test.
const file = 'components/flights/BookingPaymentReturn.tsx';
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const Wrapper = ({ children }) => children;
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const base = {
  canReturn: true, capturedAmount: 12000.25, refundedAmount: 1000,
  refundableAmount: 11000.25, currency: 'BDT', availableBefore: 1500.5, availableAfter: 12500.75,
  captureLedgerEntryId: '11111111-1111-4111-8111-111111111111', holdBalance: 400,
};
function nodes(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, result));
  else if (tree && typeof tree === 'object') { result.push(tree); nodes(tree.props?.children, result); }
  return result;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function harness(initialContext = base) {
  const slots = [];
  const calls = [];
  const feedback = [];
  let slot = 0, uuid = 0, refreshes = 0;
  let preview = () => response({ success: true, data: base });
  let submit = intent => response({ success: true, data: {
    returned: true, amount: intent.expectedRefundableAmount, currency: 'BDT',
  } });
  const props = { bookingReference: 'KTT261102111113', initialContext };
  const imports = {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useState(initial) {
        const index = slot++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useRef(initial) {
        const index = slot++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
    },
    'lucide-react': icons,
    'next/navigation': { useRouter: () => ({ refresh() { refreshes++; } }) },
    '@/components/feedback/StatusFeedback': { useStatusFeedback: () => value => feedback.push(value) },
    '@/components/ui/alert-dialog': Object.fromEntries([
      'AlertDialog', 'AlertDialogAction', 'AlertDialogCancel', 'AlertDialogContent', 'AlertDialogDescription',
      'AlertDialogFooter', 'AlertDialogHeader', 'AlertDialogTitle', 'AlertDialogTrigger',
    ].map(name => [name, Wrapper])),
  };
  const module = { exports: {} };
  new vm.Script(compiled, { filename: file }).runInNewContext({
    module, exports: module.exports, AbortController,
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    window: { setTimeout: () => 0, clearTimeout() {} },
    fetch: async (url, options) => {
      assert.equal(url, `/api/admin/bookings/${encodeURIComponent(props.bookingReference)}/payment-return`);
      const intent = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method: options.method, intent });
      return options.method === 'GET' ? preview() : submit(intent);
    },
  });
  const Component = module.exports.default;
  function tree() { slot = 0; return Component(props); }
  function action(label) { return nodes(tree()).find(node => node.props?.onClick && text(node.props.children) === label); }
  return {
    calls, props, feedback, tree, action,
    get refreshes() { return refreshes; },
    setPreview(fn) { preview = fn; }, setSubmit(fn) { submit = fn; },
    posts() { return calls.filter(call => call.method === 'POST'); },
    gets() { return calls.filter(call => call.method === 'GET'); },
    reason(value) {
      const input = nodes(tree()).find(node => node.type === 'input' && node.props.type === 'text');
      assert.ok(input, 'Reason field is shown');
      input.props.onChange({ target: { value } });
    },
    async click(label) {
      const button = action(label); assert.ok(button, `Missing action ${label}`);
      assert.ok(!button.props.disabled, `Action ${label} should be enabled`);
      button.props.onClick({ preventDefault() {} }); await settle();
    },
    close() { nodes(tree()).find(node => node.props?.onOpenChange).props.onOpenChange(false); },
    dialogOpen() { return nodes(tree()).find(node => node.props?.onOpenChange)?.props.open; },
  };
}

for (const context of [null, { ...base, canReturn: false }, { ...base, refundableAmount: 12000.25 },
  { ...base, currency: 'usd' }]) assert.equal(harness(context).tree(), null);

const success = harness();
assert.equal(success.calls.length, 0, 'Rendering never previews or returns money automatically');
await success.click('Return Booking Payment');
assert.equal(success.gets().length, 1);
assert.equal(success.posts().length, 0, 'Opening only performs a fresh read');
for (const value of ['Paid', 'Already returned', 'Return amount', 'Owner wallet before', 'Owner wallet after',
  '12,000.25 BDT', '1,000.00 BDT', '11,000.25 BDT', '1,500.50 BDT', '12,500.75 BDT']) {
  assert.ok(text(success.tree()).includes(value), `Preview displays ${value}`);
}
assert.equal(success.action('Return Payment').props.disabled, true, 'An audit reason is required');
success.reason('Mistaken\npayment');
assert.equal(success.action('Return Payment').props.disabled, true, 'The short audit reason excludes database-invalid control characters');
success.reason('  Captured payment by mistake  ');
await success.click('Return Payment');
assert.equal(success.posts().length, 1);
assert.deepEqual(success.posts()[0].intent, {
  requestId: '00000000-0000-4000-8000-000000000001', captureLedgerEntryId: base.captureLedgerEntryId,
  expectedCapturedAmount: 12000.25, expectedRefundedAmount: 1000, expectedRefundableAmount: 11000.25,
  expectedAvailableBalance: 1500.5, expectedHoldBalance: 400,
  reason: 'Captured payment by mistake', confirmation: true,
}, 'Client sends immutable intent and compare-only guards; no wallet owner or arbitrary refund amount');
assert.equal(success.tree(), null, 'A completed return hides the stale SSR button');
assert.equal(success.refreshes, 1);
assert.equal(success.feedback[0].title, 'Booking payment returned');

const dollars = harness({ ...base, currency: 'USD' });
dollars.setPreview(() => response({ success: true, data: { ...base, currency: 'USD' } }));
dollars.setSubmit(intent => response({ success: true, data: {
  returned: true, amount: intent.expectedRefundableAmount, currency: 'USD',
} }));
await dollars.click('Return Booking Payment');
assert.ok(text(dollars.tree()).includes('11,000.25 USD'));
dollars.reason('Mistaken payment'); await dollars.click('Return Payment');
assert.equal(dollars.tree(), null, 'The original account currency is supported without conversion or wallet selection');
assert.ok(dollars.feedback[0].description.includes('11,000.25 USD'));

const delayed = harness();
let releasePreview;
delayed.setPreview(() => new Promise(resolve => { releasePreview = resolve; }));
await delayed.click('Return Booking Payment');
assert.equal(delayed.action('Return Payment').props.disabled, true, 'An old SSR amount cannot unlock return');
releasePreview(response({ success: true, data: base })); await settle();
delayed.reason('Duplicate debit');
let releaseReturn;
delayed.setSubmit(() => new Promise(resolve => { releaseReturn = resolve; }));
const click = delayed.action('Return Payment').props.onClick;
click({ preventDefault() {} }); click({ preventDefault() {} });
await settle();
assert.equal(delayed.posts().length, 1, 'A synchronous submission lock prevents rapid duplicate requests');
assert.equal(nodes(delayed.tree()).find(node => node.type === 'input').props.disabled, true);
delayed.close(); assert.equal(delayed.dialogOpen(), true, 'A submitted return cannot lose its pending identity');
releaseReturn(response({ success: true, data: { returned: true, amount: base.refundableAmount, currency: 'BDT' } }));
await settle(); assert.equal(delayed.tree(), null);

for (const reject of [
  () => { throw new Error('Connection dropped'); },
  () => response({ success: false, error: { errorCode: 'PAYMENT_RETURN_OUTCOME_UNKNOWN', errorMessage: 'Result unavailable' } }, 503),
  () => response({ success: true, data: { returned: true, currency: 'USD' } }),
  () => response({ success: true, data: { returned: true, currency: 'BDT', amount: 1 } }),
  () => ({ ok: true, status: 200, json: async () => { throw new Error('Unreadable response'); } }),
]) {
  const uncertain = harness(); await uncertain.click('Return Booking Payment'); uncertain.reason('Duplicate capture');
  uncertain.setSubmit(reject); await uncertain.click('Return Payment');
  const intent = uncertain.posts()[0].intent;
  assert.ok(uncertain.action('Retry Same Payment Return'));
  assert.equal(nodes(uncertain.tree()).find(node => node.type === 'input').props.disabled, true);
  uncertain.close(); assert.equal(uncertain.dialogOpen(), true);
  uncertain.props.initialContext = { ...base, canReturn: false };
  assert.ok(uncertain.tree(), 'Background SSR updates retain an unresolved return and its retry action');
  uncertain.setSubmit(request => response({ success: true, data: {
    returned: true, amount: request.expectedRefundableAmount, currency: 'BDT', replay: true,
  } }));
  await uncertain.click('Retry Same Payment Return');
  assert.deepEqual(uncertain.posts()[1].intent, intent, 'Every retry retains the UUID, reason, amount and wallet fingerprints');
  assert.equal(uncertain.gets().length, 1, 'An uncertain intent is never replaced by a new preview');
  assert.equal(uncertain.tree(), null);
}

const changed = harness(); await changed.click('Return Booking Payment'); changed.reason('Mistaken debit');
const fresh = { ...base, refundedAmount: 2000, refundableAmount: 10000.25, availableBefore: 2500.5, availableAfter: 12500.75 };
changed.setSubmit(() => response({ success: false, error: { errorCode: 'PAYMENT_RETURN_STATE_CHANGED', errorMessage: 'Reload payment' } }, 409));
changed.setPreview(() => response({ success: true, data: fresh }));
await changed.click('Return Payment');
assert.equal(changed.gets().length, 2, 'A definite rejection refreshes the read-only preview');
assert.equal(changed.posts().length, 1, 'Refreshing a rejected preview does not submit money movement');
assert.ok(text(changed.tree()).includes('10,000.25 BDT'));
changed.setSubmit(intent => response({ success: true, data: { returned: true, amount: intent.expectedRefundableAmount, currency: 'BDT' } }));
await changed.click('Return Payment');
assert.notEqual(changed.posts()[0].intent.requestId, changed.posts()[1].intent.requestId);
assert.equal(changed.posts()[1].intent.expectedRefundedAmount, fresh.refundedAmount);
assert.equal(changed.posts()[1].intent.expectedAvailableBalance, fresh.availableBefore);

for (const data of [{ ...base, captureLedgerEntryId: undefined }, { ...base, holdBalance: undefined },
  { ...base, captureLedgerEntryId: 'invalid' }, { ...base, refundableAmount: 0.001 },
  { ...base, availableAfter: base.availableBefore }, { ...base, currency: 'usd' },
]) {
  const invalid = harness(); invalid.setPreview(() => response({ success: true, data }));
  await invalid.click('Return Booking Payment');
  assert.ok(invalid.action('Check Again'), 'Incomplete or inconsistent fresh preview fails closed');
  assert.equal(invalid.posts().length, 0);
}
const alreadyReturned = harness();
alreadyReturned.setPreview(() => response({ success: true, data: { ...base, canReturn: false,
  refundedAmount: base.capturedAmount, refundableAmount: 0, availableAfter: base.availableBefore } }));
await alreadyReturned.click('Return Booking Payment');
assert.equal(alreadyReturned.action('Return Payment').props.disabled, true);
assert.equal(alreadyReturned.posts().length, 0);
console.log('PASS booking payment-return UI: fresh captured/refunded/wallet preview, required reason, exact remaining return, explicit click only, duplicate lock, same-intent uncertain retry, definite rejection refresh, invalid evidence gates and feedback; no live HTTP/database/finance writes.');
