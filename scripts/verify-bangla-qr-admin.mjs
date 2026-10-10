import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function compile(path, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', 'module', 'require', compiled)(module.exports, module, (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name === 'zod') return require(name);
    throw new Error(`Unexpected infrastructure import: ${name}`);
  });
  return module.exports;
}

// The real routes and byte validators run against in-memory infrastructure.
// This script never connects to a database, uploads a file or sends a message.
const accountId = '16600000-0000-4000-8000-000000000001';
const initialTime = '2026-10-08T00:00:00.000Z';
let state;
function reset(overrides = {}) {
  state = {
    role: 'superadmin', cloudConfigured: true, storageAvailable: true,
    rateAllowed: true, auditAvailable: true, uploadsSucceed: true,
    calls: [], uploadCount: 0, clock: 0, concurrentOnAuditAction: null,
    rows: [{
      id: accountId, merchant_name: 'Test Merchant', bank_name: 'Test Bank',
      merchant_id: 'QR-TID-001', qr_code: { localPath: '/images/payments/bangla-qr.png' },
      active: true, sort_order: 0, created_at: initialTime, updated_at: initialTime,
    }],
    ...overrides,
  };
}
reset();
const nextTime = () => `2026-10-08T00:00:${String(++state.clock).padStart(2, '0')}.000Z`;
const clone = (value) => structuredClone(value);

class Query {
  constructor(table) {
    assert.equal(table, 'wallet_company_bangla_qr_accounts');
    this.kind = 'select';
    this.filters = [];
    this.sorts = [];
  }
  select(columns = '*') { this.columns = columns; return this; }
  order(column, options = {}) { this.sorts.push([column, options.ascending !== false]); return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  insert(values) { this.kind = 'insert'; this.values = values; return this; }
  update(values) { this.kind = 'update'; this.values = values; return this; }
  single() { return this.execute(true); }
  maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }
  async execute(single) {
    state.calls.push({ type: 'db', kind: this.kind, values: clone(this.values), filters: clone(this.filters) });
    if (state.databaseError) return { data: null, error: state.databaseError };
    let rows = state.rows.filter((row) => this.filters.every(([key, value]) => row[key] === value));
    if (this.kind === 'insert') {
      const row = {
        id: '16600000-0000-4000-8000-000000000002', qr_code: null,
        created_at: initialTime, updated_at: nextTime(), ...this.values,
      };
      state.rows.push(row);
      rows = [row];
    } else if (this.kind === 'update') {
      rows.forEach((row) => Object.assign(row, this.values, { updated_at: nextTime() }));
    }
    for (const [key, ascending] of [...this.sorts].reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0;
        return ascending ? comparison : -comparison;
      });
    }
    const data = rows.map((row) => this.columns && this.columns !== '*'
      ? Object.fromEntries(this.columns.split(',').map((column) => [column.trim(), clone(row[column.trim()])]))
      : clone(row));
    return { data: single ? data[0] ?? null : data, error: null };
  }
}

