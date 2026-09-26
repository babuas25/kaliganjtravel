import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { currencyModule } from './helpers/currency.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, mocks = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { error() {} }, Date, Buffer,
    Error, require: id => id in mocks ? mocks[id] : id === 'server-only' ? {} : id.startsWith('@/') ? {} : require(id),
  }, { filename: file });
  return module.exports;
}
const errors = load('lib/db/booking-read-error.ts');
const messages = load('lib/flights/booking-failure-message.ts');
const supplierMessage = 'Unable to Satisfy, Need Confirmed Flight Status.';
assert.match(messages.unverifiedBookingMessage(supplierMessage), /supplier could not confirm the selected flight/);
assert.doesNotMatch(messages.unverifiedBookingMessage('Passenger PRIVATE / private-token'), /PRIVATE|private-token/);
assert.doesNotMatch(messages.unverifiedBookingMessage(), /Booking status:|airline has not confirmed/);
let storage, result, rejectQuery = false;
const filters = [];
const client = { from() {
  const q = { select() { return q; }, limit() { return q; }, eq(k,v) { filters.push([k,v]); return q; },
    maybeSingle: async () => { if (rejectQuery) throw new Error('network'); return result; } };
  return q;
} };
const dbMocks = {
  '@/lib/db/booking-read-error': errors,
  '@/lib/supabase/server': { supabaseAdmin: () => storage },
  '@/lib/db/booking-visibility': { bookingUserVisibilitySchemaAvailable: async () => true },
};
const attempts = load('lib/db/booking-attempts.ts', dbMocks);
const bookings = load('lib/db/flight-bookings.ts', dbMocks);
const readers = [
  () => attempts.readBookingAttempt('id', 'private-capability'),
  () => bookings.readBookingByAttemptId('id', {kind:'user',clerkId:'owner'}, true),
  () => bookings.readBookingByPublicRef('KTTTEST', {kind:'agency',agencyCode:'agency'}, true),
  () => bookings.readBookingByPublicRefForSuperAdmin('KTTTEST', true),
];
for (const read of readers) {
  storage = null; await assert.rejects(read, errors.BookingReadUnavailableError);
  storage = client; result = {data:null,error:{message:'database unavailable'}};
  await assert.rejects(read, errors.BookingReadUnavailableError);
  result = {data:null,error:null}; assert.equal(await read(), null);
  rejectQuery = true; await assert.rejects(read); rejectQuery = false;
}
assert.ok(filters.some(([k,v])=>k==='user_id'&&v==='owner'));
assert.ok(filters.some(([k,v])=>k==='agency_code'&&v==='agency'));
assert.ok(filters.some(([k,v])=>k==='hidden_from_user'&&v===false));
assert.ok(filters.some(([k,v])=>k==='access_token_hash'&&v!== 'private-capability'));
result = {data:{id:'found'},error:null};
assert.equal((await attempts.readBookingAttempt('id','private-capability')).id,'found');
result = {data:null,error:{message:'alias storage failed'}};
await assert.rejects(()=>bookings.readBookingByPublicRef('STR123456789012',{kind:'all'},true),errors.BookingReadUnavailableError);

let mode = 'storage', supplierCalls = 0, allowSupplierFailure = false, claims = 0;
const effects = [];
class TriploverError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
class SupplierWriteBoundaryError extends Error {}
const classifier = load('lib/booking-lifecycle/supplier-uncertainty.ts', {
  '@/lib/triplover/client': { TriploverError },
  '@/lib/shapontravels/client': { ShapontravelsWriteError: class extends Error {} },
  '@/lib/booking-lifecycle/supplier-write-hooks': { SupplierWriteBoundaryError },
});
const fixture = () => ({id:'00000000-0000-4000-8000-000000000001',user_id:'owner',state:mode,
  supplier_message:supplierMessage,supplier_account:'triplover',expires_at:new Date(Date.now()+300000).toISOString(),
  unique_trans_id:'saved-transaction',item_code_ref:'saved-item',price_code_ref:'saved-price',
  offer_snapshot:{currency:'BDT',directTicketing:false,passportRequired:false,travelDate:'2030-01-01',passengerCounts:{ADT:1}}});
