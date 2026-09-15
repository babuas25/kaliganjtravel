import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the component's hooks and user events with deferred supplier reads.
const source = fs.readFileSync('components/flights/BookingDeadlineNotice.tsx', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
let hooks, cursor, effects, dirty, props, tree, requests, busy, refreshes, timers;
const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
const react = {
  useState(initial) {
    const i = cursor++;
    hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[i].value, (next) => {
      const value = typeof next === 'function' ? next(hooks[i].value) : next;
      if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; }
    }];
  },
  useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
  useId() { cursor++; return 'deadline-toggle'; },
  useEffect(fn, deps) {
    const i = cursor++;
    if (changed(hooks[i]?.deps, deps)) effects.push(() => {
      hooks[i]?.cleanup?.();
      hooks[i] = { deps, cleanup: fn() };
    });
  },
};
const jsx = (type, props) => ({ type, props });
const module = { exports: {} };
new Function('exports', 'require', 'window', 'fetch', code)(module.exports, (name) => {
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react') return react;
  if (name === 'next/navigation') return { useRouter: () => ({ refresh: () => refreshes++ }) };
  if (name === 'lucide-react') return { Clock3: 'Clock3', Loader2: 'Loader2' };
  if (name === '@/components/ui/switch') return { Switch: 'Switch' };
  throw new Error(`Unexpected import ${name}`);
}, {
  setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
}, (url, options) => new Promise((resolve, reject) => {
  requests.push({ url, options, resolve, reject });
  options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
}));
function render(nextProps = {}) {
  props = { ...props, ...nextProps };
  let passes = 0;
  do {
    assert.ok(++passes < 10, 'Rendering must settle');
    dirty = false; cursor = 0; effects = [];
    tree = module.exports.BookingDeadlineNotice(props);
    effects.forEach(fn => fn());
  } while (dirty);
  return tree;
}
const savedTime = '2030-10-02T08:15:00Z';
const freshTime = '2030-10-02T09:30:00Z';
function reset(overrides = {}) {
  hooks = []; requests = []; busy = []; refreshes = 0; timers = new Map();
  props = { deadline: savedTime, bookingReference: 'KTTABC123ABC123', allowRefresh: true,
    onRefreshingChange: value => busy.push(value), ...overrides };
  return render();
}
function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map(n => find(n, type)).find(Boolean);
  return node.type === type ? node : find(node.props?.children, type);
}
function content(node = tree) {
  if (Array.isArray(node)) return node.map(content).join(' ');
  if (node && typeof node === 'object') return content(node.props?.children ?? null);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function toggle(checked) { find(tree, 'Switch').props.onCheckedChange(checked); render(); }
async function settle(body, status = 200) {
  requests.at(-1).resolve({ ok: status < 400, json: async () => body });
  await new Promise(resolve => setImmediate(resolve));
  render();
}
const success = (updated, time = null) => ({ success: true, data: { updated, ticketingDeadlineAt: time } });

reset({ allowRefresh: false });
assert.match(content(), /2 Oct 2030, 14:15.*Bangladesh time/);
assert.equal(find(tree, 'Switch'), null);
render({ deadline: null });
assert.match(content(), /Ticketing deadline unavailable/);
render({ deadline: 'invalid' });
assert.match(content(), /Ticketing deadline unavailable/);
assert.equal(requests.length, 0);

reset();
assert.equal(find(tree, 'Switch').props.checked, false);
assert.doesNotMatch(content(), /Issue before/);
render({ deadline: freshTime });
assert.equal(requests.length, 0, 'Mounting and prop updates must not fetch');
toggle(true);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, '/api/flights/booking/refresh-ticketing-time');
assert.equal(requests[0].options.method, 'POST');
assert.deepEqual(JSON.parse(requests[0].options.body), { bookingReference: 'KTTABC123ABC123' });
assert.match(content(), /Checking ticketing time/);
assert.deepEqual(busy, [true]);
await settle(success(true, savedTime));
assert.match(content(), /2 Oct 2030, 14:15/);
assert.equal(refreshes, 1);
assert.deepEqual(busy, [true, false]);
assert.equal(timers.size, 0);
render({ deadline: savedTime });
assert.equal(find(tree, 'Switch').props.checked, true);
assert.equal(requests.length, 1, 'Server re-render must not start another read');
toggle(false);
assert.doesNotMatch(content(), /Issue before/);
assert.equal(requests.length, 1, 'Hiding must not read or clear data');
toggle(true);
await settle(success(false));
assert.match(content(), /2 Oct 2030, 14:15/);
assert.match(content(), /did not return a new ticketing time/);
assert.equal(refreshes, 1, 'No page refresh when supplier returned no new time');

reset();
toggle(true); toggle(false); toggle(true);
assert.equal(requests.length, 1, 'Fast repeated clicks must share the pending read');
toggle(false);
await settle(success(true, freshTime));
assert.equal(find(tree, 'Switch').props.checked, false, 'Completion must not reopen a hidden time');
assert.doesNotMatch(content(), /Issue before/);

reset();
toggle(true);
await settle({ success: false, error: { errorMessage: 'Please wait before refreshing again.' } }, 429);
assert.match(content(), /Please wait.*Turn off and on to retry/);
assert.match(content(), /2 Oct 2030, 14:15/);
assert.equal(requests.length, 1);
assert.equal(refreshes, 0);
assert.equal(busy.at(-1), false);

reset({ disabled: true });
assert.equal(find(tree, 'Switch').props.disabled, true);
toggle(true);
assert.equal(requests.length, 0, 'Supplier actions in progress must prevent a refresh');

reset({ deadline: null });
toggle(true);
await settle(success(false));
assert.match(content(), /Ticketing time unavailable/);
assert.doesNotMatch(content(), /Invalid Date/);

reset();
toggle(true);
[...timers.values()][0]();
await new Promise(resolve => setImmediate(resolve));
render();
assert.match(content(), /refresh timed out.*Turn off and on to retry/);
assert.equal(busy.at(-1), false);
assert.equal(timers.size, 0);

reset();
toggle(true);
hooks.forEach(hook => hook?.cleanup?.());
await new Promise(resolve => setImmediate(resolve));
assert.equal(requests[0].options.signal.aborted, true);
assert.equal(refreshes, 0, 'Unmounted components must not refresh the router');
assert.equal(busy.at(-1), false);
assert.equal(timers.size, 0);
assert.doesNotMatch(source, /setInterval/, 'The switch must never poll');
assert.doesNotMatch(fs.readFileSync('components/flights/BookingActions.tsx', 'utf8'), /\/refresh-ticketing-time/,
  'Only the time-limit switch should own this supplier read');
console.log('Deadline switch: user-only reads, hide/reveal, saved-time preservation, busy guards, timeout and cleanup passed.');