const cloudinary = {
  isCloudinaryConfigured: () => state.cloudConfigured,
  publicUrl: (id, version) => state.cloudConfigured ? `https://images.example.test/${id}/v${version}` : null,
  uploadAsset: async (_bytes, mime, options) => {
    assert.equal(options.folder, 'kaliganj-travels/wallet/bangla-qr');
    assert.notEqual(options.authenticated, true, 'Payment instructions must use public image uploads');
    state.calls.push({ type: 'upload', mime });
    if (!state.uploadsSucceed) return { ok: false, message: 'Mocked upload failed.' };
    return { ok: true, asset: {
      publicId: `${options.folder}/new-${++state.uploadCount}`,
      version: 1, format: 'png', createdAt: initialTime,
    } };
  },
  destroyAsset: async (publicId) => { state.calls.push({ type: 'destroy', publicId }); },
};
const assets = compile('lib/wallet/bangla-qr.ts', { '@/lib/cloudinary': cloudinary });
const dependencies = {
  '@/lib/cloudinary': cloudinary,
  '@/lib/dashboard/session': {
    getDashboardSession: async () => state.role ? { clerkId: 'qr-admin', role: state.role } : null,
  },
  '@/lib/db/security': {
    securitySubjectHash: (value) => `hash:${value}`,
    recordSecurityAuditEvent: async (event) => {
      state.calls.push({ type: 'audit', event });
      if (event.outcome === 'attempted' && event.action === state.concurrentOnAuditAction) {
        state.rows[0].updated_at = nextTime();
      }
      return state.auditAvailable;
    },
  },
  '@/lib/rate-limit': {
    checkActionLimit: async () => ({ ok: state.rateAllowed, retryAfterSeconds: 30 }),
    rateLimitMessage: () => 'Try again later.',
  },
  '@/lib/supabase/server': {
    supabaseAdmin: () => state.storageAvailable ? { from: (table) => new Query(table) } : null,
  },
  '@/lib/upload-verify': compile('lib/upload-verify.ts'),
  '@/lib/wallet/bangla-qr': assets,
  '@/lib/wallet/http': {
    walletOk: (data, status = 200) => Response.json({ success: true, data }, { status }),
    walletFail: (status, errorCode, errorMessage) => Response.json({ errorCode, errorMessage }, { status }),
  },
};
const accountsRoute = compile('app/api/wallet/company-bangla-qr-accounts/route.ts', dependencies);
const qrRoute = compile('app/api/wallet/company-bangla-qr-accounts/[id]/qr-code/route.ts', dependencies);
const jsonRequest = (method, body) => new Request('https://example.test/api/wallet/company-bangla-qr-accounts', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const fields = { merchantName: 'Test Merchant', bankName: 'Test Bank', merchantId: 'QR-TID-001', sortOrder: 0 };
const create = (overrides = {}) => accountsRoute.POST(jsonRequest('POST', { ...fields, ...overrides }));
const patch = (overrides = {}) => accountsRoute.PATCH(jsonRequest('PATCH', { id: accountId, ...fields, active: true, ...overrides }));
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const qrFile = () => new File([pngBytes], 'qr.png', { type: 'image/png' });
async function upload(file = qrFile(), id = accountId, headers) {
  const form = new FormData();
  if (file) form.set('asset', file);
  return qrRoute.POST(new Request('https://example.test/api/wallet/company-bangla-qr-accounts/qr-code', {
    method: 'POST', body: form, headers,
  }), { params: Promise.resolve({ id }) });
}
const remove = (id = accountId) => qrRoute.DELETE(new Request('https://example.test/qr-code', {
  method: 'DELETE',
}), { params: Promise.resolve({ id }) });
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).errorCode, code);
}
const mutations = () => state.calls.filter((call) => call.type === 'db' && call.kind !== 'select');
const destroys = () => state.calls.filter((call) => call.type === 'destroy').map((call) => call.publicId);
const uploadedId = 'kaliganj-travels/wallet/bangla-qr/new-1';
const oldAsset = { publicId: 'kaliganj-travels/wallet/bangla-qr/old-image', version: 2, format: 'png' };

for (const role of [null, 'admin', 'staff_account', 'b2b', 'b2c']) {
  reset({ role });
  for (const operation of [() => accountsRoute.GET(), create, patch, upload, remove]) {
    await expectError(await operation(), 403, 'SUPERADMIN_REQUIRED');
  }
  assert.deepEqual(state.calls, [], 'Denied roles must never reach storage or image services');
}

reset();
const listed = await accountsRoute.GET();
assert.equal(listed.status, 200);
const listedData = (await listed.json()).data;
assert.equal(listedData.accounts[0].qrCodeUrl, assets.BANGLA_QR_BUNDLED_IMAGE);
assert.equal(listedData.uploadConfigured, true);
assert.equal(Object.hasOwn(listedData.accounts[0], 'qr_code'), false, 'Raw stored handles stay server-side');
const created = await create({ merchantName: '  New Merchant  ', bankName: '', merchantId: '', active: true,
  qrCodeUrl: 'https://untrusted.example.test/qr.png', qr_code: { localPath: '/private/receipt.png' } });
