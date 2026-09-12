import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  assert.equal(fs.existsSync(path), true, `missing ${path}`);
  return fs.readFileSync(path, 'utf8');
}

const quickActions = read('components/flights/PostTicketActionsPreview.tsx');
const bookingActions = read('components/flights/BookingActions.tsx');
const bookingDetails = read('components/flights/BookingDetails.tsx');
const bookingPage = read('app/(dashboard)/dashboard/bookings/[reference]/page.tsx');
const bookingsTable = read('components/dashboard/bookings/BookingsTable.tsx');
const bookingsView = read('components/dashboard/bookings/BookingsView.tsx');
const dashboardBookings = read('lib/dashboard/bookings.ts');
const globals = read('app/globals.css');
const requestLink = read('lib/ticket-management/request-link.ts');
const workspace = read(
  'components/dashboard/ticket-management/TicketManagementWorkspace.tsx'
);
const tabs = read('components/dashboard/bookings/BookingsTabs.tsx');
const view = read('components/dashboard/bookings/BookingsView.tsx');
const listPage = read('app/(dashboard)/dashboard/bookings/page.tsx');
const client = read('lib/ticket-management/client.ts');
const repository = read('lib/db/ticket-management.ts');

for (const action of ['refund', 'reissue', 'void']) {
  assert.match(quickActions, new RegExp(`value: "${action}"`));
}
assert.match(quickActions, /aria-expanded=\{expanded\}/);
assert.match(quickActions, /actionsWithRequests\.has\(item\.value\)/);
assert.match(quickActions, /bookingReference=\$\{encodeURIComponent\(bookingReference\)\}/);
assert.match(quickActions, /\/api\/ticket-management\/availability\?bookingReference=/);
assert.match(quickActions, /availability\.message/);
assert.match(quickActions, /const \[selectedRoutes, setSelectedRoutes\]/);
assert.match(quickActions, /routeIndexes: selectedRoutes/);
assert.match(quickActions, />Routes</);
assert.match(quickActions, /allRoutesSelected/);
assert.match(quickActions, /detail\.routes\.map/);
assert.match(quickActions, /setActionsWithRequests/);
assert.match(quickActions, /hasExistingRequest &&/);
assert.match(quickActions, /RequestTimeline/);
assert.match(quickActions, /Requested \(\$\{detail\.publicRef\}\)/);
assert.match(quickActions, /Quotation pending/);
assert.match(quickActions, /Approved \/ Rejected \/ Expired/);
assert.match(quickActions, /User Payable entitlement/);
assert.match(quickActions, /Airline Refund Fee/);
assert.match(quickActions, /Kaliganj Travels Service Fee/);
assert.match(quickActions, /Final Refund Amount/);
assert.doesNotMatch(quickActions, /Supplier Payable/);
assert.match(quickActions, /Customer confirmation deadline:/);
assert.match(quickActions, />Accept</);
assert.match(quickActions, /className="mt-2 space-y-2\.5/);
assert.doesNotMatch(quickActions, /Dialog|Modal|UI only|preview only/i);
assert.match(quickActions, /\/api\/ticket-management/);
assert.match(quickActions, /action: "customer-decision"/);
assert.match(quickActions, /allowOwnerActions && detail\.status === "awaiting-confirmation"/);
assert.match(quickActions, /The booking owner must submit this request/);
assert.match(quickActions, /QuoteCountdown/);
assert.match(quickActions, /const awaitingCustomerConfirmation = detail\.status === "awaiting-confirmation"/);
assert.match(quickActions, /Customer confirmation has been recorded/);
assert.match(quickActions, /Customer confirmation deadline:/);
assert.match(quickActions, /Voluntary|voluntary/);
assert.match(quickActions, /involuntary/);
assert.doesNotMatch(quickActions, /Requested by the traveller|Caused by the airline/i);

assert.match(bookingActions, /ticketed && showPostTicketActions/);
assert.match(bookingActions, /allowOwnerActions=\{allowPostTicketOwnerActions\}/);
assert.match(bookingDetails, /showPostTicketActions/);
assert.match(bookingDetails, /allowPostTicketOwnerActions/);
assert.match(bookingPage, /canCreateOwnTicketManagementRequest\(session\.role\)/);
assert.match(bookingPage, /canViewTicketManagementRequest\(session\.role\)/);
assert.match(bookingPage, /ticketManagementRolloutEnabled\(\)/);
assert.match(bookingPage, /listTicketManagementRequestReferencesForBookings/);
assert.match(bookingDetails, /ticketManagementReferences/);
assert.match(bookingDetails, /ticket-management-reference-screen-only/);
assert.match(bookingsTable, /ticketManagementRequestLabel/);
assert.match(bookingsTable, /ticketManagementRequestHref/);
assert.match(dashboardBookings, /listTicketManagementRequestReferencesForBookings/);
assert.match(globals, /\.ticket-management-reference-screen-only/);
assert.match(requestLink, /tab: 'manage'/);
assert.match(requestLink, /request: reference\.publicRef/);
assert.match(requestLink, /return 'Refunded'/);
assert.match(bookingsView, /openRequestPublicRef/);

for (const status of [
  'requested',
  'in-progress',
  'awaiting-confirmation',
  'approved',
  'rejected',
  'expired',
]) {
  assert.match(tabs, new RegExp(`'${status}'`));
}
assert.match(view, /TicketManagementWorkspace/);
assert.match(listPage, /role=\{session\.role\}/);
assert.match(listPage, /currentUserId=\{session\.clerkId\}/);
assert.match(listPage, /ticketManagementEnabled=\{ticketManagementRolloutEnabled\(\)\}/);
assert.match(tabs, /ticketManagementEnabled/);
assert.match(tabs, /filter\(\(item\) => item\.tab !== 1\)/);
assert.match(tabs, /Quotation/);
assert.match(tabs, /Approved/);
assert.doesNotMatch(tabs, /Awaiting Customer Confirmation|Awaiting Settlement|All Types/);
assert.doesNotMatch(tabs, /\{ label: 'Completed', value: 'completed' \}/);
assert.doesNotMatch(view, /manageRequestType|ManageRequestTypeTabs/);
assert.doesNotMatch(workspace, /requestType: ManageRequestType|query\.set\('requestType'|requestTypeLabel/);

assert.match(workspace, /canOperateTicketManagementRequest/);
assert.match(workspace, /canPublishTicketManagementQuote/);
assert.match(workspace, /canAssignTicketManagementSettlement/);
assert.match(workspace, /canDirectlyFinalizeTicketManagementSettlement/);
assert.match(workspace, /canFinalizeTicketManagementSettlement/);
assert.match(workspace, /detail\.assigneeUserId === currentUserId/);
assert.match(workspace, /role === 'staff_support'/);
assert.match(workspace, /Assign an Accounts Staff, Admin, or Super Admin/);
assert.match(workspace, /Supplier Gross Fare/);
assert.match(workspace, /Supplier Payable/);
assert.match(workspace, /Customer confirmation deadline:/);
assert.match(workspace, /User Payable entitlement/);
assert.match(workspace, /Kaliganj Travels Service Fee/);
assert.match(workspace, /Final Refund Amount/);
const quoteForm = workspace.slice(
  workspace.indexOf('function QuoteForm'),
  workspace.indexOf('export default function')
);
assert.doesNotMatch(quoteForm, /Supplier Gross Fare|Supplier Payable/);
assert.doesNotMatch(
  quoteForm,
  /supplierGrossAmountMinor|supplierPayableAmountMinor/
);
assert.match(workspace, /Record approved settlement/);
assert.match(workspace, /Release Hold and return to In Progress/);
assert.match(workspace, /action: 'requote'/);
assert.match(workspace, /\['in-progress', 'awaiting-confirmation'\]\.includes\(detail\.status\)/);
assert.match(workspace, /Available until the customer approves the quotation/);
assert.match(workspace, /Request rejected\./);
assert.match(workspace, /Selected routes/);
assert.match(workspace, /detail\.routes\.map/);
assert.match(workspace, /requestKey: key/);
for (const header of [
  'Ref',
  'Status',
  'Airline',
  'Flight Date',
  'Issued Date',
  'Passenger Details',
  'Gross Fare',
  'User Payable',
  'Updated By',
  'Updated On',
]) {
  assert.match(workspace, new RegExp(`'${header}'`));
}
assert.doesNotMatch(workspace, /lg:grid-cols-\[minmax\(260px/);
assert.match(client, /passengerDetails/);
assert.match(repository, /pricing_snapshot,supplier_gross_amount,user_payable_amount/);
assert.match(repository, /pricing\?\.grossPrice/);
assert.match(repository, /pricing\?\.sellingPrice/);
assert.match(repository, /latestEventByRequest/);
assert.match(repository, /if \(input\.bookingId\) query = query\.eq\('booking_id', input\.bookingId\)/);
assert.doesNotMatch(
  workspace.slice(workspace.indexOf('Record approved settlement')),
  /customerAmountMinor|walletAccountId/
);

assert.match(client, /moneyToMinor/);
assert.match(client, /Number\.isSafeInteger/);
assert.match(client, /formatTicketManagementRequestStatus/);
assert.match(client, /return 'Quotation'/);
assert.match(client, /return 'Approved'/);
assert.match(client, /requestType: TicketManagementRequestType/);
assert.match(client, /routes: TicketManagementRoute\[\]/);
assert.match(repository, /requestNote: request\.request_note/);
assert.match(repository, /fareDifferenceAllocations:/);
assert.match(quickActions, /CUSTOMER_TIMELINE_EVENT_TYPES/);
assert.doesNotMatch(
  quickActions.slice(quickActions.indexOf('const TIMELINE_EVENT_LABELS')),
  /completed: "Completed"/
);

console.log('Ticket Management Phase 10 UI integration contracts verified.');