const session = {clerkId:'owner',role:'agency'};
const mocks = {
  '@/lib/currency':currencyModule,
  '@/lib/flights/booking-failure-message':messages,
  '@/lib/flights/booking':{isValidTitleForPassenger:()=>true},
  '@/lib/booking-lifecycle/operation-request':{createOperationRequestIdentity:input=>input},
  '@/lib/booking-lifecycle/supplier-uncertainty':classifier,
  '@/lib/booking-lifecycle/supplier-write-hooks':{bookingAttemptSupplierWriteHooks:()=>({boundarySnapshot:()=>({
    supplierCallStarted:true,supplierResponseObserved:true,supplierResponseRecorded:true,httpStatus:200,
  })})},
  '@/lib/triplover/config':{isTriploverSupplier:value=>value==='triplover'},
  '@/lib/db/booking-operations':{recordSupplierWriteUncertainty:async input=>{
    assert.equal(input.classification.reasonCode,'supplier_http_200_failure');
    effects.push('reconciliation'); mode='unknown'; return {ok:true};
  }},
  'next/server': { NextResponse: {json: (body,init)=>new Response(JSON.stringify(body),init)} },
  '@/lib/db/booking-read-error': errors,
  '@/lib/dashboard/session': {getDashboardSession:async()=>session},
  '@/lib/db/supplier-controls':{getSupplierOperationalControls:async()=>({bookingEnabled:true})},
  '@/lib/rate-limit':{checkActionLimit:async()=>({ok:true})},
  '@/lib/http/actor-key':{requestActorKey:()=> 'actor'},
  '@/lib/dashboard/bookings':{bookingScopeFor:()=>({kind:'user',clerkId:'owner'})},
  '@/lib/db/booking-attempts': {readBookingAttempt:async()=>{
    if(mode==='storage') throw new errors.BookingReadUnavailableError();
    if(mode==='missing') return null;
    return fixture();
  },claimBookingAttempt:async()=>{claims++;return {ok:true,row:fixture()};}},
  '@/lib/db/flight-bookings':{readBookingByAttemptId:async(_id,_scope,strict)=>{assert.equal(strict,true);throw new errors.BookingReadUnavailableError();}},
  '@/lib/triplover/book':{bookFlight:async()=>{
    supplierCalls++;
    assert.equal(allowSupplierFailure,true,'Must not submit from recovery reads');
    throw new TriploverError('supplier',supplierMessage,200);
  }},
};
const payload = { bookingId:'00000000-0000-4000-8000-000000000001',accessToken:'x'.repeat(32),
  travellers:[{passengerType:'ADT',title:'Mr',firstName:'Test',lastName:'Passenger',gender:'Male',dateOfBirth:'2000-01-01',nationality:'BD'}],
  contact:{phone:'01700000000',phoneCountryCode:'+880',customerEmail:'test@example.test'} };
const request=()=>new Request('http://localhost/api/flights/booking',{method:'POST',body:JSON.stringify(payload)});
for(const file of ['route.ts','draft/route.ts','status/route.ts']) {
  const route=load('app/api/flights/booking/'+file,mocks);
  mode='storage';let response=await route.POST(request());
  assert.equal(response.status,503); assert.equal((await response.json()).error.errorCode,'BOOKING_STORAGE_UNAVAILABLE');
  mode='missing';response=await route.POST(request());assert.equal(response.status,404);
}
const status=load('app/api/flights/booking/status/route.ts',mocks);
mode='succeeded';assert.equal((await status.POST(request())).status,503);
mode='unknown';const recovered=await (await status.POST(request())).json();
assert.equal(recovered.error.errorCode,'BOOKING_OUTCOME_UNKNOWN');
assert.equal(recovered.error.errorMessage,messages.unverifiedBookingMessage(supplierMessage));
assert.equal(supplierCalls,0);
// Reproduce the actual HTTP-200 Book failure locally, without supplier calls.
allowSupplierFailure=true;mode='draft';
const submit=load('app/api/flights/booking/route.ts',mocks);
const failed=await submit.POST(request());
assert.equal(failed.status,503);
assert.deepEqual((await failed.json()).error,recovered.error);
assert.deepEqual(effects,['reconciliation']);
assert.equal(supplierCalls,1);assert.equal(claims,1);
assert.deepEqual((await (await status.POST(request())).json()).error,recovered.error);
assert.equal((await submit.POST(request())).status,409);
assert.equal(supplierCalls,1,'An uncertain Book must never be replayed');
const checkout=fs.readFileSync('components/flights/BookingCheckout.tsx','utf8');
assert.match(checkout,/submitting \|\| submissionLocked/);
assert.match(checkout,/retrySeconds > 0 \|\| submissionLocked/);
assert.match(checkout,/'BOOKING_OUTCOME_UNKNOWN'[\s\S]*setSubmissionLocked\(true\)/);
console.log('Booking read recovery: storage errors 503, scoped reads, flight-confirmation failure message, preserved reconciliation, supplier replay absent and uncertain checkout locked.');
