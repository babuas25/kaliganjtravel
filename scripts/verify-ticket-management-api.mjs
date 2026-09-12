import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  assert.equal(fs.existsSync(path), true, `missing ${path}`);
  return fs.readFileSync(path, 'utf8');
}

const collectionRoute = read('app/api/ticket-management/route.ts');
const availabilityRoute = read('app/api/ticket-management/availability/route.ts');
const detailRoute = read('app/api/ticket-management/[requestId]/route.ts');
const actionRoute = read('app/api/ticket-management/[requestId]/actions/route.ts');
const assigneesRoute = read('app/api/ticket-management/assignees/route.ts');
const expiryRoute = read('app/api/cron/ticket-management/route.ts');
const service = read('lib/ticket-management/service.ts');
const repository = read('lib/db/ticket-management.ts');
const refundRoute = read('app/api/wallet/refunds/route.ts');
const outboxMigration = read(
  'supabase/migrations/0126_ticket_management_notification_outbox.sql'
);
const rollout = read('lib/ticket-management/rollout.ts');
const commercialBasisMigration = read(
  'supabase/migrations/0130_ticket_management_booking_commercial_basis.sql'
);
const directSettlementMigration = read(
  'supabase/migrations/0131_ticket_management_direct_admin_settlement.sql'
);
const emailDeliveryMigration = read(
  'supabase/migrations/0132_ticket_management_email_delivery.sql'
);
const recipientHashMigration = read(
  'supabase/migrations/0133_ticket_management_notification_recipient_hash.sql'
);
const requestTypeMigration = read(
  'supabase/migrations/0134_ticket_management_request_type.sql'
);
const approvedFinalStatusMigration = read(
  'supabase/migrations/0135_ticket_management_approved_final_status.sql'
);
const actionReferenceMigration = read(
  'supabase/migrations/0137_ticket_management_action_reference_prefix.sql'
);
const staffRejectionMigration = read(
  'supabase/migrations/0144_ticket_management_staff_rejection_until_approval.sql'
);
const routeSelectionMigration = read(
  'supabase/migrations/0145_ticket_management_route_selection.sql'
);
const voidWindowMigration = read(
  'supabase/migrations/0146_ticket_management_void_same_day_cutoff.sql'
);
const actionVisibilityMigration = read(
  'supabase/migrations/0147_ticket_management_action_visibility.sql'
);
const ticketManagementDelivery = read(
  'lib/email/ticket-management-delivery.ts'
);
const ticketManagementNotifications = read(
  'lib/db/ticket-management-notifications.ts'
);
const ticketManagementTemplates = read('lib/email/templates.ts');
const bookingEmailCron = read('app/api/cron/booking-status-emails/route.ts');

for (const action of [
  'review',
  'publish-quote',
  'customer-decision',
  'requote',
  'assign',
  'complete-refund',
  'complete-reissue',
  'release-reissue',
  'complete-void',
  'release-void',
]) {
  assert.match(actionRoute, new RegExp(`z\\.literal\\('${action}'\\)`));
  assert.match(service, new RegExp(`action: '${action}'`));
}

assert.match(collectionRoute, /bookingScopeFor\(session\)/);
assert.match(availabilityRoute, /bookingScopeFor\(session\)/);
assert.match(availabilityRoute, /listTicketManagementPassengerAvailability/);
assert.match(availabilityRoute, /canViewTicketManagementRequest/);
assert.match(collectionRoute, /canCreateOwnTicketManagementRequest/);
assert.match(collectionRoute, /ticketManagementPayloadHash/);
assert.match(collectionRoute, /requestType: z\.enum\(TICKET_MANAGEMENT_REQUEST_TYPES\)/);
assert.match(collectionRoute, /routeIndexes: z\.array/);
assert.match(collectionRoute, /routeIndexes: payload\.routeIndexes/);
assert.match(collectionRoute, /requestType: request\.nextUrl\.searchParams\.get\('requestType'\)/);
assert.match(collectionRoute, /ticketManagementCustomer/);
assert.match(collectionRoute, /`booking:\$\{booking\.id\}`/);
assert.match(detailRoute, /readTicketManagementRequestDetail/);
assert.match(assigneesRoute, /canAssignTicketManagementSettlement/);

