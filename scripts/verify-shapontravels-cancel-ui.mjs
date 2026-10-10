import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

function compile(file, imports, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
    console,
    ...globals,
  });
  return module.exports;
}

const projection = compile('lib/shapontravels/current-status-projection.ts', {
  './booking-status': compile('lib/shapontravels/booking-status.ts', {}),
  '@/lib/flights/booking-status': compile('lib/flights/booking-status.ts', {}),
});
const permissions = compile('lib/wallet/permissions.ts', {
  '@/lib/impexp/booking-source': compile('lib/impexp/booking-source.ts', {}),
  '@/lib/shapontravels/current-status-projection': projection,
});
const owner = { role: 'customer', clerkId: 'owner', agencyCode: null };
const base = {
  id: 'booking-id', public_ref: 'KTT261008111111', supplier: 'shapontravels',
  supplier_account: 'shapontravels', import_source: null,
  booking_owner_type: 'user', booking_owner_key: 'owner',
  status: 'on-hold', lifecycle_status: 'on-hold', direct_ticketing: false,
  issued_at: null, operation_kind: null, operation_request_id: null,
  operation_started_at: null, ticket_code_ref: null, ticket_numbers: [],
  payment_state: 'unpaid', captured_amount: 0, passengers: {},
};
const allowed = ['on-hold', 'pending', 'unconfirmed', 'expired'];
const current = {
  status: 'on-hold', bookingState: null, supplierStatus: null, supplierCheckedAt: null,
  verified: false, source: 'public_receipt', checkedAt: null,
  reviewRequired: true, lastCheck: null,
};
const saved = {
  currentStatus: current, originalBookingStatus: 'Created',
  fetchedAt: '2026-10-08T00:00:00Z', effectiveStatus: 'on-hold', reviewRequired: true,
};
for (const lifecycle_status of allowed) {
  for (const status of ['on-hold', 'pending']) {
    assert.equal(permissions.canCancelBooking(owner, { ...base, status, lifecycle_status }), true);
  }
  assert.equal(permissions.canCancelBooking(owner, { ...base, lifecycle_status,
    shapon_current_status: { ...saved, effectiveStatus: lifecycle_status,
      currentStatus: { ...current, status: lifecycle_status } },
  }), true, 'Issue cutoff-derived review flags do not replace fresh supplier Cancel permission');
}
for (const changes of [
  { status: 'confirmed' }, { status: 'cancelled' }, { status: 'in-progress' },
  { lifecycle_status: 'confirmed' }, { lifecycle_status: 'cancelled' },
  { lifecycle_status: 'in-progress' }, { lifecycle_status: undefined },
  { direct_ticketing: true }, { issued_at: '2026-10-08T00:00:00Z' },
  { operation_kind: 'ticketing' }, { operation_request_id: 'active' },
  { operation_started_at: '2026-10-08T00:00:00Z' },
  { ticket_code_ref: 'ticket' }, { ticket_numbers: ['1234567890'] },
  { ticket_numbers: { unexpected: true } }, { captured_amount: 100 },
  ...['held', 'captured', 'reconciliation', 'partially-refunded', 'refunded'].map(payment_state => ({ payment_state })),
  { shapon_current_status: {} },
  ...['confirmed', 'cancelled', 'in-progress'].map(status => ({
    shapon_current_status: { ...saved, currentStatus: { ...current, status } },
  })),
]) {
  assert.equal(permissions.canCancelBooking(owner, { ...base, ...changes }), false,
    `unsafe cancellation is denied: ${JSON.stringify(changes)}`);
}
assert.equal(permissions.canCancelBooking(owner, { ...base, payment_state: 'released' }), true);
assert.equal(permissions.canCancelBooking({ ...owner, clerkId: 'other' }, base), false);
assert.equal(permissions.canCancelBooking({ role: 'staff_support' }, base), false);
for (const role of ['admin', 'superadmin', 'staff_account']) {
  assert.equal(permissions.canCancelBooking({ role }, base), true);
}
for (const lifecycle_status of allowed) {
  assert.equal(permissions.canCancelBooking(owner, { ...base, supplier: 'triplover', lifecycle_status }),
    lifecycle_status === 'on-hold', 'Triplover keeps its existing On Hold scope');
}

