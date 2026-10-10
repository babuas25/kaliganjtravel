import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);

function compile(path, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', 'module', 'require', compiled)(module.exports, module, (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('node:') || name === 'zod') return require(name);
    throw new Error(`Unexpected infrastructure import: ${name}`);
  });
  return module.exports;
}

// Exercise the real request parser and receipt verification. Infrastructure is
// replaced with local fixtures so no database, file service, email or SMS runs.
const accountId = '16600000-0000-4000-8000-000000000001';
let receivingAccount = { id: accountId, qrCodeUrl: '/images/payments/test.png' };
let createdInput;
let createCount = 0;
let discardedCount = 0;
let uploadedCount = 0;
let storageAvailable = true;
let sessionRole = 'customer';
let supabase = null;
let listedRequests = [];
const listScopes = [];
const emailInputs = [];
const cloudinary = {
  FOLDERS: { walletDeposits: 'wallet/deposits' },
  privateUrl: () => 'https://example.test/private-receipt',
  destroyAsset: async () => { discardedCount += 1; },
  uploadAsset: async (_bytes, _type, options) => {
    assert.equal(options.authenticated, true, 'Receipts must use private uploads');
    uploadedCount += 1;
    return { ok: true, asset: { publicId: 'test/receipt', format: 'png' } };
  },
};
const uploads = compile('lib/db/document-uploads.ts', {
  '@/lib/cloudinary': cloudinary,
  '@/lib/upload-verify': compile('lib/upload-verify.ts'),
});
const route = compile('app/api/wallet/deposits/route.ts', {
  '@/lib/cloudinary': cloudinary,
  '@/lib/dashboard/session': {
    getDashboardSession: async () => ({ clerkId: 'qr-requester', role: sessionRole }),
  },
  '@/lib/db/document-uploads': uploads,
  '@/lib/email/notifications': {
    sendDepositRequestEmails: async (input) => { emailInputs.push(input); return { failed: 0 }; },
  },
  '@/lib/sms/deposit-request-admin-delivery': { dispatchDepositRequestAdminSms: async () => ({}) },
  '@/lib/db/wallet': {
    ensureSessionWallet: async () => ({ accountId, ownerType: 'user', ownerKey: 'qr-requester', currency: 'BDT' }),
    listDepositRequests: async (scope) => {
      listScopes.push(scope);
      return listedRequests.filter((request) => !scope || request.wallet_account_id === scope);
    },
    createDepositRequest: async (input) => {
      createCount += 1;
      createdInput = input;
      if (!storageAvailable) return null;
      return { id: input.id, public_ref: 'DEP-TEST', amount: input.amount,
        currency: input.currency, method: input.method, status: 'pending',
        reference_number: input.referenceNumber, deposit_date: input.depositDate ?? null,
        attachment: input.attachment };
    },
  },
  '@/lib/db/wallet-owner-bank-accounts': {},
  '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
  '@/lib/supabase/server': { supabaseAdmin: () => supabase },
  '@/lib/wallet/http': {
    walletOk: (data, status = 200) => Response.json({ success: true, data }, { status }),
    walletFail: (status, errorCode, errorMessage) => Response.json({ errorCode, errorMessage }, { status }),
  },
  '@/lib/wallet/money': compile('lib/wallet/money.ts'),
  '@/lib/wallet/payment-options.server': { findBanglaQrAccount: async () => receivingAccount },
  '@/lib/wallet/permissions': { canReadWallet: (role) => role === 'staff_account' },
});

const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const receipt = () => new File([pngBytes], 'receipt.png', { type: 'image/png' });
async function post(overrides = {}, attachment = receipt()) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ method: 'bangla_qr', banglaQrAccountId: accountId,
    referenceNumber: '  QR-TXN-001  ', amount: '123.45', ...overrides })) {
    if (value !== undefined) form.set(name, value);
  }
  if (attachment) form.set('attachment', attachment);
  return route.POST(new Request('https://example.test/api/wallet/deposits', { method: 'POST', body: form }));
}

