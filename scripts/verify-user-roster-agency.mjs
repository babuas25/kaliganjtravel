import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const users = [
  ['partner', 'b2b', 'Partner'],
  ['sub', 'b2b_sub', 'Employee'],
  ['other', 'b2b', 'Other'],
  ['admin', 'admin', 'Administrator'],
].map(([id, role, firstName]) => ({
  id, publicMetadata: { role }, firstName, emailAddresses: [{ emailAddress: id + '@example.com' }],
  createdAt: 100, lastSignInAt: null, imageUrl: '',
}));
const memberships = new Map([['partner', 'ST-B2B659790'], ['sub', 'ST-B2B659790'], ['other', 'ST-B2B100000']]);
const dependencies = {
  '@/lib/account-access': { isUserActive: () => true },
  '@/lib/db/profiles': { agencyNamesFor: async () => new Map([['partner', 'Tripfeels']]) },
  '@/lib/db/agencies': { membershipsFor: async () => memberships },
  '@/lib/roles': { resolveRole: (role) => role, ROLES: ['b2b', 'b2b_sub', 'admin'] },
};
const module = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync('lib/dashboard/user-roster.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
new Function('require', 'module', 'exports', compiled)((id) => {
  assert.ok(dependencies[id], id);
  return dependencies[id];
}, module, module.exports);
const { loadRoster, resolveSort } = module.exports;
const client = { users: { getUserList: async () => ({ data: users, totalCount: users.length }) } };
const filters = { query: '', role: 'all', status: 'all', from: '', to: '', sort: 'newest', page: 1 };
const load = (patch, size = 20) => loadRoster(client, { ...filters, ...patch }, size);
for (const query of ['st-b2b659790', '659790', ' ST-B2B659790 ']) {
  const result = await load({ query }, 1);
  assert.equal(result.matched, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.summary.total, 4);
}
assert.equal((await load({ query: '659790', role: 'b2b_sub' })).entries[0].clerkId, 'sub');
assert.equal((await load({ query: 'Tripfeels' })).matched, 1);
assert.equal((await load({ query: 'admin@example.com' })).matched, 1);
assert.equal((await load({ query: 'missing' })).matched, 0);
assert.deepEqual((await load({ sort: 'agency-asc' })).entries.map((e) => e.clerkId), ['other', 'sub', 'partner', 'admin']);
assert.deepEqual((await load({ sort: 'agency-desc' })).entries.map((e) => e.clerkId), ['sub', 'partner', 'other', 'admin']);
assert.equal(resolveSort('agency-desc'), 'agency-desc');
assert.equal(resolveSort('invalid'), 'newest');
console.log('Agency ID search, role filtering, sorting and pagination checks passed.');
