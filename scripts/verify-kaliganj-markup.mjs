import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';
import { lccModule } from './helpers/lcc.mjs';

// Read current owner-configured rules; synthetic prices stay in memory.
// No rule-count/value assumptions: the owner may edit prices and scopes.
nextEnv.loadEnvConfig(process.cwd());
assert.equal(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, 'ljzoizsogbirlvlsrwzi.supabase.co');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const rows = [];
const pageSize = 500;
for (let offset = 0; ; offset += pageSize) {
  const { data, error } = await db.from('markup_rules')
    .select('id,audience,agency_code,airline_code,origin,destination,bidirectional,markup_type,value,lcc_service_margin,active,created_at,updated_at')
    .eq('active', true).order('id').range(offset, offset + pageSize - 1);
  if (error) throw new Error(`Markup lookup failed: ${error.code}`);
  rows.push(...data);
  if (data.length < pageSize) break;
}
const rules = rows.map(r => ({ id:r.id, audience:r.audience, agencyCode:r.agency_code,
  airlineCode:r.airline_code, origin:r.origin, destination:r.destination,
  bidirectional:r.bidirectional, markupType:r.markup_type, value:Number(r.value),
  lccServiceMargin:r.lcc_service_margin, active:r.active, createdAt:r.created_at, updatedAt:r.updated_at }));
const module = { exports: {} };
const output = ts.transpileModule(fs.readFileSync('lib/markup.ts','utf8'), {
  compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 }
}).outputText;
Function('require','module','exports',output)(name => {
  if (name === '@/lib/airlines/lcc') return lccModule;
  if (name === '@/lib/agency') return {isAgencyCode: value => typeof value === 'string' && value.length > 0};
  throw Error(`Unexpected dependency: ${name}`);
},module,module.exports);
const { selectMarkupRules, priceOffer, ruleUsesLccServiceMargin } = module.exports;
const supplier = 12856.85;
const base = 10000;
const taxes = 2800;
const ait = 56.85;
const toMinor = (value) => Math.round(value * 100);
const cases = [
  ['B2C IndiGo DAC-CCU', { kind: 'b2c' }, '6E'],
  ['B2B IndiGo DAC-CCU', { kind: 'agency', agencyCode: 'ST-B2B999999' }, '6E'],
  ['B2C full-service DAC-CCU', { kind: 'b2c' }, 'BG'],
  ['B2B full-service DAC-CCU', { kind: 'agency', agencyCode: 'ST-B2B999999' }, 'BG'],
  ['Super Admin IndiGo DAC-CCU', { kind: 'superadmin' }, '6E'],
];
for (const [name, audience, airlineCode] of cases) {
  const selection = selectMarkupRules(rules, audience, airlineCode, [{ origin: 'DAC', destination: 'CCU', departureDate: '2026-10-21' }]);
  const selected = selection.rule;
  const lcc = selected !== null && ruleUsesLccServiceMargin(selected, airlineCode);
  const requestedMinor = !selected ? 0 : selected.markupType === 'fixed'
    ? toMinor(selected.value)
    : selected.markupType === 'margin_share' ? 0
      : Math.round(toMinor(lcc ? base : supplier) * Math.round(selected.value * 100) / 10000);
  const serviceMinor = lcc ? requestedMinor : 0;
  const expectedMinor = lcc ? toMinor(supplier) + requestedMinor
    : Math.max(toMinor(taxes) + toMinor(ait), Math.min(toMinor(supplier) + requestedMinor, toMinor(supplier)));
  const price = priceOffer({ audience, rulesAvailable: true, rules: selection, supplierTotalPrice: supplier,
    basePrice: base, taxes, ait, passengerCount: 1,
    fares: [{ passengerType: 'ADT', count: 1, basePrice: base, taxes, ait, serviceCharge: 0, supplierTotalPrice: supplier }] });
  assert.equal(toMinor(price.totalPrice), expectedMinor, `${name} configured payable`);
  assert.equal(toMinor(price.serviceMargin), serviceMinor, `${name} service margin`);
  assert.equal(price.snapshot.ruleId, selected?.id ?? null);
  assert.equal(price.snapshot.sellingPrice, price.totalPrice);
  assert.equal(toMinor(price.basePrice) + toMinor(price.taxes) + toMinor(price.ait) + toMinor(price.serviceMargin), expectedMinor);
  assert.equal(price.fares.reduce((sum, fare) => sum + toMinor(fare.totalPrice), 0), expectedMinor);
  if (airlineCode === '6E' && selected?.value > 0 && selected.markupType !== 'margin_share') {
    assert.equal(price.snapshot.lccServiceMargin, true, 'configured LCC markup is enabled');
    assert.equal(price.snapshot.grossCapApplied, false);
  }
  if (airlineCode === 'BG' && !selected?.lccServiceMargin) {
    assert.ok(price.totalPrice <= supplier, 'full-service rules retain the gross ceiling');
  }
  console.log(`${name}: PASS (BDT ${price.totalPrice.toFixed(2)}; ${selected ? `${selected.markupType} ${selected.value}` : 'no markup rule'})`);
}
console.log(`Owner markup verified from ${rules.length} current active rules; no database writes or supplier transactions.`);
