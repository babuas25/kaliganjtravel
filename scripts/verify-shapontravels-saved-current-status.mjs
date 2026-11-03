// Actual backend saved-v1 examples and malformed metadata; no HTTP or DB calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const file='lib/shapontravels/booking-status.ts';
const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};
new vm.Script(code,{filename:file}).runInNewContext({module,exports:module.exports,Date});
const {verifyShapontravelsBookingStatus:verify,parseShapontravelsCurrentStatus:parse}=module.exports;
const plain=value=>JSON.parse(JSON.stringify(value));
let baseline;
for(const name of ['on-hold','issued','cancelled']) {
  const original=JSON.parse(fs.readFileSync(new URL(`fixtures/shapontravels-saved-booking-v1/${name}.json`,import.meta.url),'utf8'));
  const body=structuredClone(original);
  body.currentStatus=body.savedBooking.currentStatus;
  const before=structuredClone(body);
  const receipt=body.item1;
  const expected={uniqueTransId:receipt.uniqueTransID,itemCodeRef:receipt.itemCodeRef,priceCodeRef:receipt.priceCodeRef,
    bookingCodeRef:receipt.bookingCodeRef,bookingRefNumber:receipt.bookingRefNumber,pnr:receipt.pnr,supplierPublicRef:body.savedBooking.reference};
  const read={httpStatus:200,supplierPublicRef:expected.supplierPublicRef,body};
  const result=verify(read,expected);
  assert.equal(result.result,'verified');assert.equal(result.currentStatusState,'available',name);
  assert.equal(result.currentStatus.status,body.currentStatus.status);
  assert.equal(result.currentStatus.reviewRequired,false);
  assert.equal(result.currentStatus.source,'public_receipt');assert.equal(result.currentStatus.verified,false);
  for(const key of ['bookingState','checkedAt','lastCheck','supplierStatus','supplierCheckedAt']) assert.equal(result.currentStatus[key],null);
  assert.deepEqual(plain(parse(result.currentStatus)),plain(result.currentStatus),'Normalized summaries retain the existing exact public DB contract');
  assert.deepEqual(body,before,'Original saved-v1 source and verification are never overwritten');
  if(name==='on-hold')baseline={read,expected};
}
const summary={status:'on-hold',reviewRequired:false,source:null,verified:null,supplierStatus:null,supplierCheckedAt:null};
const check=current=>verify({...baseline.read,body:{...baseline.read.body,currentStatus:current}},baseline.expected);
for(const values of [{source:null,verified:null},{source:null,verified:false},{source:null,verified:true},{source:'saved_import',verified:null},{source:'saved_booking',verified:false},{source:'ticket_operation',verified:true},{source:'cancellation_operation',verified:true}]) {
  const result=check({...summary,...values});
  assert.equal(result.currentStatusState,'available');assert.equal(result.currentStatus.source,'public_receipt');
  assert.equal(result.currentStatus.verified,false);assert.equal(result.currentStatus.checkedAt,null);
}
const time='2026-10-01T10:00:00+06:00';
for(const source of ['supplier_pnr','airline_refresh']) {
  const observation={...summary,source,verified:true,supplierStatus:'Booked',supplierCheckedAt:time};
  const result=check(observation);
  assert.equal(result.currentStatusState,'available');assert.equal(result.currentStatus.source,source);
  assert.equal(result.currentStatus.supplierCheckedAt,time);assert.equal(result.currentStatus.checkedAt,null);
  assert.equal(result.currentStatus.bookingState,null);assert.equal(result.currentStatus.verified,true);
  assert.deepEqual(plain(parse(result.currentStatus)),plain(result.currentStatus),'Dated observation offsets/provenance survive parsing');
}
for(const verified of [true,false]) {
  const observation={...summary,source:'supplier_sync',verified,supplierStatus:'Booked',supplierCheckedAt:time};
  const result=check(observation);
  assert.equal(result.currentStatusState,'available');
  assert.equal(result.currentStatus.source,'supplier_sync');
  assert.equal(result.currentStatus.verified,verified,'Saved sync verification is never promoted');
  assert.equal(result.currentStatus.supplierCheckedAt,time,'The original saved offset/time survives the GET');
  assert.equal(result.currentStatus.checkedAt,null,'The read time is not a new supplier observation');
  assert.deepEqual(plain(parse(result.currentStatus)),plain(result.currentStatus));
  assert.equal(parse({...result.currentStatus,checkedAt:'2030-01-01T00:00:00Z'}),null,
    'An invented GET timestamp cannot be attached to a saved sync observation');
  assert.equal(parse({...result.currentStatus,bookingState:'held'}),null);
}
const undatedSync=check({...summary,source:'supplier_sync',verified:false});
assert.equal(undatedSync.currentStatus.source,'supplier_sync');
assert.equal(undatedSync.currentStatus.verified,false);
assert.equal(undatedSync.currentStatus.supplierCheckedAt,null);
assert.equal(undatedSync.currentStatus.checkedAt,null);
const missing=key=>{const value={...summary};delete value[key];return value;};
const malformed=[
  ...Object.keys(summary).map(missing),
  {...summary,status:'Booked'}, {...summary,reviewRequired:null}, {...summary,reviewRequired:'false'},
  {...summary,verified:'false'}, {...summary,verified:0}, {...summary,source:'live'}, {...summary,source:0},
  {...summary,source:null,verified:true,supplierStatus:'Booked',supplierCheckedAt:time},
  {...summary,source:null,verified:false,supplierStatus:'Booked',supplierCheckedAt:time},
  {...summary,supplierStatus:'Booked'}, {...summary,supplierStatus:42}, {...summary,supplierStatus:'\n'},
  {...summary,supplierCheckedAt:'2026-10-01 10:00:00'}, {...summary,supplierCheckedAt:'2026-02-30T10:00:00Z'},
  {...summary,source:'supplier_pnr',verified:true}, {...summary,source:'airline_refresh',verified:true},
  {...summary,source:'supplier_pnr',verified:false,supplierStatus:'Booked',supplierCheckedAt:time},
  {...summary,source:'public_receipt',verified:true},
  {...summary,source:'public_receipt',supplierStatus:'Booked',supplierCheckedAt:time},
  {...summary,source:'supplier_sync',verified:true},
  {...summary,source:'supplier_sync',verified:null},
  {...summary,source:'supplier_sync',verified:false,supplierStatus:'Booked'},
];
for(const value of malformed)assert.equal(check(value).currentStatusState,'invalid',JSON.stringify(value));
for(const publicReceipt of [null,{},
  {...baseline.read.body.publicReceipt,status:'cancelled'},
  {...baseline.read.body.publicReceipt,pendingReview:null},
  {...baseline.read.body.publicReceipt,actions:{canIssue:'true'}},
])assert.equal(verify({...baseline.read,body:{...baseline.read.body,currentStatus:summary,publicReceipt}},baseline.expected).currentStatusState,'invalid');
for(const changes of [{pendingReview:true},{actions:{canIssue:false}}]) {
  const result=verify({...baseline.read,body:{...baseline.read.body,currentStatus:summary,publicReceipt:{...baseline.read.body.publicReceipt,...changes}}},baseline.expected);
  assert.equal(result.currentStatusState,'available');assert.equal(result.currentStatus.reviewRequired,true,'Receipt capabilities cannot be bypassed by a false summary review flag');
}
for(const changes of [{supplierPublicRef:'STRFOREIGN123'}, {body:{...baseline.read.body,item1:{...baseline.read.body.item1,pnr:'OTHER1'}}}]) {
  const result=verify({...baseline.read,...changes},baseline.expected);
  assert.equal(result.result,'mismatch');assert.equal(result.currentStatus,null);
}
console.log(`PASS actual three saved-v1 status examples, nullable summaries, preserved dated airline observations, ${malformed.length} invalid metadata cases and strict receipt/identity binding; no DB/network writes.`);