assert.equal(created.status, 201);
const newAccount = (await created.json()).data.account;
assert.equal(newAccount.merchantName, 'New Merchant');
assert.equal(newAccount.bankName, null);
assert.equal(newAccount.merchantId, null);
assert.equal(newAccount.active, false, 'New accounts cannot receive payments before QR upload');
assert.equal(newAccount.qrCodeUrl, null, 'Client-supplied image handles must not be persisted');

reset();
state.rows[0].qr_code = null;
await expectError(await patch(), 400, 'QR_REQUIRED');
assert.equal(mutations().length, 0);
assert.equal((await patch({ active: false })).status, 200);
assert.equal(state.rows[0].active, false);
reset();
await expectError(await patch({ id: 'not-a-uuid' }), 400, 'INVALID_BANGLA_QR_ACCOUNT');
await expectError(await create({ merchantName: ' ' }), 400, 'INVALID_BANGLA_QR_ACCOUNT');
await expectError(await create({ sortOrder: -1 }), 400, 'INVALID_BANGLA_QR_ACCOUNT');
assert.equal(mutations().length, 0);

reset({ auditAvailable: false });
for (const operation of [create, patch, upload, remove]) {
  await expectError(await operation(), 503, 'AUDIT_UNAVAILABLE');
}
assert.equal(mutations().length, 0, 'Audit outage must prevent writes');
assert.equal(state.uploadCount, 0);
reset({ rateAllowed: false });
for (const operation of [create, patch, upload, remove]) {
  await expectError(await operation(), 429, 'RATE_LIMITED');
}
assert.deepEqual(state.calls, []);
reset({ storageAvailable: false });
await expectError(await accountsRoute.GET(), 503, 'STORAGE_ERROR');
reset({ databaseError: { message: 'Could not find the table wallet_company_bangla_qr_accounts in the schema cache' } });
await expectError(await accountsRoute.GET(), 503, 'SETUP_REQUIRED');

reset();
await expectError(await upload(null), 400, 'ASSET_REQUIRED');
await expectError(await upload(new File([], 'empty.png', { type: 'image/png' })), 400, 'ASSET_REQUIRED');
await expectError(await upload(new File([pngBytes], 'qr.txt', { type: 'text/plain' })), 400, 'INVALID_ASSET_TYPE');
await expectError(await upload(new File(['not an image'], 'qr.png', { type: 'image/png' })), 400, 'INVALID_ASSET');
await expectError(await upload(new File([pngBytes], 'qr.jpg', { type: 'image/jpeg' })), 400, 'INVALID_ASSET');
await expectError(await upload(new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  'qr.svg', { type: 'image/svg+xml' })), 400, 'INVALID_ASSET');
await expectError(await upload(new File([new Uint8Array(512 * 1024 + 1)], 'qr.png', { type: 'image/png' })),
  413, 'ASSET_TOO_LARGE');
await expectError(await upload(qrFile(), accountId, { 'content-length': String(700 * 1024) }), 413, 'ASSET_TOO_LARGE');
await expectError(await upload(qrFile(), 'bad-id'), 400, 'INVALID_BANGLA_QR_ACCOUNT');
await expectError(await remove('bad-id'), 400, 'INVALID_BANGLA_QR_ACCOUNT');
assert.equal(state.uploadCount, 0, 'Invalid images must not be uploaded');
assert.equal(mutations().length, 0);
reset({ cloudConfigured: false });
await expectError(await upload(), 503, 'UPLOAD_UNAVAILABLE');
assert.equal((await (await accountsRoute.GET()).json()).data.accounts[0].qrCodeUrl, assets.BANGLA_QR_BUNDLED_IMAGE);
assert.deepEqual(state.calls.filter((call) => call.type === 'upload'), []);

