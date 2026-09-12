import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'lib', 'triplover', 'client.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
const diagnostics = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(diagnostics.length, 0, 'Triplover client must transpile');

const configBySupplier = {
  takeoff: {
    supplier: 'takeoff',
    baseUrl: 'https://takeoff-userapi.example.test',
    searchBaseUrl: 'https://takeoff-searchapi.example.test',
    email: 'takeoff@example.test',
    password: 'takeoff-password',
  },
  firsttrip: {
    supplier: 'firsttrip',
    baseUrl: 'https://firsttrip-userapi.example.test',
    searchBaseUrl: 'https://firsttrip-searchapi.example.test',
    email: 'firsttrip@example.test',
    password: 'firsttrip-password',
  },
};

function successEnvelope(item1 = { ok: true }) {
  return { item1, item2: { isSuccess: true } };
}

function jsonResponse(body, status = 200) {
  return {
    status,
    text: async () => JSON.stringify(body),
  };
}

function transportError(code) {
  const cause = new Error('transport');
  cause.code = code;
  const error = new Error('fetch failed');
  error.name = 'TypeError';
  error.cause = cause;
  return error;
}

function createClient(fetchImpl) {
  const module = { exports: {} };
  const warnings = [];
  const context = vm.createContext({
    module,
    exports: module.exports,
    AbortController,
    Date,
    Error,
    JSON,
    Math,
    Promise,
    TypeError,
    performance,
    fetch: fetchImpl,
    // Keep the production abort deadline real, but make the deliberate 250 ms
    // retry backoff immediate so this verifier stays fast.
    setTimeout(callback, ms, ...args) {
      return setTimeout(callback, ms === 250 ? 0 : ms, ...args);
    },
    clearTimeout,
    console: {
      warn(...args) {
        warnings.push(args.map(String).join(' '));
      },
      error() {},
      info() {},
    },
    require(specifier) {
      if (specifier === 'server-only') return {};
      if (specifier === 'crypto') return crypto;
      if (specifier.endsWith('/triplover/config')) {
        return {
          LOGIN_TIMEOUT_MS: 20_000,
          SUPPLIER_TIMEOUT_MS: 110_000,
          triploverConfig: (supplier) => configBySupplier[supplier] ?? null,
        };
      }
      throw new Error(`Unexpected client runtime import: ${specifier}`);
    },
  });
  new vm.Script(transpiled.outputText, { filename: sourcePath }).runInContext(context);
  return { ...module.exports, warnings };
}

function operationCalls(calls, suffix) {
  return calls.filter(({ url }) => new URL(url).pathname.endsWith(suffix));
}

async function takeoffTransientLoginRetriesOnce() {
  const calls = [];
  const traceEvents = [];
  let loginCount = 0;
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      loginCount += 1;
      if (loginCount === 1) throw transportError('ECONNRESET');
      return jsonResponse({
        isSuccess: true,
        data: { token: 'takeoff-token', tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    return jsonResponse(successEnvelope());
  });

  const result = await client.triploverCall('Search', '/api/Search', {}, {
    supplier: 'takeoff',
    searchTrace(event) {
      traceEvents.push(event);
    },
  });
  assert.equal(operationCalls(calls, '/api/user/apiLogIn').length, 2);
  assert.equal(operationCalls(calls, '/api/Search').length, 1);
  assert.equal(result.timing.tokenLoginAttempts, 2);
  assert.equal(result.timing.tokenSource, 'login');
  assert.equal(client.warnings.length, 1);
  const retryLog = client.warnings.join('\n');
  assert.match(retryLog, /TOKEN_LOGIN_NETWORK_CONNECTION/);
  assert.doesNotMatch(retryLog, /takeoff-password|takeoff-token|takeoff@example\.test/);
  assert.deepEqual(
    traceEvents
      .filter((event) => event.name === 'takeoff_search_request_start')
      .map((event) => event.details.attempt),
    [1],
    'a retried Login must still produce exactly one TakeOff Search request'
  );
  assert.equal(
    traceEvents.filter((event) => event.name === 'takeoff_search_first_byte').length,
    1
  );
  assert.equal(
    traceEvents.filter((event) => event.name === 'takeoff_search_response_complete').length,
    1
  );
}

async function takeoffTokenExpiryTraceShowsTheOnlySearchReplay() {
  const calls = [];
  const traceEvents = [];
  let searchCount = 0;
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      return jsonResponse({
        isSuccess: true,
        data: { token: `takeoff-token-${calls.length}`, tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    searchCount += 1;
    return searchCount === 1
      ? jsonResponse(successEnvelope(), 401)
      : jsonResponse(successEnvelope());
  });

  const result = await client.triploverCall('Search', '/api/Search', {}, {
    supplier: 'takeoff',
    searchTrace(event) {
      traceEvents.push(event);
    },
  });

  assert.equal(operationCalls(calls, '/api/Search').length, 2);
  assert.equal(result.timing.attempts, 2);
  assert.deepEqual(
    traceEvents
      .filter((event) => event.name === 'takeoff_search_request_start')
      .map((event) => event.details.attempt),
    [1, 2]
  );
  assert.deepEqual(
    traceEvents
      .filter((event) => event.name === 'takeoff_search_token_expiry_retry')
      .map((event) => event.details.attempt),
    [1]
  );
}

async function firsttripLoginIsNotRetried() {
  const calls = [];
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    throw transportError('ENOTFOUND');
  });

  await assert.rejects(
    () => client.triploverCall('Search', '/api/Search', {}, { supplier: 'firsttrip' }),
    (error) =>
      error instanceof client.TriploverError &&
      error.diagnostic?.code === 'TOKEN_LOGIN_NETWORK_DNS' &&
      error.diagnostic?.loginAttempts === 1
  );
  assert.equal(operationCalls(calls, '/api/user/apiLogIn').length, 1);
  assert.equal(operationCalls(calls, '/api/Search').length, 0);
  assert.equal(client.warnings.length, 0);
}