const success = await post();
assert.equal(success.status, 201);
assert.equal((await success.json()).data.request.status, 'pending');
assert.equal(createdInput.banglaQrAccountId, accountId);
assert.equal(createdInput.referenceNumber, 'QR-TXN-001');
assert.equal(createdInput.amount, 12345);
assert.equal(createdInput.grossAmount, 12345);
assert.equal(createdInput.gatewayFeeBps, undefined);
assert.equal(createdInput.depositDate, undefined, 'Bangla QR does not require a deposit date');
assert.equal(emailInputs[0].paymentMethod, 'Bangla QR');
const uploadsBeforeSmallAmount = uploadedCount;
assert.equal((await post({ amount: '0.001' })).status, 400);
assert.equal(uploadedCount, uploadsBeforeSmallAmount,
  'An amount below one paisa must be rejected before receipt upload');

for (const overrides of [
  { referenceNumber: '  ' }, { referenceNumber: undefined },
  { banglaQrAccountId: 'invalid' }, { amount: '0' }, { amount: '-1' },
]) assert.equal((await post(overrides)).status, 400);
assert.equal((await (await post({}, null)).json()).errorCode, 'ATTACHMENT_REQUIRED');
receivingAccount = null;
assert.equal((await (await post()).json()).errorCode, 'INVALID_BANGLA_QR_ACCOUNT');
receivingAccount = { id: accountId, qrCodeUrl: null };
assert.equal((await (await post()).json()).errorCode, 'INVALID_BANGLA_QR_ACCOUNT');
receivingAccount = { id: accountId, qrCodeUrl: '/images/payments/test.png' };
assert.equal((await (await post({}, new File(['invalid'], 'receipt.png', { type: 'image/png' }))).json()).errorCode,
  'ATTACHMENT_REJECTED');
assert.equal((await (await post({}, new File([pngBytes], 'receipt.txt', { type: 'text/plain' }))).json()).errorCode,
  'ATTACHMENT_REJECTED');
assert.equal((await (await post({}, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'receipt.png', { type: 'image/png' }))).json()).errorCode,
  'ATTACHMENT_REJECTED');
assert.equal(createCount, 1, 'Invalid requests must not be stored');
storageAvailable = false;
assert.equal((await post()).status, 503);
assert.equal(discardedCount, 1, 'A failed deposit write must remove its uploaded receipt');

// Reviewers get the selected receiving merchant, even after it is deactivated.
// A requester's list remains scoped to their wallet and performs no privileged
// identity/account enrichment.
const queryLog = [];
const lookupRows = {
  app_users: [
    { clerk_id: 'qr-requester', email: 'requester@example.test', first_name: 'QR', last_name: 'Requester', agency_code: null },
    { clerk_id: 'other-requester', email: 'other@example.test', first_name: 'Other', last_name: 'Requester', agency_code: null },
  ],
  wallet_company_bangla_qr_accounts: [
    { id: accountId, merchant_name: 'Selected Inactive Merchant', bank_name: 'Selected Bank', merchant_id: 'QR-SELECTED', active: false },
    { id: '16600000-0000-4000-8000-000000000099', merchant_name: 'Unrelated Merchant', bank_name: 'Other Bank', merchant_id: 'QR-OTHER', active: true },
  ],
};
supabase = {
  from: (table) => ({
    select: (columns) => ({
      in: (column, ids) => {
        queryLog.push({ table, columns, column, ids });
        return { data: lookupRows[table].filter((row) => ids.includes(row[column])), error: null };
      },
    }),
  }),
};
const ownRequest = { id: 'request-own-1', wallet_account_id: accountId, method: 'bangla_qr',
  requested_by_user_id: 'qr-requester', reviewed_by_user_id: null,
  company_bank_account_id: null, bangla_qr_account_id: accountId, attachment: null };
