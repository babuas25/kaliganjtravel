import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
const compiled = ts.transpileModule(fs.readFileSync('lib/promotional-tab-session.client.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const locks = new Set();
function tab(storage = new Map(), supported = true) {
  const events = new Map();
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    crypto: { randomUUID },
    navigator: supported ? { locks: { request: async (key, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (locks.has(key)) return callback(null);
      locks.add(key);
      try { return await callback({ name: key }); } finally { locks.delete(key); }
    } } } : {},
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    },
  });
  return { initialize: module.exports.initializePromotionalTabSession, storage, events };
}
const first = tab();
await first.initialize();
first.storage.set('promotion:tab-last-shown:user1', 'shown');
first.storage.set('unrelated-setting', 'keep');
await first.initialize();
assert.equal(first.storage.get('promotion:tab-last-shown:user1'), 'shown');
const duplicate = tab(new Map(first.storage));
await duplicate.initialize();
assert.notEqual(duplicate.storage.get('promotion:tab-identity'), first.storage.get('promotion:tab-identity'));
assert.equal(duplicate.storage.has('promotion:tab-last-shown:user1'), false);
assert.equal(duplicate.storage.get('unrelated-setting'), 'keep');
assert.equal(first.storage.get('promotion:tab-last-shown:user1'), 'shown');
first.events.get('pagehide')();
await new Promise((resolve) => setImmediate(resolve));
const refresh = tab(first.storage);
await refresh.initialize();
assert.equal(refresh.storage.get('promotion:tab-last-shown:user1'), 'shown');
const fresh = tab();
await fresh.initialize();
assert.equal(fresh.storage.has('promotion:tab-last-shown:user1'), false);
await tab(new Map(), false).initialize();
for (const instance of [duplicate, refresh, fresh]) instance.events.get('pagehide')();
console.log('Popup tab sessions: fresh and duplicated tabs, same-tab reuse, refresh persistence, unrelated storage preservation, and fallback passed.');
