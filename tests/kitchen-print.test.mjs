import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {state,database,blobs} from './payment-harness.mjs';
mock.module('@netlify/database',{namedExports:database});
mock.module('@netlify/blobs',{namedExports:blobs});
mock.module('web-push',{defaultExport:{setVapidDetails(){},sendNotification:async()=>{}}});
const SECRET='test-only-long-session-secret-12345678901234567890';
const AGENT='test-only-print-agent-token-abcdefghijklmnopqrstuvwxyz';
globalThis.Netlify={env:{get:k=>({NEBU_TEST_SESSION_SECRET:SECRET,NEBU_TEST_CUSTOMER_KEY:'cust-key',NEBU_PRINT_AGENT_TOKEN:AGENT})[k]}};
const {issueStaffSession}=await import('../netlify/functions/nebu-staff-session.mjs');
const {default:orders}=await import('../netlify/functions/demo-orders.mjs');
const {default:printer,LEASE_MS}=await import('../netlify/functions/kitchen-print.mjs');
const staff=await issueStaffSession(SECRET);
const staffCall=body=>orders(new Request('https://x/',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+staff},body:JSON.stringify(body)}));
const agent=(body,token=AGENT)=>printer(new Request('https://x/',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({agentId:'pc1',...body})}));
const read=async r=>({status:r.status,...(await r.json())});
const base=o=>({requestId:'r',customerToken:'tok',version:0,id:'T1',customer:'Anna',phone:'0211123456',items:[{name:'Maki Box',price:17.5,qty:2}],notes:'ohne Wasabi',subtotal:35,fee:0,total:35,fulfillment:'pickup',paymentMethod:'cash',paymentReceived:false,status:'new',createdAt:new Date().toISOString(),...o});
const set=(...os)=>{state.row={orders:os,migrated:true}};
const order=id=>state.row.orders.find(o=>o.id===id);
const accept=id=>staffCall({action:'update',id,expectedVersion:order(id).version,status:'accepted',eta:45});

test('wrong or missing agent token is rejected',async()=>{
 set(base());
 assert.equal((await agent({action:'claim'},'falsch')).status,403);
 assert.equal((await printer(new Request('https://x/',{method:'POST',body:'{}'}))).status,403);
 assert.equal((await staffCall({action:'claim'})).status,400);
});

test('new and rejected orders are never printed; accepted order creates exactly one job',async()=>{
 set(base(),base({id:'T2',requestId:'r2'}));
 assert.deepEqual((await read(await agent({action:'claim'}))).jobs,[]);
 assert.equal((await staffCall({action:'update',id:'T2',expectedVersion:0,status:'rejected',cancelReason:'Zu'})).status,200);
 assert.equal((await accept('T1')).status,200);
 const job=order('T1').kitchenPrint;assert.equal(job.status,'queued');assert.ok(job.jobId);
 // Doppelte Annahme von zweitem Gerät erzeugt keinen zweiten Auftrag.
 await staffCall({action:'update',id:'T1',expectedVersion:0,status:'accepted',eta:45});
 assert.equal(order('T1').kitchenPrint.jobId,job.jobId);
 const r=await read(await agent({action:'claim'}));
 assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].orderId,'T1');
 assert.deepEqual(r.jobs[0].ticket.items,[{qty:2,name:'Maki Box'}]);
 assert.equal(r.jobs[0].ticket.notes,'ohne Wasabi');assert.equal(r.jobs[0].ticket.eta,45);
 assert.equal(r.jobs[0].ticket.phone,undefined,'keine unnötigen Kundendaten auf dem Bon');
 assert.equal(order('T2').kitchenPrint,undefined);
});

test('claimed job is not handed out twice while the lease runs; printed ack is idempotent',async()=>{
 set(base());await accept('T1');
 const first=await read(await agent({action:'claim'}));assert.equal(first.jobs.length,1);
 assert.equal((await read(await agent({action:'claim'}))).jobs.length,0);
 const {jobId}=first.jobs[0];
 assert.equal((await read(await agent({action:'ack',jobId,orderId:'T1',result:'printed'}))).ok,true);
 assert.equal(order('T1').kitchenPrint.status,'printed');
 const again=await read(await agent({action:'ack',jobId,orderId:'T1',result:'printed'}));assert.equal(again.alreadyPrinted,true);
 // Ein spätes Fehler-ack überschreibt einen erfolgreichen Druck nicht.
 await agent({action:'ack',jobId,orderId:'T1',result:'failed',error:'x'});
 assert.equal(order('T1').kitchenPrint.status,'printed');
 assert.equal((await read(await agent({action:'claim'}))).jobs.length,0);
});

test('failed print is retried after backoff, expired lease is reissued',async()=>{
 set(base());await accept('T1');
 const {jobs:[job]}=await read(await agent({action:'claim'}));
 const f=await read(await agent({action:'ack',jobId:job.jobId,orderId:'T1',result:'failed',error:'Papier leer'}));
 assert.ok(f.retryAt);assert.equal(order('T1').kitchenPrint.lastError,'Papier leer');
 assert.equal((await read(await agent({action:'claim'}))).jobs.length,0,'Backoff abwarten');
 order('T1').kitchenPrint.nextAttemptAt=new Date(Date.now()-1).toISOString();
 const retry=await read(await agent({action:'claim'}));assert.equal(retry.jobs.length,1);assert.equal(retry.jobs[0].attempt,2);
 order('T1').kitchenPrint.leaseUntil=new Date(Date.now()-1).toISOString();
 const reissued=await read(await agent({action:'claim'}));assert.equal(reissued.jobs[0].jobId,job.jobId,'gleiche jobId → lokales Journal verhindert Doppeldruck');
 assert.ok(LEASE_MS>=60000);
});

test('job is skipped once the order has left the kitchen',async()=>{
 set(base());await accept('T1');
 order('T1').status='picked_up';
 assert.equal((await read(await agent({action:'claim'}))).jobs.length,0);
 assert.equal(order('T1').kitchenPrint.status,'skipped');
});

test('print job does not change order version (no false 409 for staff)',async()=>{
 set(base());await accept('T1');const v=order('T1').version;
 await agent({action:'claim'});
 assert.equal(order('T1').version,v);
 assert.equal((await staffCall({action:'update',id:'T1',expectedVersion:v,status:'preparing'})).status,200);
});

test('customer status response does not expose print internals',async()=>{
 set(base());await accept('T1');
 const r=await read(await orders(new Request('https://x/',{method:'POST',body:JSON.stringify({action:'status',id:'T1',token:'tok'})})));
 assert.equal(r.order.kitchenPrint,undefined);
});

test('unconfirmed print is not handed out again and not shown as printed',async()=>{
 set(base());await accept('T1');
 const {jobs:[job]}=await read(await agent({action:'claim'}));
 assert.equal((await read(await agent({action:'ack',jobId:job.jobId,orderId:'T1',result:'unconfirmed',error:'Papier leer'}))).ok,true);
 assert.equal(order('T1').kitchenPrint.status,'unconfirmed');
 order('T1').kitchenPrint.leaseUntil=new Date(Date.now()-1).toISOString();
 assert.equal((await read(await agent({action:'claim'}))).jobs.length,0,'kein automatischer Neudruck');
});