listedRequests = [ownRequest, { ...ownRequest, id: 'request-own-2' }, {
  ...ownRequest, id: 'request-other', wallet_account_id: 'other-wallet',
  requested_by_user_id: 'other-requester', method: 'cash', bangla_qr_account_id: null,
}];
sessionRole = 'staff_account';
const financialResponse = await route.GET();
assert.equal(financialResponse.status, 200);
const financialRequests = (await financialResponse.json()).data.requests;
assert.equal(financialRequests.length, 3);
for (const financialRequest of financialRequests.slice(0, 2)) {
  assert.deepEqual(financialRequest.bangla_qr_account, {
    merchantName: 'Selected Inactive Merchant', bankName: 'Selected Bank', merchantId: 'QR-SELECTED',
  });
}
assert.equal(financialRequests[2].bangla_qr_account, null);
const qrLookups = queryLog.filter((query) => query.table === 'wallet_company_bangla_qr_accounts');
assert.deepEqual(qrLookups, [{ table: 'wallet_company_bangla_qr_accounts',
  columns: 'id, merchant_name, bank_name, merchant_id', column: 'id', ids: [accountId] }],
'Merchant lookups must be batched and limited to the selected receiving accounts');
const queryCount = queryLog.length;
sessionRole = 'customer';
const requesterResponse = await route.GET();
assert.equal(requesterResponse.status, 200);
const requesterRequests = (await requesterResponse.json()).data.requests;
assert.deepEqual(requesterRequests.map((request) => request.id), ['request-own-1', 'request-own-2']);
assert.deepEqual(listScopes, [undefined, accountId]);
assert.equal(queryLog.length, queryCount, 'Requester lists must skip privileged enrichment');
for (const requesterRequest of requesterRequests) {
  assert.equal(Object.hasOwn(requesterRequest, 'requester'), false);
  assert.equal(Object.hasOwn(requesterRequest, 'bangla_qr_account'), false);
}

