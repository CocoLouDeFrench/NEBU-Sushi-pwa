import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {state,database,blobs} from './payment-harness.mjs';
mock.module('@netlify/database',{namedExports:database});
mock.module('@netlify/blobs',{namedExports:blobs});
mock.module('web-push',{defaultExport:{setVapidDetails(){},sendNotification:async()=>{}}});
const SECRET='test-only-long-session-secret-12345678901234567890';
globalThis.Netlify={env:{get:k=>({NEBU_TEST_SESSION_SECRET:SECRET,NEBU_TEST_CUSTOMER_KEY:'cust-key'})[k]}};
const {issueStaffSession}=await import('../netlify/functions/nebu-staff-session.mjs');
const {default:orders}=await import('../netlify/functions/demo-orders.mjs');
const staff=await issueStaffSession(SECRET);
const call=(body,auth=true)=>orders(new Request('https://x/',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+staff}:{})},body:JSON.stringify(body)}));
const base=o=>({requestId:'r',customerToken:'tok',version:0,id:'T1',customer:'A',phone:'0211123456',email:'a@b.de',address:'X',items:[],subtotal:20,fee:0,total:20,fulfillment:'delivery',paymentMethod:'cash',paymentReceived:false,status:'new',createdAt:new Date().toISOString(),...o});
const setOrder=o=>{state.row={orders:[o],migrated:true}};const cur=()=>state.row.orders[0];
const upd=x=>call({action:'update',id:'T1',expectedVersion:cur().version,...x});
const body=async r=>({status:r.status,...(await r.json())});

test('payment cannot be confirmed before acceptance',async()=>{
 setOrder(base({status:'new'}));
 const r=await body(await upd({paymentReceived:true}));
 assert.equal(r.status,409);assert.match(r.error,/erst nach Annahme/);assert.equal(cur().paymentReceived,false);
});
test('payment confirmable in accepted..enroute and logged',async()=>{
 for(const st of ['accepted','preparing','ready','enroute']){
  setOrder(base({status:st}));
  assert.equal((await upd({paymentReceived:true})).status,200,st);
  const h=cur().paymentHistory;assert.equal(h.length,1);assert.deepEqual([h[0].from,h[0].to,h[0].orderStatus,h[0].reason],[false,true,st,null]);
  assert.ok(cur().paymentConfirmedAt);
 }
});
test('payment + status in one request rejected',async()=>{
 setOrder(base({status:'enroute'}));
 assert.equal((await upd({paymentReceived:true,status:'delivered'})).status,422);
});
test('reversal requires a reason; without reason nothing changes',async()=>{
 setOrder(base({status:'enroute'}));await upd({paymentReceived:true});
 for(const reason of [undefined,'','   ','abc']){const r=await upd({paymentReceived:false,...(reason===undefined?{}:{paymentReason:reason})});assert.equal(r.status,422,String(reason))}
 assert.equal(cur().paymentReceived,true);assert.equal(cur().paymentHistory.length,1);
 assert.equal((await upd({paymentReceived:false,paymentReason:123})).status,422);
 assert.equal((await upd({paymentReceived:false,paymentReason:'x'.repeat(301)})).status,422);
});
test('former finding closed: paid -> unpaid -> failed leaves a full trail',async()=>{
 setOrder(base({status:'enroute'}));
 await upd({paymentReceived:true});
 assert.equal((await upd({paymentReceived:false,paymentReason:'Kunde hat Schein zurückverlangt'})).status,200);
 assert.equal((await upd({status:'delivery_failed'})).status,200);
 const o=cur();assert.equal(o.status,'delivery_failed');assert.equal(o.paymentReversed,true);assert.ok(o.paymentConfirmedAt);
 assert.deepEqual(o.paymentHistory.map(e=>[e.from,e.to,!!e.reason]),[[false,true,false],[true,false,true]]);
 // trail cannot be removed: extra keys rejected, final order locked
 assert.equal((await upd({paymentHistory:[]})).status,422);
 assert.equal((await upd({paymentReceived:true})).status,409);
 assert.equal(cur().paymentHistory.length,2);
});
test('no-op payment requests do not create log entries',async()=>{
 setOrder(base({status:'ready'}));await upd({paymentReceived:true});
 for(let i=0;i<3;i++)await call({action:'update',id:'T1',expectedVersion:0,paymentReceived:true});
 assert.equal(cur().paymentHistory.length,1);
});
test('parallel confirmations still produce exactly one write and one log entry',async()=>{
 setOrder(base({status:'ready'}));state.commits=0;
 await Promise.all(Array.from({length:10},()=>call({action:'update',id:'T1',expectedVersion:0,paymentReceived:true})));
 assert.equal(state.commits,1);assert.equal(cur().paymentHistory.length,1);
});
test('customer status view hides payment log and contact data',async()=>{
 setOrder(base({status:'enroute'}));await upd({paymentReceived:true});await upd({paymentReceived:false,paymentReason:'Testgrund lang'});
 const r=await body(await call({action:'status',id:'T1',token:'tok'},false));
 assert.equal(r.status,200);for(const k of ['paymentHistory','paymentReversed','phone','email','address','customerToken'])assert.equal(k in r.order,false,k);
});
test('history cap: 51st change refused instead of dropping entries',async()=>{
 setOrder(base({status:'ready',paymentHistory:Array.from({length:50},(_,i)=>({at:'x',from:i%2===1,to:i%2===0})),paymentReceived:false}));
 assert.equal((await upd({paymentReceived:true})).status,409);assert.equal(cur().paymentHistory.length,50);
});
test('regressions: customer cannot confirm, cash close needs payment',async()=>{
 setOrder(base({status:'enroute'}));
 assert.equal((await call({action:'update',id:'T1',expectedVersion:0,paymentReceived:true},false)).status,403);
 assert.equal((await upd({status:'delivered'})).status,409);
});
