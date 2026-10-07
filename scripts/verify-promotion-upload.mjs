import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import ts from 'typescript';

function loadModule(filename, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Buffer,
    File,
    ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports;
}

const uploadVerification = loadModule('lib/upload-verify.ts');
const calls = { decoder: [], uploads: [], audits: [], limits: [] };
let session = { clerkId: 'synthetic-media-user', role: 'staff_media' };
let limitResult = { ok: true };
let auditAvailable = true;
let uploadResult = { ok: true, asset: { url: 'https://example.test/promotion.webp' } };

// Execute the real action and raster validator. Only Sharp processes local
// synthetic pixels; storage, authentication, auditing and rate limits are fake.
const actions = loadModule('app/(dashboard)/dashboard/media/promotion-actions.ts', {
  'node:crypto': { randomUUID },
  sharp(bytes, options) {
    calls.decoder.push({ bytes, options });
    return sharp(bytes, options);
  },
  'next/cache': { revalidatePath() { throw new Error('Upload must not publish changes.'); } },
  '@/lib/dashboard/session': { async getDashboardSession() { return session; } },
  '@/lib/roles': { canManageMedia: (role) => ['superadmin', 'admin', 'staff_media'].includes(role) },
  '@/lib/supabase/server': { supabaseAdmin() { throw new Error('Upload must not access the database.'); } },
  '@/lib/promotional-popup': {},
  '@/lib/cloudinary': {
    FOLDERS: { marketing: 'synthetic-marketing' },
    async uploadAsset(bytes, mime, options) {
      calls.uploads.push({ bytes, mime, options });
      return uploadResult;
    },
  },
  '@/lib/rate-limit': {
    async checkActionLimit(action, user) {
      calls.limits.push({ action, user });
      return limitResult;
    },
    rateLimitMessage: () => 'Synthetic rate limit.',
  },
  '@/lib/db/security': {
    async recordSecurityAuditEvent(event) {
      calls.audits.push(event);
      return auditAvailable;
    },
  },
  '@/lib/upload-verify': uploadVerification,
});

function resetCalls() {
  for (const values of Object.values(calls)) values.length = 0;
}

async function upload(bytes, mime, name = 'synthetic-image') {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type: mime }));
  return actions.uploadPromotionAction(form);
}

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
for (const mime of ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']) {
  resetCalls();
  const result = await upload(svg, mime, 'disguised.svg');
  assert.equal(result.ok, false, `SVG claiming ${mime} must be rejected`);
  assert.equal(calls.decoder.length, 0, `SVG claiming ${mime} must never enter Sharp`);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.audits.length, 0);
}

const fixtures = {};
for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
  // Generate valid raster fixtures without reading any local assets.
  const fixture = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#f68712' } })[format]().toBuffer();
  fixtures[mime] = fixture;
  resetCalls();
  const result = await upload(fixture, mime);
  assert.equal(result.ok, true, `${format} must still upload successfully`);
  assert.equal(result.url, uploadResult.asset.url);
  assert.equal(calls.decoder.length, 1);
  assert.equal(calls.decoder[0].options.limitInputPixels, 24000000);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].mime, 'image/webp');
  const output = await sharp(calls.uploads[0].bytes).metadata();
  assert.equal(output.format, 'webp');
  assert.equal(output.width, 8);
  assert.equal(output.height, 6);
  assert.equal(calls.audits.map((event) => event.outcome).join(','), 'attempted,succeeded');
  assert.equal(calls.limits[0].action, 'manageHomepageOffers');
}

for (const [mime, bytes] of Object.entries(fixtures)) {
  resetCalls();
  const mismatchedMime = mime === 'image/png' ? 'image/jpeg' : 'image/png';
  const result = await upload(bytes, mismatchedMime);
  assert.equal(result.ok, false, 'MIME must match the raster signature');
  assert.equal(calls.decoder.length, 0, 'Mismatched raster MIME must fail before decoding');
}

for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
  resetCalls();
  assert.equal((await upload(bytes, 'image/png')).ok, false);
  assert.equal(calls.decoder.length, 0, 'Size limits must apply before decoding');
}

for (const blockedSession of [null, { clerkId: 'synthetic-customer', role: 'customer' }]) {
  session = blockedSession;
  resetCalls();
  assert.equal((await upload(fixtures['image/png'], 'image/png')).ok, false);
  assert.equal(calls.decoder.length, 0);
  assert.equal(calls.limits.length, 0, 'Authorization must happen before consuming rate limits');
}
session = { clerkId: 'synthetic-media-user', role: 'staff_media' };
limitResult = { ok: false, retryAfterSeconds: 60 };
resetCalls();
assert.equal((await upload(fixtures['image/png'], 'image/png')).message, 'Synthetic rate limit.');
assert.equal(calls.decoder.length, 0);
limitResult = { ok: true };

auditAvailable = false;
resetCalls();
assert.equal((await upload(fixtures['image/png'], 'image/png')).ok, false);
assert.equal(calls.uploads.length, 0, 'Storage must stop when the audit service is unavailable');
auditAvailable = true;
uploadResult = { ok: false, message: 'Synthetic storage failure.' };
resetCalls();
assert.equal((await upload(fixtures['image/png'], 'image/png')).message, 'Synthetic storage failure.');
assert.equal(calls.audits.map((event) => event.outcome).join(','), 'attempted,failed');

console.log('promotion upload verification passed: raster uploads, pre-decoder SVG/MIME rejection, authorization, limits and audit ordering');