reset();
state.rows[0].qr_code = oldAsset;
const uploaded = await upload();
assert.equal(uploaded.status, 200);
assert.equal(state.rows[0].qr_code.publicId, uploadedId);
assert.equal((await uploaded.json()).data.assetUrl, `https://images.example.test/${uploadedId}/v1`);
assert.deepEqual(destroys(), [oldAsset.publicId]);
assert.ok(state.calls.find((call) => call.type === 'db' && call.kind === 'update').filters
  .some(([key, value]) => key === 'updated_at' && value === initialTime));

reset({ concurrentOnAuditAction: 'wallet.payment_bangla_qr_uploaded' });
state.rows[0].qr_code = oldAsset;
await expectError(await upload(), 409, 'ACCOUNT_CHANGED');
assert.deepEqual(state.rows[0].qr_code, oldAsset, 'A stale upload cannot replace a concurrently changed account');
assert.deepEqual(destroys(), [uploadedId], 'Only the abandoned new image is deleted after an optimistic conflict');
reset({ uploadsSucceed: false });
await expectError(await upload(), 400, 'ASSET_UPLOAD_FAILED');
assert.equal(mutations().length, 0);

reset({ concurrentOnAuditAction: 'wallet.payment_bangla_qr_account_updated' });
await expectError(await patch({ merchantName: 'Overwritten Merchant' }), 409, 'ACCOUNT_CHANGED');
assert.equal(state.rows[0].merchant_name, 'Test Merchant');
reset();
state.rows[0].qr_code = oldAsset;
assert.equal((await remove()).status, 200);
assert.equal(state.rows[0].qr_code, null);
assert.equal(state.rows[0].active, false, 'Removing payment instructions must deactivate the account');
assert.deepEqual(destroys(), [oldAsset.publicId]);
assert.ok(state.calls.findIndex((call) => call.type === 'db' && call.kind === 'update') <
  state.calls.findIndex((call) => call.type === 'destroy'), 'Persist QR removal before deleting its image');
reset({ concurrentOnAuditAction: 'wallet.payment_bangla_qr_removed' });
state.rows[0].qr_code = oldAsset;
await expectError(await remove(), 409, 'ACCOUNT_CHANGED');
assert.deepEqual(state.rows[0].qr_code, oldAsset);
assert.deepEqual(destroys(), [], 'Stale QR removal must preserve current image storage');

reset();
for (const value of [
  null, [], 'https://example.test/qr.png', { url: 'https://example.test/qr.png' },
  { localPath: '/images/payments/another-qr.png' }, { localPath: '/private/receipt.png' },
  { ...oldAsset, publicId: 'private/receipt' }, { ...oldAsset, publicId: `${oldAsset.publicId}/../receipt` },
  { ...oldAsset, version: 0 }, { ...oldAsset, version: 1.5 }, { ...oldAsset, format: 'pdf' },
]) {
  assert.equal(assets.banglaQrAssetUrl(value), null, `Reject untrusted image handle: ${JSON.stringify(value)}`);
}
assert.equal(assets.banglaQrAssetUrl({ localPath: assets.BANGLA_QR_BUNDLED_IMAGE }), assets.BANGLA_QR_BUNDLED_IMAGE);
assert.equal(assets.banglaQrAssetUrl(oldAsset), `https://images.example.test/${oldAsset.publicId}/v2`);
state.rows[0].qr_code = { publicId: 'private/receipt', version: 1, format: 'png' };
await expectError(await patch(), 400, 'QR_REQUIRED');
assert.equal((await remove()).status, 200);
assert.deepEqual(destroys(), [], 'Untrusted or private document handles can never be deleted by the QR endpoint');

console.log('Bangla QR admin permissions, trusted public instructions, activation, byte validation, optimistic writes and cleanup verified locally.');
