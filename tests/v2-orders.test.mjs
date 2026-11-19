import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db,env,migrate,reset,shutdown,request,freshIp,pushes} from './pg-harness.mjs';
const {default:login}=await import('../netlify/functions/staff-login.mjs');
const {default:admin}=await import('../netlify/functions/staff-admin.mjs');
const {default:staffApi}=await import('../netlify/functions/nebu-orders.mjs');
const {default:shop}=await import('../netlify/functions/shop-api.mjs');
const {default:compat}=await import('../netlify/functions/demo-orders.mjs');
before(migrate);after(shutdown);beforeEach(reset);

const ITEM='p017';
async function staff(){
 await request(admin,{body:{action:'bootstrap',setupCode:'setup-code-0123456789',name:'Toto',pin:'482915'},ip:freshIp()});
 return (await request(login,{body:{action:'login',name:'Toto',pin:'482915'},ip:freshIp()})).token;
}
const order=(over={})=>({action:'create',requestId:crypto.randomUUID(),customer:'Anna Test',phone:'0211 1234567',email:'',fulfillment:'pickup',cart:[{id:ITEM,qty:2}],notes:'ohne Wasabi',...over});
async function place(over,ip=freshIp()){const r=await request(shop,{body:order(over),ip});assert.equal(r.status,201,JSON.stringify(r));return r}
const get=async(token)=>(await request(staffApi,{method:'GET',token})).orders;
const upd=(token,id,version,extra)=>request(staffApi,{token,body:{action:'update',id,expectedVersion:version,...extra}});

test('catalog id used in tests exists',async()=>{
 const {lookup}=await import('../netlify/functions/nebu-catalog.mjs');
 assert.ok(lookup.has(ITEM),'Artikel-ID '+ITEM+' fehlt: '+[...lookup.keys()].slice(0,5).join(', '));
});

test('no 100-order cap: every order is kept',async()=>{
 const t=await staff();
 for(let i=0;i<120;i++)await place({},freshIp());
 assert.equal((await db.query('SELECT count(*)::int n FROM nebu_orders')).rows[0].n,120);
 assert.equal((await get(t)).length,120);
});

test('prices, status and payment cannot be injected; server computes totals',async()=>{
 for(const f of ['total','status','paymentReceived','fee','kitchenPrint'])assert.equal((await request(shop,{body:order({[f]:0}),ip:freshIp()})).status,422,f);
 const r=await place();
 const row=(await db.query('SELECT data,token_hash FROM nebu_orders WHERE id=$1',[r.order.id])).rows[0];
 assert.ok(row.data.total>0);assert.equal(row.data.paymentReceived,false);
 assert.ok(row.token_hash&&row.token_hash!==r.token,'Kunden-Token nur als Hash gespeichert');
 assert.equal(r.order.phone,undefined,'Antwort an Kunden ohne Kontaktdaten');
});