async function authFailuresAndTransportClassesStayDistinct() {
  const authCalls = [];
  const authClient = createClient(async (url, init) => {
    authCalls.push({ url, init });
    return jsonResponse({ isSuccess: false, message: 'invalid credentials' }, 200);
  });
  await assert.rejects(
    () => authClient.triploverCall('Search', '/api/Search', {}, { supplier: 'takeoff' }),
    (error) => error instanceof authClient.TriploverError && error.kind === 'auth'
  );
  assert.equal(operationCalls(authCalls, '/api/user/apiLogIn').length, 1);
  assert.equal(operationCalls(authCalls, '/api/Search').length, 0);
  assert.equal(authClient.warnings.length, 0, 'authentication failures must not retry');

  const tlsCalls = [];
  const tlsClient = createClient(async (url, init) => {
    tlsCalls.push({ url, init });
    throw transportError('ERR_TLS_CERT_ALTNAME_INVALID');
  });
  await assert.rejects(
    () => tlsClient.triploverCall('Search', '/api/Search', {}, { supplier: 'firsttrip' }),
    (error) =>
      error instanceof tlsClient.TriploverError &&
      error.diagnostic?.code === 'TOKEN_LOGIN_NETWORK_TLS' &&
      error.diagnostic?.transport === 'tls'
  );
  assert.equal(operationCalls(tlsCalls, '/api/user/apiLogIn').length, 1);

  const timeoutCalls = [];
  const timeoutClient = createClient(async (url, init) => {
    timeoutCalls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      return jsonResponse({
        isSuccess: true,
        data: { token: 'takeoff-token', tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  await assert.rejects(
    () => timeoutClient.triploverCall('Search', '/api/Search', {}, { supplier: 'takeoff' }),
    (error) =>
      error instanceof timeoutClient.TriploverError &&
      error.diagnostic?.code === 'SEARCH_TIMEOUT' &&
      error.diagnostic?.transport === 'timeout'
  );
  assert.equal(operationCalls(timeoutCalls, '/api/Search').length, 1);
}

async function concurrentTakeoffSearchesShareOneRetriedLogin() {
  const calls = [];
  let loginCount = 0;
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      loginCount += 1;
      if (loginCount === 1) throw transportError('UND_ERR_CONNECT_TIMEOUT');
      return jsonResponse({
        isSuccess: true,
        data: { token: 'takeoff-token', tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    return jsonResponse(successEnvelope());
  });

  const [first, second] = await Promise.all([
    client.triploverCall('Search', '/api/Search', { request: 1 }, { supplier: 'takeoff' }),
    client.triploverCall('Search', '/api/Search', { request: 2 }, { supplier: 'takeoff' }),
  ]);
  assert.equal(operationCalls(calls, '/api/user/apiLogIn').length, 2);
  assert.equal(operationCalls(calls, '/api/Search').length, 2);
  assert.deepEqual(
    new Set([first.timing.tokenSource, second.timing.tokenSource]),
    new Set(['login', 'shared-login'])
  );
  assert.equal(first.timing.tokenLoginAttempts, 2);
  assert.equal(second.timing.tokenLoginAttempts, 2);
}

async function staleTokenFailureCannotDeleteAFreshTakeoffToken() {
  const calls = [];
  let loginCount = 0;
  let concurrentSearchCount = 0;
  let releaseOldSearch;
  const oldSearchResponse = new Promise((resolve) => {
    releaseOldSearch = resolve;
  });
  let firstSearchStartedResolve;
  const firstSearchStarted = new Promise((resolve) => {
    firstSearchStartedResolve = resolve;
  });
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      loginCount += 1;
      return jsonResponse({
        isSuccess: true,
        data: {
          token: `takeoff-token-${loginCount}`,
          tokenExpieryTime: '2030-01-01T00:00:00.000Z',
        },
      });
    }
    if (init.body?.includes('prime')) return jsonResponse(successEnvelope());
    concurrentSearchCount += 1;
    if (concurrentSearchCount === 1) {
      firstSearchStartedResolve();
      return oldSearchResponse;
    }
    if (concurrentSearchCount === 2) return jsonResponse(successEnvelope(), 401);
    return jsonResponse(successEnvelope());
  });

  // Prime the cache with a token both concurrent calls will initially use.
  await client.triploverCall('Search', '/api/Search', { prime: true }, { supplier: 'takeoff' });
  const oldTokenSearch = client.triploverCall('Search', '/api/Search', { request: 'old' }, {
    supplier: 'takeoff',
  });
  await firstSearchStarted;
  await client.triploverCall('Search', '/api/Search', { request: 'newer' }, {
    supplier: 'takeoff',
  });
  releaseOldSearch(jsonResponse(successEnvelope(), 401));
  await oldTokenSearch;

  assert.equal(
    operationCalls(calls, '/api/user/apiLogIn').length,
    2,
    'an old 401 must not evict the freshly minted TakeOff token'
  );
  assert.equal(concurrentSearchCount, 4);
}

async function networkFailuresNeverReplaySearchOrBook() {
  const calls = [];
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      return jsonResponse({
        isSuccess: true,
        data: { token: 'takeoff-token', tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    throw transportError('ECONNRESET');
  });

  await assert.rejects(
    () => client.triploverCall('Search', '/api/Search', {}, { supplier: 'takeoff' }),
    (error) => error instanceof client.TriploverError && error.diagnostic?.code === 'SEARCH_NETWORK_CONNECTION'
  );
  assert.equal(operationCalls(calls, '/api/Search').length, 1);

  await assert.rejects(
    () => client.triploverCall('Book', '/api/Book', {}, { supplier: 'takeoff' }),
    (error) => error instanceof client.TriploverError && error.diagnostic?.code === 'TRIPLOVER_BOOK_NETWORK_CONNECTION'
  );
  assert.equal(operationCalls(calls, '/api/Book').length, 1);
  assert.equal(operationCalls(calls, '/api/user/apiLogIn').length, 1, 'warm token must be reused');
}

async function takeoffLoginRetryDoesNotDuplicateBook() {
  const calls = [];
  let loginCount = 0;
  const client = createClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/user/apiLogIn')) {
      loginCount += 1;
      if (loginCount === 1) throw transportError('EAI_AGAIN');
      return jsonResponse({
        isSuccess: true,
        data: { token: 'takeoff-token', tokenExpieryTime: '2030-01-01T00:00:00.000Z' },
      });
    }
    return jsonResponse(successEnvelope({ pnr: 'SAFE-ONLY-ONCE' }));
  });

  await client.triploverCall('Book', '/api/Book', {}, { supplier: 'takeoff' });
  assert.equal(operationCalls(calls, '/api/user/apiLogIn').length, 2);
  assert.equal(operationCalls(calls, '/api/Book').length, 1);
}

await takeoffTransientLoginRetriesOnce();
await takeoffTokenExpiryTraceShowsTheOnlySearchReplay();
await firsttripLoginIsNotRetried();
await authFailuresAndTransportClassesStayDistinct();
await concurrentTakeoffSearchesShareOneRetriedLogin();
await staleTokenFailureCannotDeleteAFreshTakeoffToken();
await networkFailuresNeverReplaySearchOrBook();
await takeoffLoginRetryDoesNotDuplicateBook();

assert.match(source, /invalidateToken\(config\.supplier, token\)/);
assert.match(source, /text = await response\.text\(\)/);
assert.match(source, /TAKEOFF_LOGIN_NETWORK_RETRY_COUNT/);
assert.match(source, /config\.supplier === 'takeoff'/);

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'flights', 'search', 'route.ts'),
  'utf8'
);
for (const required of [
  'TOKEN_LOGIN_TIMEOUT',
  'TOKEN_LOGIN_NETWORK_',
  'SEARCH_TIMEOUT',
  '[flight-search-failure]',
  'tokenLoginAttempts',
  'X-Flight-Search-Trace',
  'first_sse_event_enqueued',
]) {
  assert.ok(routeSource.includes(required), `Search route is missing ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      takeoffLoginRetry: 'one transient network retry only',
      firsttripLoginRetry: 'unchanged (none)',
      singleFlight: 'shared across concurrent callers in one warm instance',
      unsafeOperationReplay: 'disabled for Search and Book transport failures',
      diagnostics: 'secret-free token/login, DNS/TLS/connection and timeout codes',
    },
    null,
    2
  )
);
