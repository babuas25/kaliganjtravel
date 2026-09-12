import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

// Read current owner-configured rules; synthetic prices stay in memory.
nextEnv.loadEnvConfig(process.cwd());
assert.equal(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, 'ljzoizsogbirlvlsrwzi.supabase.co');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await db.from('markup_rules').select('*').eq('active', true);
if (error) throw new Error(`Markup lookup failed: ${error.code}`);
const rules = data.map(r => ({ id:r.id, audience:r.audience, agencyCode:r.agency_code,
  airlineCode:r.airline_code, origin:r.origin, destination:r.destination,
  bidirectional:r.bidirectional, markupType:r.markup_type, value:Number(r.value),
  lccServiceMargin:r.lcc_service_margin, active:r.active, createdAt:r.created_at, updatedAt:r.updated_at }));
assert.equal(rules.length, 2, 'Revisit these setup expectations if owner changes rules');
for (const [audience, value] of [['b2b',1],['b2c',4]]) {
  const rule = rules.find(r => r.audience === audience);
  assert.ok(rule);
  assert.equal(rule.value,value);
  assert.equal(rule.markupType,'percentage');
  for (const field of ['agencyCode','airlineCode','origin','destination']) assert.equal(rule[field],null);
  assert.equal(rule.lccServiceMargin,false);
}
const module = { exports: {} };
const output = ts.transpileModule(fs.readFileSync('lib/markup.ts','utf8'), {
  compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 }
}).outputText;
Function('require','module','exports',output)(name => {
  if (name === '@/lib/agency') return {isAgencyCode: value => typeof value === 'string' && value.length > 0};
  throw Error(`Unexpected dependency: ${name}`);
},module,module.exports);
const {selectMarkupRules,priceOffer} = module.exports;
const cases = [
  ['B2C', {kind:'b2c'},12000,10400],
  ['B2B', {kind:'agency',agencyCode:'ST-B2B999999'},12000,10100],
  ['Super Admin', {kind:'superadmin'},12000,10000],
  ['B2C gross cap', {kind:'b2c'},10200,10200],
  ['B2B gross cap', {kind:'agency',agencyCode:'ST-B2B999999'},10050,10050],
];
for (const [name,audience,gross,expected] of cases) {
  const selection=selectMarkupRules(rules,audience,'BS',[{origin:'DAC',destination:'CXB',departureDate:'2026-10-01'}]);
  const price=priceOffer({audience,rulesAvailable:true,rules:selection,supplierTotalPrice:10000,
    basePrice:gross-1000,taxes:1000,ait:0,passengerCount:1,
    fares:[{passengerType:'ADT',count:1,basePrice:gross-1000,taxes:1000,ait:0,serviceCharge:0,supplierTotalPrice:10000}]});
  assert.equal(price.totalPrice,expected,`${name} payable`);
  console.log(`${name}: PASS (BDT ${expected})`);
}
console.log('Owner markup verified; no database writes or supplier transactions.');