// Render the actual action component without mounting effects or calling APIs.
const Wrapper = ({ children }) => React.createElement(React.Fragment, null, children);
const wrappers = names => Object.fromEntries(names.map(name => [name, Wrapper]));
const actionImports = {
  react: React, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  'next/navigation': { useRouter: () => ({ refresh() {}, push() {} }) },
  '@/components/feedback/StatusFeedback': { useStatusFeedback: () => () => {} },
  '@/lib/shapontravels/booking-status-message': { formatShapontravelsBookingStatus() {} },
  '@/components/flights/PostTicketActionsPreview': { default: () => null },
  '@/components/ui/dropdown-menu': wrappers([
    'DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem',
    'DropdownMenuLabel', 'DropdownMenuSeparator', 'DropdownMenuTrigger',
  ]),
  '@/components/ui/alert-dialog': wrappers([
    'AlertDialog', 'AlertDialogAction', 'AlertDialogCancel', 'AlertDialogContent',
    'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogHeader',
    'AlertDialogTitle', 'AlertDialogTrigger',
  ]),
};
const BookingActions = compile('components/flights/BookingActions.tsx', actionImports).default;
function cancelButton(props) {
  const html = renderToStaticMarkup(React.createElement(BookingActions, {
    status: 'on-hold', allowCancellation: true, directTicketing: false,
    bookingReference: base.public_ref, passengerCopies: [], paymentState: 'unpaid',
    ...props,
  }));
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .find(([, , label]) => label.replace(/<[^>]*>/g, '').trim() === 'Cancel Booking');
}
for (const status of allowed) {
  const button = cancelButton({ status, allowTicketing: false });
  assert.ok(button, `${status} still offers Cancel when Issue is unavailable`);
  assert.doesNotMatch(button[1], /\sdisabled(?:=|\s|$)/, 'Cancel does not require an Issue wallet preview');
}
for (const status of ['in-progress', 'confirmed', 'cancelled']) {
  assert.equal(cancelButton({ status }), undefined);
}
assert.equal(cancelButton({ allowCancellation: false }), undefined);
assert.equal(cancelButton({ directTicketing: true }), undefined);
assert.ok(cancelButton({ localTimeLimit: { featureAvailable: true, requestRequired: true } }));

// Invoke the real confirmation callback and rerender the retained booking.
// A lost supplier outcome must not leave stale On Hold props able to submit again.
const hookState = [];
let hookIndex = 0;
let routerRefreshes = 0;
const recoveryCalls = [];
const recoveryActions = compile('components/flights/BookingActions.tsx', {
  ...actionImports,
  react: {
    useState(initial) {
      const slot = hookIndex++;
      if (!(slot in hookState)) hookState[slot] = initial;
      return [hookState[slot], value => {
        hookState[slot] = typeof value === 'function' ? value(hookState[slot]) : value;
      }];
    },
    useRef: current => ({ current }), useEffect() {}, useCallback: callback => callback,
  },
  'next/navigation': { useRouter: () => ({ refresh() { routerRefreshes++; }, push() {} }) },
}, {
  crypto: { randomUUID: () => 'cancel-request' }, AbortController,
  window: { setTimeout: () => 0, clearTimeout() {} },
  fetch: async (url, options) => {
    recoveryCalls.push({ url, method: options.method ?? 'GET' });
    const cancellationPost = url === '/api/flights/booking/cancel';
    const body = cancellationPost
      ? { success: false, error: { errorCode: 'CANCEL_OUTCOME_UNKNOWN', errorMessage: 'Unknown supplier outcome' } }
      : { success: true, data: {
          lifecycleStatus: 'in-progress', paymentState: 'reconciliation',
          operationState: 'needs_reconciliation', reconciliationRequired: true,
          canSubmit: false, wallet: null, requiredAmount: 0,
        } };
    return { ok: !cancellationPost, text: async () => JSON.stringify(body) };
  },
}).default;
const recoveryProps = {
  status: 'on-hold', allowCancellation: true, directTicketing: false,
  bookingReference: base.public_ref, passengerCopies: [], paymentState: 'unpaid',
};
function recoveryTree() {
  hookIndex = 0;
  return recoveryActions(recoveryProps);
}
function allNodes(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => allNodes(child, result));
  else if (tree && typeof tree === 'object') {
    result.push(tree);
    allNodes(tree.props?.children, result);
  }
  return result;
}
function nodeLabel(tree) {
  if (Array.isArray(tree)) return tree.map(nodeLabel).join('');
  if (typeof tree === 'string') return tree;
  return tree && typeof tree === 'object' ? nodeLabel(tree.props?.children) : '';
}
const confirmCancel = allNodes(recoveryTree()).find(node =>
  nodeLabel(node.props?.children) === 'Yes, Cancel Booking' && node.props?.onClick);