test('same requestId twice creates exactly one order (also in parallel)',async()=>{
 const body=order();
 const res=await Promise.all([1,2,3].map(()=>request(shop,{body,ip:freshIp()})));
 assert.equal(res.filter(r=>r.status===201).length,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM nebu_orders')).rows[0].n,1);
});

test('public order throttle is atomic per IP',async()=>{
 const ip=freshIp();
 const res=await Promise.all(Array.from({length:25},()=>request(shop,{body:order(),ip})));
 assert.equal(res.filter(r=>r.status===201).length,20);assert.equal(res.filter(r=>r.status===429).length,5);
});

test('status only with own token; token expires; wrong token reveals nothing',async()=>{
 const a=await place(),b=await place();
 assert.equal((await request(shop,{body:{action:'status',id:a.order.id,token:a.token}})).order.status,'new');
 const wrong=await request(shop,{body:{action:'status',id:a.order.id,token:b.token}});
 assert.equal(wrong.status,403);assert.equal(wrong.order,undefined);
 await db.query("UPDATE nebu_orders SET token_expires_at=now()-interval '1 minute' WHERE id=$1",[a.order.id]);
 assert.equal((await request(shop,{body:{action:'status',id:a.order.id,token:a.token}})).status,403);
});

test('staff API requires personal login; customer cannot update',async()=>{
 const a=await place();
 assert.equal((await request(staffApi,{method:'GET'})).status,403);
 assert.equal((await request(compat,{body:{action:'update',id:a.order.id,expectedVersion:0,status:'accepted',eta:45}})).status,403);
});

test('accept: kitchen job queued, audit names the staff member, customer push sent',async()=>{
 const t=await staff();const a=await place();
 await request(shop,{body:{action:'push-register',orderId:a.order.id,token:a.token,subscription:{endpoint:'https://push.example/kunde',keys:{p256dh:'x',auth:'y'}}}});
 const r=await upd(t,a.order.id,0,{status:'accepted',eta:45});
 assert.equal(r.status,200);assert.equal(r.order.acceptedBy,'Toto');assert.equal(r.order.kitchenPrint.status,'queued');
 const audit=(await db.query("SELECT staff_name,action,order_id,detail FROM nebu_audit WHERE action='order_accepted'")).rows[0];
 assert.equal(audit.staff_name,'Toto');assert.equal(audit.order_id,a.order.id);
 assert.ok(!JSON.stringify(audit.detail).includes('Anna'),'keine Kundendaten im Protokoll');
 assert.ok(pushes.some(p=>p.endpoint==='https://push.example/kunde'&&/angenommen/.test(p.payload.title)));
});

test('two devices accept at the same time: one wins, no double kitchen job',async()=>{
 const t=await staff();const a=await place();
 const [x,y]=await Promise.all([upd(t,a.order.id,0,{status:'accepted',eta:45}),upd(t,a.order.id,0,{status:'accepted',eta:60})]);
 assert.deepEqual([x.status,y.status].sort(),[200,200]);
 assert.ok(x.alreadyApplied||y.alreadyApplied,'zweiter Klick ändert nichts');
 const row=(await db.query('SELECT version,kitchen_print FROM nebu_orders WHERE id=$1',[a.order.id])).rows[0];
 assert.equal(row.version,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM nebu_audit WHERE action='order_accepted'")).rows[0].n,1);
});

test('payment rules: confirm only after acceptance, reversal with reason, separate from status, cap, cash close',async()=>{
 const t=await staff();const a=await place();const id=a.order.id;
 assert.equal((await upd(t,id,0,{paymentReceived:true})).status,409,'vor Annahme');
 let r=await upd(t,id,0,{status:'accepted',eta:30});
 assert.equal((await upd(t,id,1,{status:'preparing',paymentReceived:true})).status,422,'zusammen mit Status');
 r=await upd(t,id,1,{paymentReceived:true});assert.equal(r.order.paymentHistory[0].actor,'Toto');
 assert.equal((await upd(t,id,2,{paymentReceived:false})).status,422,'Rücknahme ohne Grund');
 r=await upd(t,id,2,{paymentReceived:false,paymentReason:'Falsch gebucht'});assert.equal(r.order.paymentReversed,true);
 for(const s of ['preparing','ready'])r=await upd(t,id,r.order.version,{status:s});
 assert.equal((await upd(t,id,r.order.version,{status:'picked_up'})).status,409,'Barzahlung offen');
 r=await upd(t,id,r.order.version,{paymentReceived:true});
 r=await upd(t,id,r.order.version,{status:'picked_up'});assert.equal(r.status,200);
 assert.ok((await db.query('SELECT closed_at FROM nebu_orders WHERE id=$1',[id])).rows[0].closed_at,'abgeschlossen');
 assert.equal((await upd(t,id,r.order.version,{paymentReceived:false,paymentReason:'Test Test'})).status,409,'nach Abschluss gesperrt');
 const view=(await request(shop,{body:{action:'status',id,token:a.token}})).order;
 assert.equal(view.paymentHistory,undefined);assert.equal(view.customer,undefined);
});

test('reject needs reason; risk orders need explicit review',async()=>{
 const t=await staff();
 const phone='0211 7654321';
 const o1=await place({phone}),o2=await place({phone}),o3=await place({phone});
 const risky=(await get(t)).find(o=>o.id===o3.order.id);assert.equal(risky.riskFlag.level,'review');
 assert.equal((await upd(t,o3.order.id,0,{status:'accepted',eta:45})).status,409);
 assert.equal((await upd(t,o3.order.id,0,{status:'accepted',eta:45,riskReviewed:true})).status,200);
 assert.equal((await upd(t,o1.order.id,0,{status:'rejected'})).status,422);
 assert.equal((await upd(t,o1.order.id,0,{status:'rejected',cancelReason:'Küche geschlossen'})).status,200);
});

test('delivery orders: address check, delivery fee, invalid area offers pickup',async()=>{
 const out=await request(shop,{body:order({fulfillment:'delivery',address:'Irgendwo außerhalb 1'}),ip:freshIp()});
 assert.equal(out.status,422);assert.equal(out.offerPickup,true);
 const ok=await place({fulfillment:'delivery',address:'Derendorfer Str. 9',bell:'Müller',floor:'2',cart:[{id:ITEM,qty:3}]});
 assert.equal(ok.order.fee,2.5);
});

test('sold-out items: staff sets, public reads, order with sold-out item refused',async()=>{
 const t=await staff();
 assert.equal((await request(staffApi,{token:t,body:{action:'inventory-update',disabled:[ITEM]}})).status,200);
 assert.deepEqual((await request(shop,{body:{action:'inventory'}})).disabled,[ITEM]);
 assert.equal((await request(shop,{body:order(),ip:freshIp()})).status,409);
});

test('live environment: ordering closed until owner switches to online (WhatsApp fallback)',async()=>{
 env.NEBU_ENV='live';
 try{
  const t=await staff();
  const r=await request(shop,{body:order(),ip:freshIp()});
  assert.equal(r.status,409);assert.equal(r.orderingMode,'whatsapp');
  assert.equal((await request(shop,{body:{action:'config'}})).orderingMode,'whatsapp');
  assert.equal((await request(admin,{token:t,body:{action:'settings',set:{orderingMode:'online'}}})).orderingMode,'online');
  const ok=await place();assert.match(ok.order.id,/^N/,'Live-Bestellnummern beginnen mit N');
  await request(admin,{token:t,body:{action:'settings',set:{orderingMode:'whatsapp'}}});
  assert.equal((await request(shop,{body:order(),ip:freshIp()})).status,409,'Rückweg wirkt sofort');
 }finally{env.NEBU_ENV='test'}
});

test('live environment ignores the test customer key and old test secrets',async()=>{
 const {config}=await import('../netlify/lib/core.mjs');
 env.NEBU_ENV='live';env.NEBU_TEST_CUSTOMER_KEY='k';env.NEBU_TEST_SESSION_SECRET='x'.repeat(40);const s=env.NEBU_SESSION_SECRET;delete env.NEBU_SESSION_SECRET;
 try{assert.equal(config.testCustomerKey,'');assert.equal(config.sessionSecret,'')}
 finally{env.NEBU_ENV='test';env.NEBU_SESSION_SECRET=s;delete env.NEBU_TEST_CUSTOMER_KEY;delete env.NEBU_TEST_SESSION_SECRET}
});

test('staff list shows open orders and only the last 24 h of closed ones',async()=>{
 const t=await staff();const a=await place(),b=await place();
 await db.query("UPDATE nebu_orders SET status='rejected', closed_at=now()-interval '2 days' WHERE id=$1",[a.order.id]);
 const ids=(await get(t)).map(o=>o.id);
 assert.ok(ids.includes(b.order.id));assert.ok(!ids.includes(a.order.id));
});

test('new staff push device receives new-order notifications; stale endpoints are removed',async()=>{
 const t=await staff();
 const {default:reg}=await import('../netlify/functions/push-register.mjs');
 await request(reg,{token:t,body:{endpoint:'https://push.example/kasse',keys:{p256dh:'a',auth:'b'}}});
 await request(reg,{token:t,body:{endpoint:'https://push.example/gone',keys:{p256dh:'a',auth:'b'}}});
 await place();
 assert.ok(pushes.some(p=>p.endpoint==='https://push.example/kasse'&&/Neue Test-Bestellung/.test(p.payload.title)));
 assert.equal((await db.query("SELECT count(*)::int n FROM nebu_push_subscriptions WHERE endpoint LIKE '%gone'")).rows[0].n,0);
});
