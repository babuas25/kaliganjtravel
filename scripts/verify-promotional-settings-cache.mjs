import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

function promotion(enabled = true, title = 'Offer') {
  return {
    enabled,
    display: {
      audience: 'b2b', frequencyScope: 'tab',
      pages: ['/dashboard', '/dashboard/flight-search'],
      showOnLogin: true, delaySeconds: 0, repeatMinutes: 60,
    },
    autoCloseSeconds: 10,
    slides: enabled ? [{
      id: 'b7b8182a-8c72-45fc-b063-ab8a01384636', title,
      imageUrl: 'https://res.cloudinary.com/test/image/upload/offer.png',
      link: '', active: true,
    }] : [],
  };
}

function loadSource(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL,
    require: (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      assert.equal(name, 'zod', `Unexpected import ${name}`);
      return require(name);
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

function cacheHarness() {
  let now = 1_000;
  let wallClockOffset = 0;
  let respond = async () => Response.json(promotion());
  const requests = [];
  let timeoutId = 0;
  const timeouts = new Map();
  class Clock extends Date {
    static now() { return now + wallClockOffset; }
  }
  const schema = loadSource('lib/promotional-popup.ts', {});
  const cache = loadSource('lib/promotional-settings.client.ts', {
    '@/lib/promotional-popup': schema,
  }, {
    Date: Clock, AbortController,
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++timeoutId;
      timeouts.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    fetch: (url, options) => {
      requests.push({ url, options });
      return respond(options);
    },
  });
  return {
    cache, schema, Clock, requests,
    advance: (duration) => {
      now += duration;
      for (const [id, timeout] of timeouts) {
        if (timeout.dueAt > now) continue;
        timeouts.delete(id);
        timeout.callback();
      }
    },
    shiftWallClock: (duration) => { wallClockOffset += duration; },
    respondWith: (next) => { respond = next; },
  };
}

// Concurrent route effects share the same request, and focus or navigation
// within the TTL reuses validated settings instead of calling the endpoint.
{
  const h = cacheHarness();
  let finish;
  h.respondWith(() => new Promise((resolve) => { finish = resolve; }));
  const first = h.cache.loadPromotionalSettings('user-a', 10);
  const overlapping = h.cache.loadPromotionalSettings('user-a', 10);
  assert.equal(first, overlapping);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/promotional-popup');
  assert.equal(h.requests[0].options.cache, 'no-store');
  finish(Response.json(promotion()));
  await first;
  h.respondWith(async () => Response.json(promotion(true, 'Updated')));
  h.advance(FIVE_MINUTES - 1);
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).slides[0].title, 'Offer');
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).slides[0].title, 'Updated');
  assert.equal(h.requests.length, 2, 'settings must refresh at the TTL boundary');
  h.shiftWallClock(-60 * 60 * 1000);
  h.advance(FIVE_MINUTES);
  await h.cache.loadPromotionalSettings('user-a', 10);
  assert.equal(h.requests.length, 3, 'wall-clock changes must not extend the settings TTL');
}

{
  const h = cacheHarness();
  await h.cache.loadPromotionalSettings('user-a', 10);
  h.shiftWallClock(FIVE_MINUTES);
  await h.cache.loadPromotionalSettings('user-a', 10);
  assert.equal(h.requests.length, 2, 'waking after expiry must refresh even if monotonic time paused');
}

// Disabled promotions remain discoverable when re-enabled, with a longer TTL.
{
  const h = cacheHarness();
  h.respondWith(async () => Response.json(promotion(false)));
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).enabled, false);
  h.respondWith(async () => Response.json(promotion(true)));
  h.advance(TEN_MINUTES - 1);
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).enabled, false);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).enabled, true);
  assert.equal(h.requests.length, 2);
}

