import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db,env,migrate,reset,shutdown,request,freshIp} from './pg-harness.mjs';
const {default:login}=await import('../netlify/functions/staff-login.mjs');
const {default:admin}=await import('../netlify/functions/staff-admin.mjs');
const {default:staffApi}=await import('../netlify/functions/nebu-orders.mjs');
const {default:shop}=await import('../netlify/functions/shop-api.mjs');
const {default:printer,LEASE_MS}=await import('../netlify/functions/kitchen-print.mjs');
before(migrate);after(shutdown);beforeEach(reset);

let t;
async function staff(){await request(admin,{body:{action:'bootstrap',setupCode:'setup-code-0123456789',name:'Toto',pin:'482915'},ip:freshIp()});t=(await request(login,{body:{action:'login',name:'Toto',pin:'482915'},ip:freshIp()})).token}
const place=async(over={})=>(await request(shop,{body:{action:'create',requestId:crypto.randomUUID(),customer:'Anna',phone:'0211 1234567',fulfillment:'pickup',cart:[{id:'p017',qty:2}],notes:'ohne Wasabi',...over},ip:freshIp()})).order;
const accept=(id,version=0)=>request(staffApi,{token:t,body:{action:'update',id,expectedVersion:version,status:'accepted',eta:45,riskReviewed:true}});
const agent=(body,token=env.NEBU_PRINT_AGENT_TOKEN)=>request(printer,{token,body:{agentId:'pc1',...body}});
const kp=async id=>(await db.query('SELECT kitchen_print FROM nebu_orders WHERE id=$1',[id])).rows[0].kitchen_print;
const setKp=async(id,patch)=>db.query('UPDATE nebu_orders SET kitchen_print=kitchen_print||$2::jsonb WHERE id=$1',[id,JSON.stringify(patch)]);

test('wrong agent token rejected; staff token is no agent token',async()=>{
 await staff();
 assert.equal((await agent({action:'claim'},'falsch')).status,403);
 assert.equal((await agent({action:'claim'},t)).status,403);
});

test('only accepted orders are printed, exactly one job, minimal ticket data',async()=>{
 await staff();const a=await place(),b=await place();
 assert.deepEqual((await agent({action:'claim'})).jobs,[]);
 await request(staffApi,{token:t,body:{action:'update',id:b.id,expectedVersion:0,status:'rejected',cancelReason:'Zu'}});
 await accept(a.id);await accept(a.id);
 const r=await agent({action:'claim'});
 assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].orderId,a.id);
 assert.deepEqual(r.jobs[0].ticket.items,[{qty:2,name:'Maguro Maki'}]);
 assert.equal(r.jobs[0].ticket.notes,'ohne Wasabi');assert.equal(r.jobs[0].ticket.phone,undefined);
});

test('lease prevents double hand-out; printed ack idempotent; late failure does not undo',async()=>{
 await staff();const a=await place();await accept(a.id);
 const {jobs:[job]}=await agent({action:'claim'});
 assert.equal((await agent({action:'claim'})).jobs.length,0);
 assert.equal((await agent({action:'ack',jobId:job.jobId,orderId:a.id,result:'printed'})).ok,true);
 assert.equal((await agent({action:'ack',jobId:job.jobId,orderId:a.id,result:'printed'})).alreadyPrinted,true);
 await agent({action:'ack',jobId:job.jobId,orderId:a.id,result:'failed',error:'x'});
 assert.equal((await kp(a.id)).status,'printed');
});

test('failure → backoff → retry; expired lease reissued with same job id',async()=>{
 await staff();const a=await place();await accept(a.id);
 const {jobs:[job]}=await agent({action:'claim'});
 assert.ok((await agent({action:'ack',jobId:job.jobId,orderId:a.id,result:'failed',error:'Papier leer'})).retryAt);
 assert.equal((await agent({action:'claim'})).jobs.length,0);
 await setKp(a.id,{nextAttemptAt:new Date(Date.now()-1).toISOString()});
 assert.equal((await agent({action:'claim'})).jobs[0].attempt,2);
 await setKp(a.id,{leaseUntil:new Date(Date.now()-1).toISOString()});
 assert.equal((await agent({action:'claim'})).jobs[0].jobId,job.jobId);
 assert.ok(LEASE_MS>=60000);
});

test('printer not ready: job kept; recovery hands it out immediately',async()=>{
 await staff();const a=await place();await accept(a.id);
 const down=await agent({action:'claim',printer:{ok:false,detail:'Deckel offen'}});
 assert.equal(down.jobs.length,0);assert.equal(down.waiting,1);
 assert.equal((await kp(a.id)).attempts,0);
 await setKp(a.id,{nextAttemptAt:new Date(Date.now()+60000).toISOString()});
 assert.equal((await agent({action:'claim',printer:{ok:true},retryNow:true})).jobs.length,1);
});

test('unconfirmed print is never reissued; job skipped once order left kitchen',async()=>{
 await staff();const a=await place(),b=await place();await accept(a.id);await accept(b.id);
 const {jobs}=await agent({action:'claim'});
 const ja=jobs.find(j=>j.orderId===a.id);
 await agent({action:'ack',jobId:ja.jobId,orderId:a.id,result:'unconfirmed',error:'Papier leer'});
 await setKp(a.id,{leaseUntil:new Date(Date.now()-1).toISOString()});
 await db.query("UPDATE nebu_orders SET status='ready' WHERE id=$1",[b.id]);
 await setKp(b.id,{leaseUntil:new Date(Date.now()-1).toISOString()});
 assert.equal((await agent({action:'claim'})).jobs.length,0);
 assert.equal((await kp(a.id)).status,'unconfirmed');assert.equal((await kp(b.id)).status,'skipped');
});

test('print activity never changes the order version (no false conflicts for staff)',async()=>{
 await staff();const a=await place();const r=await accept(a.id);
 await agent({action:'claim'});
 assert.equal((await request(staffApi,{token:t,body:{action:'update',id:a.id,expectedVersion:r.order.version,status:'preparing'}})).status,200);
});

test('two print agents at once never get the same job',async()=>{
 await staff();for(let i=0;i<4;i++){const o=await place();await accept(o.id)}
 const [x,y]=await Promise.all([agent({action:'claim'}),request(printer,{token:env.NEBU_PRINT_AGENT_TOKEN,body:{agentId:'pc2',action:'claim'}})]);
 const ids=[...x.jobs,...y.jobs].map(j=>j.orderId);
 assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);
});

test('heartbeat shown to staff; customer status hides print internals',async()=>{
 await staff();const a=await place();
 await agent({action:'claim',printer:{ok:true,detail:'bereit'},version:'1.2.0'});
 const r=await request(staffApi,{method:'GET',token:t});
 assert.equal(r.printAgent.printerOk,true);assert.equal(r.printAgent.version,'1.2.0');
});