// Run the forward migration on the immutable installed schema, then verify real
// database checks and the existing manual approval function with local PGlite.
const migration = read('supabase/migrations/0166_bangla_qr_deposits.sql');
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage; create schema extensions; create extension pgcrypto with schema extensions;');
  await db.exec(read('supabase/fresh-install/supabase/migrations/20260911000000_kaliganj_baseline.sql'));
  const forwardDirectory = new URL('../supabase/fresh-install/supabase/migrations/', import.meta.url);
  const forwardNames = fs.readdirSync(forwardDirectory).filter((name) => name.endsWith('.sql')
    && name !== '20260911000000_kaliganj_baseline.sql'
    && !name.endsWith('_bangla_qr_deposits.sql')).sort();
  for (const name of forwardNames) {
    await db.exec(read(`supabase/fresh-install/supabase/migrations/${name}`));
  }
  await db.exec(migration);
  await db.query(`insert into wallet_company_bangla_qr_accounts
    (id,merchant_name,bank_name,merchant_id,qr_code)
    values ($1,'Test Merchant','Test Bank','QR-TEST',$2)`,
  [accountId, { localPath: '/images/payments/test.png' }]);
  await db.exec(migration);
  assert.equal((await db.query('select count(*)::int n from wallet_company_bangla_qr_accounts')).rows[0].n, 1);
  const security = (await db.query(`select
    has_table_privilege('anon','wallet_company_bangla_qr_accounts','SELECT') anon_read,
    has_table_privilege('authenticated','wallet_company_bangla_qr_accounts','UPDATE') client_update,
    has_table_privilege('service_role','wallet_company_bangla_qr_accounts','SELECT,INSERT,UPDATE,DELETE') service_access,
    (select relrowsecurity from pg_class where oid='wallet_company_bangla_qr_accounts'::regclass) rls`)).rows[0];
  assert.deepEqual(security, { anon_read: false, client_update: false, service_access: true, rls: true });
  await assert.rejects(() => db.exec("insert into wallet_company_bangla_qr_accounts(merchant_name) values(' ');"), /check constraint/);
  await assert.rejects(() => db.exec("insert into wallet_company_bangla_qr_accounts(merchant_name,qr_code) values('Test','[]');"), /check constraint/);

  await db.exec("insert into app_users(clerk_id,role) values('qr-requester','customer'),('qr-reviewer','staff_account');");
  const walletId = (await db.query("insert into wallets(owner_type,owner_key) values('user','qr-requester') returning id")).rows[0].id;
  const walletAccountId = (await db.query("insert into wallet_accounts(wallet_id,currency) values($1,'BDT') returning id", [walletId])).rows[0].id;
  async function deposit(reference = 'QR-TXN-001', qrId = accountId,
    attachment = { publicId: 'test/receipt', format: 'png' }, amount = 12345) {
    return db.query(`insert into wallet_deposit_requests
      (wallet_account_id,amount,gross_amount,currency,method,requested_by_user_id,
       bangla_qr_account_id,reference_number,attachment)
      values($1,$5,$5,'BDT','bangla_qr','qr-requester',$2,$3,$4) returning id,status,deposit_date`,
    [walletAccountId, qrId, reference, attachment, amount]);
  }
  await assert.rejects(() => deposit(' '), /check constraint/);
  await assert.rejects(() => deposit('QR', null), /check constraint/);
  await assert.rejects(() => deposit('QR', accountId, null), /check constraint/);
  await assert.rejects(() => deposit('QR', '16600000-0000-4000-8000-000000000099'), /foreign key constraint/);
  await assert.rejects(() => deposit('QR', accountId, {}, 0), /check constraint/);
  await assert.rejects(() => deposit('QR', accountId, {}, -1), /check constraint/);
  await assert.rejects(() => deposit('QR', accountId, {}, null), /not-null constraint/);
  for (const method of ['cash', 'bank', 'bank_transfer', 'mobile', 'cheque']) {
    await assert.rejects(() => db.query(`insert into wallet_deposit_requests
      (wallet_account_id,amount,currency,method,requested_by_user_id)
      values($1,12345,'BDT',$2,'qr-requester')`, [walletAccountId, method]), /check constraint/,
    `${method} must retain its existing required fields`);
  }
  const pending = (await deposit()).rows[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.deposit_date, null);
  async function balance() {
    return Number((await db.query('select available_balance from wallet_accounts where id=$1', [walletAccountId])).rows[0].available_balance);
  }
  assert.equal(await balance(), 0, 'Submitting a Bangla QR request must not credit the wallet');
  const selfReview = (await db.query("select wallet_review_deposit($1,'approved','qr-requester','customer',null) result", [pending.id])).rows[0].result;
  assert.equal(selfReview.code, 'SELF_APPROVAL_FORBIDDEN');
  const approved = (await db.query("select wallet_review_deposit($1,'approved','qr-reviewer','staff_account',null) result", [pending.id])).rows[0].result;
  assert.equal(approved.ok, true);
  assert.equal(await balance(), 12345);
  const replay = (await db.query("select wallet_review_deposit($1,'approved','qr-reviewer','staff_account',null) result", [pending.id])).rows[0].result;
  assert.equal(replay.code, 'ALREADY_REVIEWED');
  assert.equal(await balance(), 12345, 'Repeated approval must not credit twice');
  const rejectedId = (await deposit('QR-REJECT')).rows[0].id;
  const rejected = (await db.query("select wallet_review_deposit($1,'rejected','qr-reviewer','staff_account',null) result", [rejectedId])).rows[0].result;
  assert.equal(rejected.status, 'rejected');
  assert.equal(await balance(), 12345, 'Rejecting a request must not credit the wallet');
  await assert.rejects(() => db.query('delete from wallet_company_bangla_qr_accounts where id=$1', [accountId]), /foreign key constraint/);
  assert.equal((await db.query('select count(*)::int n from wallet_ledger_entries')).rows[0].n, 1);
} finally {
  await db.close();
}
console.log('Bangla QR API validation, private receipts, reviewer merchant details, requester privacy, database constraints and manual approval verified locally.');