{
  const h = cacheHarness();
  h.respondWith(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('settings timeout')), { once: true });
  }));
  const pending = h.cache.loadPromotionalSettings('user-a', 10);
  const rejected = assert.rejects(pending, /settings timeout/);
  h.advance(10_000);
  await rejected;
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.respondWith(async () => Response.json(promotion()));
  await h.cache.loadPromotionalSettings('user-a', 10);
  assert.equal(h.requests.length, 2, 'a timeout must release the shared request for recovery');
}

// A changed account or sign-in never reuses the old audience snapshot. Late
// responses from an old session cannot replace the current session's cache.
{
  const h = cacheHarness();
  let finishOldSession;
  h.respondWith(() => new Promise((resolve) => { finishOldSession = resolve; }));
  const oldSession = h.cache.loadPromotionalSettings('user-a', 10);
  h.respondWith(async () => Response.json(promotion(true, 'User B')));
  assert.equal((await h.cache.loadPromotionalSettings('user-b', 10)).slides[0].title, 'User B');
  finishOldSession(Response.json(promotion(true, 'Old user A')));
  await oldSession;
  assert.equal((await h.cache.loadPromotionalSettings('user-b', 10)).slides[0].title, 'User B');
  assert.equal(h.requests.length, 2);
  h.respondWith(async () => Response.json(promotion(true, 'New sign-in')));
  assert.equal((await h.cache.loadPromotionalSettings('user-b', 20)).slides[0].title, 'New sign-in');
  await h.cache.loadPromotionalSettings('user-b', null);
  await h.cache.loadPromotionalSettings('user-b', 20);
  assert.equal(h.requests.length, 5, 'switching away must discard the previous session cache');
}

// Failed or invalid responses never become a successful cached settings entry,
// and a rejected in-flight request does not prevent subsequent recovery.
for (const response of [
  () => Response.json({ enabled: true, slides: [] }),
  () => new Response(null, { status: 401 }),
]) {
  const h = cacheHarness();
  h.respondWith(async () => response());
  assert.equal(await h.cache.loadPromotionalSettings('user-a', 10), null);
  h.respondWith(async () => Response.json(promotion()));
  assert.equal((await h.cache.loadPromotionalSettings('user-a', 10)).enabled, true);
  assert.equal(h.requests.length, 2);
}
{
  const h = cacheHarness();
  h.respondWith(async () => { throw new Error('offline'); });
  await assert.rejects(h.cache.loadPromotionalSettings('user-a', 10), /offline/);
  h.respondWith(async () => Response.json(promotion()));
  await h.cache.loadPromotionalSettings('user-a', 10);
  assert.equal(h.requests.length, 2);
}