assert.match(actionRoute, /authorizeTicketManagementAction/);
assert.match(actionRoute, /ticketManagementSettlement/);
assert.match(actionRoute, /`request:\$\{parsedRequestId\.data\}`/);
assert.match(actionRoute, /outcome: 'attempted'/);
assert.match(actionRoute, /TICKET_MANAGEMENT_AUDIT_UNAVAILABLE/);
assert.match(actionRoute, /finalSettlementAmountInputAccepted: false/);
assert.match(actionRoute, /walletAccountInputAccepted: false/);
assert.match(actionRoute, /supplierCommercialAmountInputAccepted: false/);
assert.match(actionRoute, /sanitizeTicketManagementResult/);

const publishQuoteSchemaStart = actionRoute.indexOf(
  "action: z.literal('publish-quote')"
);
const publishQuoteSchemaEnd = actionRoute.indexOf(
  '}).strict()',
  publishQuoteSchemaStart
);
assert.notEqual(publishQuoteSchemaStart, -1);
const publishQuoteSchema = actionRoute.slice(
  publishQuoteSchemaStart,
  publishQuoteSchemaEnd
);
assert.doesNotMatch(
  publishQuoteSchema,
  /supplierGrossAmountMinor|supplierPayableAmountMinor/
);

for (const action of ['complete-refund', 'complete-void']) {
  const start = actionRoute.indexOf(`action: z.literal('${action}')`);
  const end = actionRoute.indexOf('}).strict()', start);
  assert.notEqual(start, -1);
  const schema = actionRoute.slice(start, end);
  assert.doesNotMatch(schema, /amount|walletAccount/i);
}

