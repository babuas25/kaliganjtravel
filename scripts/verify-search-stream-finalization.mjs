import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { currencyModule } from './helpers/currency.mjs';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=fs.readFileSync('app/api/flights/search/route.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const input={tripType:'oneway',routes:[{origin:'DAC',destination:'CXB',departureDate:'2026-10-01'}],adults:1,children:0,infants:0,childrenAges:[],cabinClass:1,preferredCarriers:[]};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function harness({fail=false,deferPrechecks=false,deferHistory=false,rateAllowed=true,session=null,sessionFailure=false,deferSession=false}={}) {
 const search=deferred(),finish=deferred(),begin=deferred(),rate=deferred(),history=deferred(),authorization=deferred();
 const afterTasks=[],events=[],calls=[],registrations=[],audiences=[];
 class TriploverError extends Error {}
 const modules={
  '@/lib/currency':currencyModule,
  'next/server':{NextResponse:Response,after:callback=>afterTasks.push(callback)},
  crypto:require('node:crypto'),zod:require('zod'),
  '@/lib/flights/cabin':{CABIN_CLASSES:[1,2,3,4,5].map(value=>({value}))},
  '@/lib/dashboard/session':{getDashboardSession:async()=>{calls.push('session-lookup');if(deferSession)await authorization.promise;if(sessionFailure)throw new Error('test identity failure');return session;}},
  '@/lib/flights/pricing-principal':{
   pricingPrincipalForSession:session=>({userId:session?.clerkId??null,audience:session?.role==='b2b'&&session.agencyCode?'agency':'b2c',agencyCode:session?.role==='b2b'?session.agencyCode:null}),
   pricingAudienceForPrincipal:principal=>principal.audience==='agency'?{kind:'agency',agencyCode:principal.agencyCode}:{kind:'b2c'},
  },
  '@/lib/flights/search-cache':{SearchReferenceStoreError:class extends Error{}},
  '@/lib/http/actor-key':{requestActorKey:()=> 'test'},
  '@/lib/rate-limit':{checkActionLimit:async()=>{calls.push('rate-start');if(deferPrechecks)await rate.promise;calls.push('rate-complete');return {ok:rateAllowed,retryAfterSeconds:60};},rateLimitMessage:()=> 'Wait'},
  '@/lib/triplover/client':{TriploverError},
  '@/lib/triplover/config':{isTriploverConfigured:()=>true},
  '@/lib/shapontravels/client':{isShapontravelsConfigured:()=>true,ShapontravelsReadError:class extends Error{}},
  '@/lib/db/supplier-controls':{getSupplierOperationalControls:async()=>({activeSupplier:'triplover'})},
  '@/lib/db/flight-search-history':{recordFlightSearch:async()=>{calls.push('history-start');if(deferHistory)await history.promise;calls.push('history-complete');}},
  '@/lib/db/flight-search-usage':{
   beginFlightSearchUsage:async(input,options)=>{calls.push('begin-start');registrations.push({input,options});if(deferPrechecks)await begin.promise;calls.push('begin-complete');return 'event-test';},
   claimFlightSearchSupplierHit:async()=>{calls.push('supplier-admission');return {allowed:true};},
   finishFlightSearchUsage:async outcome=>{calls.push('finish-start');events.push(outcome);await finish.promise;calls.push('finish-complete');},
  },
  '@/lib/triplover/search':{searchFlights:async(_input,_supplier,audience)=>{calls.push('supplier-search');audiences.push(audience);await search.promise;if(fail==='currency')throw new currencyModule.UnsupportedCurrencyError();if(fail==='supplier')throw Object.assign(new TriploverError('supplier business failure'),{kind:'supplier',status:200});if(fail)throw new Error('test supplier failure');return {result:{itineraries:[],partial:true},timing:{}};}},
 };
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:id=>{if(!(id in modules))throw new Error('Unexpected import '+id);return modules[id];},performance,ReadableStream,TextEncoder,Response,Headers,setInterval,clearInterval,console:{log(){},info(){},error(){},warn(){}},process:{env:{}}});
 return {route:module.exports,search,finish,begin,rate,history,authorization,events,calls,afterTasks,registrations,audiences};
}
function searchRequest(stream) {
 return new Request('https://example.test/api/flights/search',{method:'POST',headers:{accept:stream?'text/event-stream':'application/json','content-type':'application/json'},body:JSON.stringify(input)});
}
function observeResponse(pending) {
 const observed={received:false,ended:false,body:'',status:null};
 observed.done=pending.then(async response=>{
  observed.received=true;observed.status=response.status;
  const reader=response.body.getReader(),decoder=new TextDecoder();
  while(true) {
   const {done,value}=await reader.read();
   if(value)observed.body+=decoder.decode(value,{stream:!done});
   if(done){observed.body+=decoder.decode();break;}
  }
  observed.ended=true;
 });
 return observed;
}
// KTT's marketing search remains public. Session failures use B2C pricing;
// only a live authenticated agency selects the registration optimization.
for(const stream of [true,false]) {
 for(const scenario of [
  {name:'guest',userId:null,audience:'b2c',strategy:'ensure-first'},
  {name:'identity failure',sessionFailure:true,userId:null,audience:'b2c',strategy:'ensure-first'},
  {name:'customer',session:{clerkId:'customer-test',role:'customer',agencyCode:null},userId:'customer-test',audience:'b2c',strategy:'ensure-first'},
  {name:'agency',session:{clerkId:'agency-test',role:'b2b',agencyCode:'ST-B2B123456'},userId:'agency-test',audience:'agency',strategy:'insert-first'},
 ]) {
  const h=harness(scenario);
  const observed=observeResponse(h.route.POST(searchRequest(stream)));
  await flush();
  assert.equal(h.registrations.length,1,scenario.name);
  assert.equal(h.registrations[0].input.actorUserId,scenario.userId,scenario.name);
  assert.equal(h.registrations[0].options.actorRegistryStrategy,scenario.strategy,scenario.name);
  assert.equal(h.audiences[0].kind,scenario.audience,scenario.name);
  if(scenario.audience==='agency')assert.equal(h.audiences[0].agencyCode,'ST-B2B123456');
  h.search.resolve();h.finish.resolve();await observed.done;
  assert.ok(observed.body.includes(stream?'event: result':'"success":true'),scenario.name);
  assert.equal(observed.status,200,scenario.name);
  await Promise.all(h.afterTasks.map(f=>f()));
 }
}
{
 const h=harness({deferSession:true});
 const observed=observeResponse(h.route.POST(searchRequest(true)));
 await flush();
 assert.equal(observed.received,true,'public SSE headers precede the session lookup');
 assert.ok(observed.body.includes('"stage":"accepted"'),'public SSE reports acceptance during session lookup');
 assert.ok(h.calls.includes('session-lookup'));
 assert.ok(!h.calls.includes('begin-start'));
 assert.ok(!h.calls.includes('supplier-search'));
 h.authorization.resolve();h.search.resolve();h.finish.resolve();await observed.done;
 assert.ok(observed.body.includes('event: result'));
 await Promise.all(h.afterTasks.map(f=>f()));
}
for(const fail of [false,true]) {
 const h=harness({fail});
 const response=await h.route.POST(new Request('https://example.test/api/flights/search',{method:'POST',headers:{accept:'text/event-stream','content-type':'application/json'},body:JSON.stringify(input)}));
 let ended=false;
 const text=response.text().then(body=>{ended=true;return body;});
 h.search.resolve();await flush();
 assert.equal(h.events.length,1);
 assert.equal(h.events[0].outcome,fail?'failed':'success');
 assert.equal(ended,false,'stream must stay open until usage finalization settles');
 assert.equal(h.afterTasks.length,1,'work must be registered with the response lifecycle');
 h.finish.resolve();
 const body=await text;
 assert.ok(body.includes(fail?'event: error':'event: result'));
 await Promise.all(h.afterTasks.map(f=>f()));
}
// A disconnected reader must not abandon the admitted search or its usage write.
{
 const h=harness();
 const response=await h.route.POST(new Request('https://example.test/api/flights/search',{method:'POST',headers:{accept:'text/event-stream'},body:JSON.stringify(input)}));
 await response.body.cancel();h.search.resolve();await flush();
 assert.equal(h.events[0].outcome,'success');
 h.finish.resolve();await Promise.all(h.afterTasks.map(f=>f()));
}
{
 const h=harness();
 const response=await h.route.POST(new Request('https://example.test/api/flights/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,fareType:'student'})}));
 assert.equal(response.status,400);
 assert.equal((await response.json()).error.errorCode,'INVALID_SEARCH');
 assert.equal(h.events.length,0,'unsupported student fare must never reach supplier admission');
}
for(const stream of [true,false]) {
 const h=harness({fail:'supplier'});
 const pending=h.route.POST(new Request('https://example.test/api/flights/search',{method:'POST',headers:{accept:stream?'text/event-stream':'application/json'},body:JSON.stringify(input)}));
 h.search.resolve();h.finish.resolve();const response=await pending;
 const body=await response.text();
 assert.ok(body.includes('SUPPLIER_SEARCH_REJECTED'));
 assert.ok(!body.includes('supplier business failure'),'raw supplier message stays private');
 assert.ok(!body.includes('event: result'));
 assert.equal(h.events[0].errorCode,'SUPPLIER_SEARCH_REJECTED');
 if(!stream)assert.equal(response.status,502);
 await Promise.all(h.afterTasks.map(f=>f()));
}
for(const stream of [true,false]) {
 const h=harness({fail:'currency'});
 const pending=h.route.POST(new Request('https://example.test/api/flights/search',{method:'POST',headers:{accept:stream?'text/event-stream':'application/json'},body:JSON.stringify(input)}));
 h.search.resolve();h.finish.resolve();const response=await pending;
 const body=await response.text();
 assert.ok(body.includes('UNSUPPORTED_CURRENCY'));
 assert.ok(body.includes('Only BDT is supported.'));
 assert.ok(!body.includes('event: result'));
 assert.equal(h.events[0].errorCode,'UNSUPPORTED_CURRENCY');
 assert.equal(h.events[0].outcome,'failed');
 if(!stream)assert.equal(response.status,502);
 await Promise.all(h.afterTasks.map(f=>f()));
}
// Both independent prechecks must start promptly, and supplier admission must
// wait for both even when either one completes first.
for(const stream of [true,false]) {
 for(const first of ['begin','rate']) {
  const h=harness({deferPrechecks:true});
  const observed=observeResponse(h.route.POST(searchRequest(stream)));
  await flush();
  assert.ok(h.calls.includes('begin-start'),'usage registration must start before waiting for the rate check');
  assert.ok(h.calls.includes('rate-start'),'rate check must start before waiting for usage registration');
  assert.ok(!h.calls.includes('supplier-admission'),'pending prechecks must block supplier admission');
  assert.ok(!h.calls.includes('supplier-search'),'pending prechecks must block supplier search');
  h[first].resolve();await flush();
  assert.ok(h.calls.includes(`${first}-complete`));
  assert.ok(!h.calls.includes('supplier-admission'),'one completed precheck must not admit the supplier');
  assert.ok(!h.calls.includes('supplier-search'),'one completed precheck must not start a supplier search');
  h[first==='begin'?'rate':'begin'].resolve();await flush();
  assert.equal(h.calls.filter(call=>call==='supplier-admission').length,1);
  assert.equal(h.calls.filter(call=>call==='supplier-search').length,1);
  h.search.resolve();h.finish.resolve();await observed.done;
  assert.ok(observed.body.includes(stream?'event: result':'"success":true'));
  await Promise.all(h.afterTasks.map(f=>f()));
 }
}
// A denied rate check still needs the usage event before finalizing the denial;
// neither response mode may consume a supplier hit while registration waits.
for(const stream of [true,false]) {
 const h=harness({deferPrechecks:true,rateAllowed:false});
 const observed=observeResponse(h.route.POST(searchRequest(stream)));
 await flush();
 h.rate.resolve();await flush();
 assert.equal(h.events.length,0,'rate rejection must wait for its usage registration');
 assert.ok(!h.calls.includes('supplier-admission'));
 assert.ok(!h.calls.includes('supplier-search'));
 h.begin.resolve();await flush();
 assert.equal(h.events.length,1);
 assert.equal(h.events[0].httpStatus,429);
 assert.ok(!h.calls.includes('supplier-admission'));
 assert.ok(!h.calls.includes('supplier-search'));
 h.finish.resolve();await observed.done;
 assert.ok(observed.body.includes('RATE_LIMITED'));
 if(!stream)assert.equal(observed.status,429);
 await Promise.all(h.afterTasks.map(f=>f()));
}
// History and usage writes overlap, but a terminal result is withheld until
// both complete. Observe actual SSE chunks so a premature result cannot hide
// behind a stream that happens to remain open.
for(const stream of [true,false]) {
 for(const first of ['history','finish']) {
  const h=harness({deferHistory:true});
  const observed=observeResponse(h.route.POST(searchRequest(stream)));
  await flush();h.search.resolve();await flush();
  assert.ok(h.calls.includes('history-start'),'history write must start before waiting for usage finalization');
  assert.ok(h.calls.includes('finish-start'),'usage finalization must start before waiting for history');
  assert.equal(observed.ended,false);
  assert.ok(!observed.body.includes('event: result'),'pending finalization must withhold the terminal SSE result');
  if(!stream)assert.equal(observed.received,false,'pending finalization must withhold the JSON response');
  h[first].resolve();await flush();
  assert.ok(h.calls.includes(`${first}-complete`));
  assert.equal(observed.ended,false,'one completed write must not finish the search response');
  assert.ok(!observed.body.includes('event: result'),'one completed write must not emit the terminal SSE result');
  if(!stream)assert.equal(observed.received,false);
  h[first==='history'?'finish':'history'].resolve();await observed.done;
  assert.ok(observed.body.includes(stream?'event: result':'"success":true'));
  assert.equal(h.events.length,1);
  assert.equal(h.events[0].outcome,'success');
  await Promise.all(h.afterTasks.map(f=>f()));
 }
}
// A failed concurrent check must still let registration finish. SSE finalizes
// the registered attempt; JSON preserves its existing thrown-error contract.
for(const stream of [true,false]) {
 const h=harness({deferPrechecks:true});
 let settled=false;
 const pending=h.route.POST(searchRequest(stream));
 const observed=stream?observeResponse(pending):null;
 const outcome=stream?null:pending.then(response=>{settled=true;return {response};},error=>{settled=true;return {error};});
 await flush();h.rate.reject(new Error('test rate failure'));await flush();
 assert.ok(h.calls.includes('begin-start'));
 assert.ok(!h.calls.includes('begin-complete'));
 assert.equal(h.events.length,0,'failed rate check must await its pending registration before finalization');
 assert.ok(!h.calls.includes('supplier-admission'));
 assert.ok(!h.calls.includes('supplier-search'));
 if(stream)assert.ok(!observed.body.includes('event: error'));
 else assert.equal(settled,false,'JSON rejection must await its pending sibling registration');
 h.begin.resolve();await flush();
 assert.ok(h.calls.includes('begin-complete'));
 assert.ok(!h.calls.includes('supplier-admission'));
 assert.ok(!h.calls.includes('supplier-search'));
 if(stream) {
  assert.equal(h.events.length,1);
  assert.equal(h.events[0].eventId,'event-test');
  assert.equal(h.events[0].outcome,'failed');
  h.finish.resolve();await observed.done;
  assert.ok(observed.body.includes('event: error'));
  assert.ok(!observed.body.includes('event: result'));
 } else {
  assert.equal((await outcome).error.message,'test rate failure');
  assert.equal(h.events.length,0);
 }
 await Promise.all(h.afterTasks.map(f=>f()));
}
// If history fails, the concurrent usage write must settle before the failure
// response is produced or a second usage-finalization attempt begins.
for(const stream of [true,false]) {
 const h=harness({deferHistory:true});
 const observed=observeResponse(h.route.POST(searchRequest(stream)));
 await flush();h.search.resolve();await flush();
 assert.ok(h.calls.includes('history-start'));
 assert.ok(h.calls.includes('finish-start'));
 h.history.reject(new Error('test history failure'));await flush();
 assert.equal(h.events.length,1,'failed history must not race the pending success usage write');
 assert.equal(h.events[0].outcome,'success');
 assert.equal(observed.ended,false);
 assert.ok(!observed.body.includes('event: result'));
 assert.ok(!observed.body.includes('event: error'),'failed history must await the sibling usage write before emitting an error');
 if(!stream)assert.equal(observed.received,false);
 h.finish.resolve();await observed.done;
 assert.equal(h.events.length,2);
 assert.equal(h.events[1].outcome,'failed');
 assert.equal(h.events[1].eventId,'event-test');
 assert.ok(observed.body.includes('SEARCH_FAILED'));
 assert.ok(!observed.body.includes('event: result'));
 if(!stream)assert.equal(observed.status,500);
 await Promise.all(h.afterTasks.map(f=>f()));
}
console.log('Search concurrent prechecks and finalization, currency and supplier error classification, disconnect lifecycle and unsupported-fare checks passed.');