function popupHarness() {
  const h = cacheHarness();
  let pathname = '/dashboard';
  let userId = 'user-a';
  let signedInAt = 10;
  let hookIndex = 0;
  let timerId = 0;
  const hooks = [];
  const scheduledEffects = [];
  const timers = new Map();
  const events = { document: new Map(), window: new Map() };
  const storageValues = new Map();
  let tabInitializations = 0;
  const document = {
    visibilityState: 'visible', querySelector: () => null,
    addEventListener: (name, callback) => events.document.set(name, callback),
    removeEventListener: (name, callback) => {
      if (events.document.get(name) === callback) events.document.delete(name);
    },
  };
  const window = {
    setInterval: (callback, interval) => {
      const id = ++timerId;
      timers.set(id, { callback, interval });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    addEventListener: (name, callback) => events.window.set(name, callback),
    removeEventListener: (name, callback) => {
      if (events.window.get(name) === callback) events.window.delete(name);
    },
  };
  const storage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
  };
  const popup = loadSource('components/dashboard/PromotionalPopup.tsx', {
    react: {
      useState: (initial) => {
        const index = hookIndex++;
        if (!hooks[index]) hooks[index] = { value: initial };
        return [hooks[index].value, (value) => { hooks[index].value = value; }];
      },
      useRef: (initial) => {
        const index = hookIndex++;
        if (!hooks[index]) hooks[index] = { current: initial };
        return hooks[index];
      },
      useEffect: (setup, dependencies) => {
        const index = hookIndex++;
        const previous = hooks[index];
        if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
        scheduledEffects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { dependencies, cleanup: setup() };
        });
      },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'next/navigation': { usePathname: () => pathname },
    'lucide-react': { ChevronLeft: 'left', ChevronRight: 'right' },
    '@/components/ui/dialog': { Dialog: 'dialog', DialogContent: 'content', DialogDescription: 'description', DialogTitle: 'title' },
    '@/lib/promotional-popup': h.schema,
    '@/lib/promotional-settings.client': h.cache,
    '@/lib/promotional-tab-session.client': { initializePromotionalTabSession: async () => { tabInitializations++; } },
  }, { Date: h.Clock, window, document, sessionStorage: storage, localStorage: storage });
  const render = () => {
    hookIndex = 0;
    const output = popup.default({ userId, signedInAt });
    while (scheduledEffects.length) scheduledEffects.shift()();
    return output;
  };
  return {
    ...h, render, document, storageValues,
    navigate: (nextPath) => { pathname = nextPath; return render(); },
    signIn: (nextUserId, nextSignedInAt) => { userId = nextUserId; signedInAt = nextSignedInAt; return render(); },
    focus: () => events.window.get('focus')?.(),
    visibility: (state) => { document.visibilityState = state; events.document.get('visibilitychange')?.(); },
    tickRefresh: () => { for (const { callback, interval } of timers.values()) if (interval === 60_000) callback(); },
    tabInitializations: () => tabInitializations,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Exercise the component's real visibility/event/effect wiring. Route changes
// keep the request alive for the next route without letting the disposed effect
// open a dialog. Cached settings never bypass the existing per-tab login rule.
{
  const h = popupHarness();
  let finish;
  h.respondWith(() => new Promise((resolve) => { finish = resolve; }));
  h.document.visibilityState = 'hidden';
  h.render();
  h.focus();
  h.tickRefresh();
  assert.equal(h.requests.length, 0, 'a hidden tab must not fetch settings');
  h.visibility('visible');
  h.navigate('/dashboard/flight-search');
  assert.equal(h.requests.length, 1, 'navigation must share the pending request');
  finish(Response.json(promotion()));
  await settle();
  assert.equal(h.tabInitializations(), 1, 'the disposed route must not initialize or display a popup');
  assert.equal(h.render().props.open, true);
  const firstShown = h.storageValues.get('promotion:tab-last-shown:user-a');
  assert.equal(JSON.parse(firstShown).signedInAt, 10);
  h.navigate('/dashboard/bookings');
  assert.equal(h.render().props.open, false);
  h.navigate('/dashboard');
  await settle();
  assert.equal(h.render().props.open, false, 'navigation must preserve per-tab repeat frequency');
  h.focus();
  h.visibility('hidden');
  h.visibility('visible');
  h.tickRefresh();
  await settle();
  assert.equal(h.requests.length, 1, 'fresh focus, visibility and timer events must reuse settings');
  h.respondWith(async () => Response.json(promotion()));
  h.signIn('user-a', 20);
  await settle();
  assert.equal(h.requests.length, 2, 'a new sign-in must get its own settings');
  assert.equal(h.render().props.open, true, 'show-on-login behavior must survive settings caching');
  assert.equal(JSON.parse(h.storageValues.get('promotion:tab-last-shown:user-a')).signedInAt, 20);
}

{
  const h = popupHarness();
  h.respondWith(async () => Response.json(promotion(false)));
  h.render();
  await settle();
  assert.equal(h.render().props.open, false);
  h.respondWith(async () => Response.json(promotion()));
  h.advance(TEN_MINUTES);
  h.visibility('hidden');
  h.tickRefresh();
  assert.equal(h.requests.length, 1, 'expiry must not fetch while hidden');
  h.visibility('visible');
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.render().props.open, true, 're-enabled settings must display when the tab returns');
}

console.log('Promotional settings cache checks passed (TTL, deduplication, session isolation, visibility, login and re-enable behavior).');
