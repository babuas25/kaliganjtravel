import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = 'lib/shapontravels/client.ts';
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(
  compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0,
  0
);

function createClient(fetchImpl) {
  const module = { exports: {} };
  const env = {
    SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
    CLIENT_ID: '55555555-5555-4555-8555-555555555555',
    CLIENT_SECRET: 'fixture-secret',
  };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, 'server-only');
      return {};
    },
    process: { env },
    fetch: fetchImpl,
    Response,
    URL,
    Buffer,
    AbortSignal,
    Date,
    JSON,
    Number,
    Error,
    Promise,
  });
  new vm.Script(compiled.outputText, { filename: sourcePath }).runInContext(context);
  return { ...module.exports, env };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' },
  });
}

async function tokenIsSharedAndCached() {
  const calls = [];
  const client = createClient(async (url, init) => {
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/auth/token') {
      assert.deepEqual(JSON.parse(init.body), {
        client_id: '55555555-5555-4555-8555-555555555555',
        client_secret: 'fixture-secret',
      });
      return json({ access_token: 'stm_fixture', token_type: 'Bearer', expires_in: 1800 });
    }
    assert.equal(init.headers.authorization, 'Bearer stm_fixture');
    return json({ item1: { ok: true }, item2: { isSuccess: true } });
  });
  await Promise.all([
    client.shapontravelsRead('Search', { routes: [] }),
    client.shapontravelsRead('FareRules', { segmentCodeRefs: [] }),
  ]);
  await client.shapontravelsRead('Reprice', {});
  assert.equal(calls.filter((call) => call.path === '/auth/token').length, 1);
  assert.deepEqual(
    calls.filter((call) => call.path !== '/auth/token').map((call) => call.path).sort(),
    ['/api/FareRules', '/api/Reprice', '/api/Search']
  );
}

async function unauthorizedReadRenewsOnce() {
  let logins = 0;
  let reads = 0;
  const client = createClient(async (url, init) => {
    if (url.pathname === '/auth/token') {
      logins++;
      return json({ access_token: `stm_fixture_${logins}`, token_type: 'Bearer', expires_in: 1800 });
    }
    reads++;
    assert.equal(init.headers.authorization, `Bearer stm_fixture_${reads}`);
    return reads === 1 ? json({ error: 'INVALID_CREDENTIALS' }, 401) : json({ item1: {} });
  });
  await client.shapontravelsRead('Search', {});
  assert.equal(logins, 2);
  assert.equal(reads, 2);
}

async function errorsStayRedacted() {
  const client = createClient(async (url) =>
    url.pathname === '/auth/token'
      ? json({ error: 'INVALID_CREDENTIALS', secret: 'fixture-secret' }, 401)
      : json({})
  );
  await assert.rejects(client.shapontravelsRead('Search', {}), (error) => {
    assert.equal(error.code, 'INVALID_CREDENTIALS');
    assert.equal(error.status, 401);
    assert.equal(error.requestId, 'fixture-request');
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
  client.env.SHAPONTRAVELS_SEARCH_BASE_URL = 'http://supplier.example.test/';
  assert.equal(client.isShapontravelsConfigured(), false);
}

await tokenIsSharedAndCached();
await unauthorizedReadRenewsOnce();
await errorsStayRedacted();
console.log('Shapontravels read-client verification passed');