assert.ok(confirmCancel, 'the eligible booking exposes a cancellation confirmation');
confirmCancel.props.onClick();
await new Promise(resolve => setTimeout(resolve, 0));
const recoveredTree = recoveryTree();
const staleCancel = allNodes(recoveredTree).find(node =>
  node.type === 'button' && nodeLabel(node.props?.children) === 'Cancel Booking');
assert.equal(staleCancel.props.disabled, true, 'uncertain cancellation locks the stale held-booking button');
assert.equal(routerRefreshes, 1, 'the ambiguous outcome refreshes saved booking props');
assert.deepEqual(recoveryCalls, [
  { url: '/api/flights/booking/cancel', method: 'POST' },
  { url: `/api/flights/booking/issue/status?reference=${base.public_ref}`, method: 'GET' },
], 'recovery makes one Cancel POST and one read-only status GET');
assert.ok(nodeLabel(recoveredTree).includes('Checking cancellation result / Needs Reconciliation'));

// Exercise the server page's real capability composition with read-only stubs.
const pageFile = 'app/(dashboard)/dashboard/bookings/[reference]/page.tsx';
const pageImports = { 'react/jsx-runtime': jsxRuntime };
const pageAst = ts.createSourceFile(pageFile, fs.readFileSync(pageFile, 'utf8'), ts.ScriptTarget.Latest);
for (const statement of pageAst.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
  const clause = statement.importClause;
  const stubs = {};
  if (clause.name) stubs.default = () => null;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const named of clause.namedBindings.elements) stubs[named.propertyName?.text ?? named.name.text] = () => null;
  }
  pageImports[statement.moduleSpecifier.text] = stubs;
}
let row = base;
let publicStatus = 'on-hold';
let configured = true;
let identityReady = true;
const BookingDetails = () => null;
Object.assign(pageImports, {
  '@/components/flights/BookingDetails': { default: BookingDetails },
  '@/lib/dashboard/session': { getDashboardSession: async () => owner },
  '@/lib/db/flight-bookings': {
    readBookingByPublicRef: async () => row,
    publicBookingWithHeaderContact: async () => ({ status: publicStatus }),
  },
  '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: false }) },
  '@/lib/shapontravels/client': { isShapontravelsConfigured: () => configured },
  '@/lib/shapontravels/cancel': { shapontravelsCancellationIdentityReady: () => identityReady },
  '@/lib/wallet/permissions': permissions,
  '@/lib/booking-lifecycle/rollout': { bookingLifecycleRolloutState: () => ({}) },
  '@/lib/db/ticket-management': { listTicketManagementRequestReferencesForBookings: async () => new Map() },
  '@/lib/ticket-management/booking-actions': { ticketManagementActionsForBooking: () => [] },
});
const page = compile(pageFile, pageImports).default;
async function pageAllows(changes = {}, status = 'on-hold') {
  row = { ...base, ...changes };
  publicStatus = status;
  const tree = await page({ params: Promise.resolve({ reference: base.public_ref }) });
  return tree.props.children.find(child => child?.type === BookingDetails).props.allowCancellation;
}
for (const status of allowed) {
  assert.equal(await pageAllows({ lifecycle_status: status }, status), true);
}
for (const changes of [
  { supplier: 'unsupported' }, { supplier_account: 'triplover' },
  { import_source: 'MANUAL' }, { import_source: 'IMP_EXP' },
  { lifecycle_status: 'confirmed' }, { issued_at: '2026-10-08T00:00:00Z' },
]) assert.equal(await pageAllows(changes), false);
assert.equal(await pageAllows({}, 'confirmed'), false);
configured = false;
assert.equal(await pageAllows(), false);
configured = true;
identityReady = false;
assert.equal(await pageAllows(), false);
assert.equal(await pageAllows({ supplier: 'triplover' }), true);

console.log(JSON.stringify({ checks: 'passed', statuses: allowed,
  issueIndependent: true, ownerScoped: true, configuredIdentityRequired: true,
  ticketedAndActiveBlocked: true, triploverScopePreserved: true,
  ambiguousOutcomeLocksStaleCancellation: true }, null, 2));
