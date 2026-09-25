import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('lib/shapontravels/pricing.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports });
const { shapontravelsPricedOffer } = module.exports;

const breakdown = {
  currency: 'BDT',
  gross: '5349.00',
  payable: '5084.36',
  taxes: '1021.00',
  ait: '15.00',
  passengers: {
    adt: { count: 1, payable: '5084.36', taxes: '1021.00', ait: '15.00' },
  },
};
const priced = shapontravelsPricedOffer(breakdown, { kind: 'b2c' });
assert.ok(priced);
assert.equal(priced.totalPrice, 5084.36, 'the public total must be final payable, never gross');
assert.equal(priced.basePrice, 4048.36);
assert.equal(priced.fares[0].totalPrice, 5084.36);
assert.equal(priced.snapshot.sellingPrice, 5084.36);
assert.equal(priced.snapshot.grossPrice, 5349);
assert.equal(priced.snapshot.markupAmount, 0, 'a second Kaligonj markup must not apply');
assert.equal(shapontravelsPricedOffer({ ...breakdown, currency: 'USD' }, { kind: 'b2c' }), null);
assert.equal(shapontravelsPricedOffer({ ...breakdown, payable: '5084.37' }, { kind: 'b2c' }), null);
assert.equal(shapontravelsPricedOffer({ ...breakdown, payable: 'unknown' }, { kind: 'b2c' }), null);
assert.equal(shapontravelsPricedOffer({ ...breakdown, taxes: '5080.00' }, { kind: 'b2c' }), null);
console.log('Shapontravels payable mapping verification passed');