assert.match(service, /const action = detail\.action/);
assert.doesNotMatch(service, /input\.supplier(?:Gross|Payable)AmountMinor/);
assert.match(service, /publishTicketManagementQuote\([\s\S]*?action,/);
assert.doesNotMatch(
  service.slice(service.indexOf("case 'complete-refund'"), service.indexOf("case 'complete-reissue'")),
  /amount|walletAccount/i
);
assert.doesNotMatch(
  service.slice(service.indexOf("case 'complete-void'"), service.indexOf("case 'release-void'")),
  /amount|walletAccount/i
);
assert.match(service, /if \(result\.reservationId \|\| result\.ledgerEntryId\)/);
assert.doesNotMatch(
  service.slice(service.indexOf('const safe:'), service.length),
  /safe\.(reservationId|ledgerEntryId|walletAccountId)/
);

assert.match(repository, /const staff = STAFF_READ_ROLES\.has\(actor\.role\)/);
assert.match(repository, /supplierGrossAmount: quote\.supplier_gross_amount/);
assert.match(repository, /supplierPayableAmount: quote\.supplier_payable_amount/);
assert.match(repository, /publish_ticket_management_quote_v2/);
assert.match(repository, /publish_ticket_management_reissue_quote_v2/);
for (const rpc of [
  'complete_ticket_management_refund_v2',
  'complete_ticket_management_reissue_v2',
  'release_and_reopen_ticket_management_reissue_v2',
  'complete_ticket_management_void_v2',
  'release_and_reopen_ticket_management_void_v2',
]) {
  assert.match(repository, new RegExp(rpc));
}
assert.doesNotMatch(
  repository.slice(
    repository.indexOf('export function publishTicketManagementQuote'),
    repository.indexOf('export function decideTicketManagementQuote')
  ),
  /p_supplier_gross_amount|p_supplier_payable_amount/
);
assert.match(repository, /if \(!staff\) \{[\s\S]*?CUSTOMER_EVENT_TYPES/);
assert.match(repository, /walletResults: \{/);
assert.match(repository, /booking_owner_key/);
assert.match(repository, /create_ticket_management_request_v4/);
assert.match(repository, /ticket_management_request_routes/);
assert.match(repository, /routes: routes\.map/);
assert.match(routeSelectionMigration, /create table public\.ticket_management_request_routes/);
assert.match(routeSelectionMigration, /create_ticket_management_request_v4/);
assert.match(routeSelectionMigration, /p_route_indexes integer\[\]/);
assert.match(routeSelectionMigration, /ticket_management_request_routes_deny_update_delete/);
assert.match(collectionRoute, /isTicketVoidRequestOpen\(booking\.issued_at\)/);
assert.match(collectionRoute, /VOID_REQUEST_WINDOW_CLOSED/);
assert.match(voidWindowMigration, /time '23:30:00'/);
assert.match(voidWindowMigration, /at time zone 'Asia\/Dhaka'/);
assert.match(voidWindowMigration, /ticket_management_requests_void_window_guard/);
assert.match(collectionRoute, /ticketManagementActionsForBooking/);
assert.match(collectionRoute, /TICKET_MANAGEMENT_ACTION_UNAVAILABLE/);
assert.match(actionVisibilityMigration, /p_status = 'confirmed'/);
assert.match(actionVisibilityMigration, /p_action = 'reissue'/);
assert.match(actionVisibilityMigration, /p_direct_ticketing/);
assert.match(actionVisibilityMigration, /p_booking_origin/);
assert.match(actionVisibilityMigration, /ticket_management_requests_action_availability_guard/);

assert.match(expiryRoute, /process\.env\.CRON_SECRET/);
assert.match(expiryRoute, /`Bearer \$\{secret\}`/);
assert.match(expiryRoute, /\.min\(1\)\.max\(1000\)/);

assert.match(refundRoute, /TICKET_MANAGEMENT_REQUIRED/);
assert.match(refundRoute, /Boolean\(booking\.issued_at\)/);
assert.match(refundRoute, /booking\.ticket_numbers\.length > 0/);

assert.match(outboxMigration, /after insert on public\.ticket_management_request_events/);
assert.match(outboxMigration, /confirmation-expired/);
assert.match(outboxMigration, /Recipient expansion and delivery remain disabled/);
assert.doesNotMatch(outboxMigration, /recipient_email|send_email|http_post|net\.http/i);

assert.match(emailDeliveryMigration, /create table public\.ticket_management_notification_deliveries/);
assert.match(emailDeliveryMigration, /unique \(outbox_id, recipient_address_hash\)/);
assert.match(emailDeliveryMigration, /claim_ticket_management_notification_outbox_v1/);
assert.match(emailDeliveryMigration, /for update skip locked/);
assert.match(emailDeliveryMigration, /recover_stale_ticket_management_notification_claims_v1/);
assert.match(emailDeliveryMigration, /'requested', 'accepted', 'staff-rejected', 'quotation-published'/);
assert.match(emailDeliveryMigration, /'customer-approved', 'customer-rejected', 'confirmation-expired'/);
assert.match(emailDeliveryMigration, /source\.state = 'pending'/);
assert.match(emailDeliveryMigration, /source\.snapshot - 'requestId'/);
assert.match(emailDeliveryMigration, /app_user\.role in \('staff_support', 'staff_account', 'admin', 'superadmin'\)/);
assert.match(approvedFinalStatusMigration, /set status = 'approved'/);
assert.match(approvedFinalStatusMigration, /return v_result \|\| jsonb_build_object\('status', 'approved'\)/);
assert.match(actionReferenceMigration, /'TMRR'/);
assert.match(actionReferenceMigration, /'TMRE'/);
assert.match(actionReferenceMigration, /'TMRV'/);
assert.match(actionReferenceMigration, /before insert on public\.ticket_management_requests/);
assert.match(staffRejectionMigration, /'requested', 'in-progress', 'awaiting-confirmation'/);
assert.match(staffRejectionMigration, /REQUEST_NOT_REJECTABLE/);
assert.match(staffRejectionMigration, /v_from_status/);
assert.doesNotMatch(emailDeliveryMigration, /supplier_payable|supplierPayable|supplier_gross|supplierGross/);
assert.match(recipientHashMigration, /md5\(recipient\.address\)/);
assert.match(recipientHashMigration, /recipient set is immutable|immutable audience recipient set/);
assert.match(requestTypeMigration, /add column request_type text not null default 'voluntary'/);
assert.match(requestTypeMigration, /request_type in \('voluntary', 'involuntary'\)/);
assert.match(requestTypeMigration, /create_ticket_management_request_v3/);
assert.match(requestTypeMigration, /INVALID_REQUEST_TYPE/);
assert.match(repository, /create_ticket_management_request_v4/);
assert.match(repository, /p_request_type: input\.requestType/);
assert.match(repository, /query\.eq\('request_type', input\.requestType\)/);
assert.match(ticketManagementDelivery, /messageId/);
assert.match(ticketManagementDelivery, /ticketManagementNotificationEmail/);
assert.match(ticketManagementDelivery, /dispatchPendingTicketManagementEmails/);
assert.match(ticketManagementNotifications, /store_ticket_management_notification_render_v1/);
assert.match(ticketManagementTemplates, /ticketManagementNotificationEmail/);
assert.match(ticketManagementTemplates, /Supplier payable and other internal commercial values are never included/);
assert.match(collectionRoute, /after\(async \(\) => \{[\s\S]*?dispatchPendingTicketManagementEmails/);
assert.match(actionRoute, /after\(async \(\) => \{[\s\S]*?dispatchPendingTicketManagementEmails/);
assert.match(bookingEmailCron, /ticketManagementNotificationRecovery/);
assert.match(bookingEmailCron, /ticketManagementDelivery/);

assert.match(commercialBasisMigration, /ticket_management_booking_commercial_basis_v1/);
assert.match(commercialBasisMigration, /booking\.supplier_gross_amount/);
assert.match(commercialBasisMigration, /'supplierTotalPrice'/);
assert.match(commercialBasisMigration, /publish_ticket_management_quote_v2/);
assert.match(commercialBasisMigration, /publish_ticket_management_reissue_quote_v2/);
assert.match(
  commercialBasisMigration,
  /revoke all on function public\.publish_ticket_management_quote_v1[\s\S]*?from service_role/
);
assert.match(
  directSettlementMigration,
  /ticket_management_prepare_direct_settlement_v1/
);
assert.match(
  directSettlementMigration,
  /v_actor_role in \('admin', 'superadmin'\)/
);
assert.match(
  directSettlementMigration,
  /assign_ticket_management_settlement_v1\([\s\S]*?p_actor_user_id,[\s\S]*?p_actor_user_id/
);
assert.match(
  directSettlementMigration,
  /revoke all on function public\.complete_ticket_management_refund_v1[\s\S]*?from service_role/
);
assert.match(
  commercialBasisMigration,
  /revoke all on function public\.publish_ticket_management_reissue_quote_v1[\s\S]*?from service_role/
);

const integrationSurface = [
  collectionRoute,
  availabilityRoute,
  detailRoute,
  actionRoute,
  assigneesRoute,
  expiryRoute,
  service,
].join('\n');
assert.doesNotMatch(integrationSurface, /supplierApi|evidenceUpload|evidenceVerification/i);

assert.match(rollout, /TICKET_MANAGEMENT_ENABLED/);
assert.match(rollout, /configured === 'true'/);
assert.match(rollout, /configured === 'false'/);
assert.match(rollout, /process\.env\.NODE_ENV !== 'production'/);
for (const route of [
  collectionRoute,
  availabilityRoute,
  detailRoute,
  actionRoute,
  assigneesRoute,
  expiryRoute,
]) {
  assert.match(route, /ticketManagementRolloutEnabled\(\)/);
  assert.match(route, /TICKET_MANAGEMENT_DISABLED/);
}

console.log('Ticket Management Phase 9 API and security contracts verified.');
