import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const quiet = { log() {}, info() {}, error() {}, warn() {} };

function load(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected dependency in ${file}: ${id}`);
    },
    console: quiet, process: { env: { NODE_ENV: 'development' } }, performance,
    Response, Headers, ReadableStream, TextEncoder, setInterval, clearInterval,
  }, { filename: file });
  return module.exports;
}

const agency = load('lib/agency.ts', {});
const code = 'ST-B2B123456';
const userId = 'agency-test-user';

// Established memberships check the stored link, existing agency and owner in
// one fresh query, using the membership FK rather than the reverse owner link.
const membershipColumns = 'agency_code, agency:agencies!app_users_agency_code_fkey(owner_user_id)';
function membershipHarness(steps, noDatabase = false) {
  const pending = [...steps];
  const calls = [];
  const db = { from(table) {
    const filters = [];
    let operation = 'read';
    let columns;
    let changes;
    const execute = () => {
      const step = pending.shift();
      assert.ok(step, `Unexpected agency I/O: ${table}:${operation}`);
      calls.push({ table, operation, columns, filters: [...filters], changes });
      assert.equal(table, step.table);
      assert.equal(operation, step.operation ?? 'read');
      if (step.columns !== undefined) assert.equal(columns, step.columns);
      if (step.filters) assert.deepEqual(filters, step.filters);
      if (step.changes) assert.deepEqual(JSON.parse(JSON.stringify(changes)), step.changes);
      if (step.throws) throw new Error('Synthetic membership transport failure');
      return { data: step.data ?? null, error: step.error ?? null };
    };
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      insert(value) { operation = 'insert'; changes = value; return query; },
      update(value) { operation = 'update'; changes = value; return query; },
      maybeSingle: async () => execute(),
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
    };
    return query;
  } };
  const memberships = load('lib/db/agencies.ts', {
    '@/lib/agency': { ...agency, generateAgencyCode: () => code },
    '@/lib/supabase/server': { supabaseAdmin: () => noDatabase ? null : db },
  });
  return {
    memberships, calls,
    complete() { assert.equal(pending.length, 0, 'Expected agency I/O did not run'); },
  };
}
const membershipRead = (data, extra = {}) => ({
  table: 'app_users', columns: membershipColumns,
  filters: [['clerk_id', userId]], data, ...extra,
});

for (const [name, role, storedCode, owner, isOwner] of [
  ['partner owner', 'b2b', code, userId, true],
  ['sub user', 'b2b_sub', code, 'other-owner', false],
  ['sub-user role does not determine ownership', 'b2b_sub', code, userId, true],
  ['stored agency outranks mirror', 'b2b_sub', 'ST-B2B999999', 'other-owner', false],
  ['agency without a surviving owner', 'b2b_sub', code, null, false],
]) {
  const h = membershipHarness([membershipRead({ agency_code: storedCode, agency: { owner_user_id: owner } })]);
  const result = await h.memberships.resolveAgency(userId, role, 'ST-B2B999999');
  assert.equal(result.ok, true, name);
  assert.equal(result.agencyCode, storedCode, `${name}: stored membership outranks invitation metadata`);
  assert.equal(result.isOwner, isOwner, `${name}: ownership comes from the agency row`);
  assert.equal(h.calls.length, 1, `${name}: one live database query replaces two`);
  h.complete();
}

// A stale or malformed joined agency must fail closed without being repaired
// from untrusted invitation metadata or falling through to first-account writes.
for (const [name, data] of [
  ['missing agency', { agency_code: code, agency: null }],
  ['missing embedded property', { agency_code: code }],
  ['multiple agencies', { agency_code: code, agency: [{ owner_user_id: userId }] }],
  ['non-object agency', { agency_code: code, agency: 'invalid' }],
  ['missing owner field', { agency_code: code, agency: {} }],
  ['malformed owner field', { agency_code: code, agency: { owner_user_id: 123 } }],
  ['invalid agency code', { agency_code: 'invalid', agency: { owner_user_id: userId } }],
]) {
  for (const role of ['b2b', 'b2b_sub']) {
    const h = membershipHarness([membershipRead(data)]);
    assert.equal((await h.memberships.resolveAgency(userId, role, code)).ok, false, `${role}: ${name}`);
    assert.equal(h.calls.length, 1, `${name}: no fallback or mutation after failed membership validation`);
    h.complete();
  }
}

for (const data of [null, { agency_code: null, agency: null }]) {
  const h = membershipHarness([membershipRead(data)]);
  const result = await h.memberships.resolveAgency(userId, 'b2b_sub', undefined);
  assert.equal(result.ok, true);
  assert.equal(result.agencyCode, null, 'No stored membership remains unaffiliated');
  assert.equal(result.isOwner, false);
  h.complete();
}
{
  const h = membershipHarness([membershipRead(null, { error: { message: 'Schema relationship unavailable' } })]);
  assert.equal((await h.memberships.resolveAgency(userId, 'b2b_sub', code)).ok, false);
  h.complete();
}
{
  const h = membershipHarness([membershipRead(null, { throws: true })]);
  await assert.rejects(h.memberships.resolveAgency(userId, 'b2b_sub', code), /membership transport failure/);
  h.complete();
}
{
  const h = membershipHarness([], true);
  assert.equal((await h.memberships.resolveAgency(userId, 'b2b_sub', code)).ok, false);
  h.complete();
}

// New sub users still verify the seed against agencies before setting a link.
{
  const h = membershipHarness([
    membershipRead({ agency_code: null, agency: null }),
    { table: 'agencies', columns: 'agency_code', filters: [['agency_code', code]], data: { agency_code: code } },
    { table: 'app_users', operation: 'update', filters: [['clerk_id', userId]], changes: { agency_code: code } },
  ]);
  const result = await h.memberships.resolveAgency(userId, 'b2b_sub', code);
  assert.equal(result.ok, true);
  assert.equal(result.agencyCode, code);
  assert.equal(result.isOwner, false);
  h.complete();
}
{
  const h = membershipHarness([
    membershipRead({ agency_code: null, agency: null }),
    { table: 'agencies', columns: 'agency_code', filters: [['agency_code', code]], data: null },
  ]);
  assert.equal((await h.memberships.resolveAgency(userId, 'b2b_sub', code)).agencyCode, null);
  h.complete();
}

// First partner registration and recovery of an existing owned agency keep
// their guarded mutation path after a fresh successful membership read.
for (const existing of [false, true]) {
  const h = membershipHarness([
    membershipRead({ agency_code: null, agency: null }),
    { table: 'agencies', columns: 'agency_code', filters: [['owner_user_id', userId]], data: existing ? { agency_code: code } : null },
    ...(existing ? [] : [{ table: 'agencies', operation: 'insert', changes: { agency_code: code, owner_user_id: userId } }]),
    { table: 'app_users', operation: 'update', filters: [['clerk_id', userId]], changes: { agency_code: code } },
  ]);
  const result = await h.memberships.resolveAgency(userId, 'b2b', undefined);
  assert.equal(result.ok, true);
  assert.equal(result.agencyCode, code);
  assert.equal(result.isOwner, true);
  h.complete();
}

console.log('Agency membership: one live query, ownership, malformed/failing reads, and first-user seed/repair paths passed.');
