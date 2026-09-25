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
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function harness({fail=false}={}) {
 const search=deferred(),finish=deferred();
 const afterTasks=[],events=[];
 class TriploverError extends Error {}
 const modules={
  '@/lib/currency':currencyModule,
  'next/server':{NextResponse:Response,after:callback=>afterTasks.push(callback)},
  crypto:require('node:crypto'),zod:require('zod'),
  '@/lib/flights/cabin':{CABIN_CLASSES:[1,2,3,4,5].map(value=>({value}))},
  '@/lib/dashboard/session':{getDashboardSession:async()=>null},
  '@/lib/flights/pricing-principal':{pricingPrincipalForSession:()=>({userId:null,audience:'customer',agencyCode:null}),pricingAudienceForPrincipal:()=>({kind:'b2c'})},
  '@/lib/flights/search-cache':{SearchReferenceStoreError:class extends Error{}},
  '@/lib/http/actor-key':{requestActorKey:()=> 'test'},
  '@/lib/rate-limit':{checkActionLimit:async()=>({ok:true}),rateLimitMessage:()=> 'Wait'},
  '@/lib/triplover/client':{TriploverError},
  '@/lib/triplover/config':{isTriploverConfigured:()=>true},
  '@/lib/shapontravels/client':{isShapontravelsConfigured:()=>true,ShapontravelsReadError:class extends Error{}},
  '@/lib/db/supplier-controls':{getSupplierOperationalControls:async()=>({activeSupplier:'triplover'})},
  '@/lib/db/flight-search-history':{recordFlightSearch:async()=>{}},
  '@/lib/db/flight-search-usage':{
   beginFlightSearchUsage:async()=> 'event-test',
   claimFlightSearchSupplierHit:async()=>({allowed:true}),
   finishFlightSearchUsage:async outcome=>{events.push(outcome);await finish.promise;},
  },
  '@/lib/triplover/search':{searchFlights:async()=>{await search.promise;if(fail==='currency')throw new currencyModule.UnsupportedCurrencyError();if(fail==='supplier')throw Object.assign(new TriploverError('supplier business failure'),{kind:'supplier',status:200});if(fail)throw new Error('test supplier failure');return {result:{itineraries:[],partial:true},timing:{}};}},
 };
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:id=>{if(!(id in modules))throw new Error('Unexpected import '+id);return modules[id];},performance,ReadableStream,TextEncoder,Response,Headers,setInterval,clearInterval,console:{log(){},info(){},error(){},warn(){}},process:{env:{}}});
 return {route:module.exports,search,finish,events,afterTasks};
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
console.log('Search finalization, currency and supplier error classification, disconnect lifecycle and unsupported-fare checks passed.');
