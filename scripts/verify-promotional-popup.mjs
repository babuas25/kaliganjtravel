import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync('lib/promotional-popup.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const { promotionDue, promotionSchema, promotionDisplaySchema, PROMOTION_INTERVAL } = module.exports;
const now = 10_000_000;
assert.equal(promotionDue(null, 100, now), true);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 100, now + PROMOTION_INTERVAL - 1), false);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 100, now + PROMOTION_INTERVAL), true);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 101, now + 1), true);
assert.equal(promotionDue({ shownAt: now, signedInAt: null }, null, now + 1), false);
assert.equal(promotionSchema.safeParse({ enabled: true, slides: [] }).success, false);
const slide = { id: '9e95c6d8-38e0-435a-bc3c-106240d7f458', title: 'Offer', imageUrl: 'https://res.cloudinary.com/demo/image/upload/offer.webp', link: '/dashboard/flight-search', active: true };
assert.equal(promotionSchema.safeParse({ enabled: true, slides: [slide] }).success, true);
for (const link of ['javascript:alert(1)', '//external.test', '/\\external.test', 'http://external.test']) {
  assert.equal(promotionSchema.safeParse({ enabled: true, slides: [{ ...slide, link }] }).success, false);
}
assert.equal(promotionSchema.safeParse({ enabled: false, slides: Array(7).fill(slide) }).success, false);
for (const autoCloseSeconds of [10, 15, 20, 25, 30]) {
  assert.equal(promotionSchema.safeParse({ enabled: false, slides: [], autoCloseSeconds }).success, true);
}
for (const autoCloseSeconds of [0, 5, 11, 31, -10]) {
  assert.equal(promotionSchema.safeParse({ enabled: false, slides: [], autoCloseSeconds }).success, false);
}
assert.equal(promotionSchema.parse({ enabled: false, slides: [] }).autoCloseSeconds, 10);
const post = { ...slide, details: 'Offer details\n\nEligible travel dates.', terms: 'Subject to availability.' };
const parsedPost = promotionSchema.parse({ enabled: false, slides: [post] }).slides[0];
assert.equal(parsedPost.details, post.details);
assert.equal(parsedPost.terms, post.terms);
assert.equal(promotionSchema.safeParse({ enabled: false, slides: [{ ...slide, details: 'x'.repeat(12001) }] }).success, false);
assert.equal(promotionSchema.safeParse({ enabled: false, slides: [{ ...slide, terms: 'x'.repeat(6001) }] }).success, false);
assert.equal(promotionDisplaySchema.parse({}).frequencyScope, 'tab');
assert.equal(promotionDisplaySchema.safeParse({ frequencyScope: 'browser' }).success, true);
assert.equal(promotionDisplaySchema.safeParse({ frequencyScope: 'unknown' }).success, false);
const once = promotionDisplaySchema.parse({ repeatMinutes: 0 });
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 100, now + 8 * 86400000, once), false);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 101, now + 1, once), true);
const repeat = promotionDisplaySchema.parse({ showOnLogin: false, repeatMinutes: 15, delaySeconds: 30, pages: ['/dashboard/announcements'] });
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 101, now + 1, repeat), false);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 100, now + 900000, repeat), true);
assert.equal(promotionDue({ shownAt: now, signedInAt: 100 }, 100, now + 899999, repeat), false);
assert.equal(promotionDisplaySchema.safeParse({ pages: [] }).success, false);
assert.equal(promotionDisplaySchema.safeParse({ pages: ['/flights/checkout'] }).success, false);
assert.equal(promotionDisplaySchema.safeParse({ repeatMinutes: 0, showOnLogin: false }).success, false);
assert.equal(promotionDisplaySchema.safeParse({ delaySeconds: 301 }).success, false);
assert.equal(promotionDisplaySchema.safeParse({ delaySeconds: 0.5 }).success, false);
assert.equal(promotionDisplaySchema.safeParse({ repeatMinutes: 1 }).success, false);
const db = new PGlite();
try {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(fs.readFileSync('supabase/migrations/0157_promotional_popup.sql', 'utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/0158_promotional_popup_auto_close.sql', 'utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/0159_promotional_popup_display_settings.sql', 'utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/0160_promotional_popup_tab_sessions.sql', 'utf8'));
  assert.equal((await db.query('select display_settings from promotional_popup_settings')).rows[0].display_settings.frequencyScope, 'tab');
  assert.equal((await db.query('select auto_close_seconds from promotional_popup_settings')).rows[0].auto_close_seconds, 10);
  await assert.rejects(() => db.exec('update promotional_popup_settings set auto_close_seconds = 11'), /check constraint/);
  const { rows } = await db.query('select enabled, version, slides from promotional_popup_settings');
  assert.deepEqual(rows, [{ enabled: false, version: 2, slides: [] }]);
  await db.query('update promotional_popup_settings set slides = $1::jsonb', [JSON.stringify([parsedPost])]);
  const saved = (await db.query('select slides from promotional_popup_settings')).rows[0].slides[0];
  assert.equal(saved.details, post.details);
  assert.equal(saved.terms, post.terms);
  await db.query('update promotional_popup_settings set display_settings = $1::jsonb', [JSON.stringify(repeat)]);
  assert.deepEqual((await db.query('select display_settings from promotional_popup_settings')).rows[0].display_settings, repeat);
  await assert.rejects(() => db.query('update promotional_popup_settings set display_settings = $1::jsonb', [JSON.stringify({ ...repeat, pages: ['/flights/checkout'] })]), /check constraint/);
  await assert.rejects(() => db.query('update promotional_popup_settings set display_settings = $1::jsonb', [JSON.stringify({ ...repeat, repeatMinutes: 0 })]), /check constraint/);
  await assert.rejects(() => db.query('update promotional_popup_settings set display_settings = $1::jsonb', [JSON.stringify({ ...repeat, frequencyScope: 'invalid' })]), /check constraint/);
  await assert.rejects(() => db.exec("set role authenticated; select * from promotional_popup_settings;"), /permission denied/);
} finally { await db.close(); }
console.log('Promotional popup timing, input safety, and database access checks passed.');
