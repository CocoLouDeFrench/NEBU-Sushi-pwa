import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db,migrate,reset,shutdown,request,freshIp} from './pg-harness.mjs';
const {default:login}=await import('../netlify/functions/staff-login.mjs');
const {default:admin}=await import('../netlify/functions/staff-admin.mjs');
const {default:shop}=await import('../netlify/functions/shop-api.mjs');
const {runRetention}=await import('../netlify/functions/order-retention.mjs');
const {tx}=await import('../netlify/lib/core.mjs');

before(async()=>{
 // Alte Test-Tabelle mit Altdaten anlegen, dann migrieren: Übernahme prüfen.
 await db.query("CREATE TABLE nebu_test_order_state (id integer PRIMARY KEY, orders jsonb NOT NULL DEFAULT '[]', migrated boolean NOT NULL DEFAULT false)");
 await db.query("INSERT INTO nebu_test_order_state VALUES (1,$1,true)",[JSON.stringify([{id:'TOLD1',requestId:'r-1',customerToken:'secret-token',status:'picked_up',fulfillment:'pickup',version:4,customer:'Alt Kunde',phone:'0211',items:[{name:'X',qty:1,price:5}],total:5,createdAt:'2026-11-18T10:00:00Z',updatedAt:'2026-11-18T11:00:00Z',kitchenPrint:{status:'printed'}}])]);
 await migrate();
});
after(shutdown);

test('legacy single-row test data is migrated; plaintext customer tokens are not',async()=>{
 const r=(await db.query("SELECT * FROM nebu_orders WHERE id='TOLD1'")).rows[0];
 assert.equal(r.status,'picked_up');assert.equal(r.version,4);assert.ok(r.closed_at);
 assert.equal(r.token_hash,null);assert.equal(r.data.customerToken,undefined);
 assert.equal(r.kitchen_print.status,'printed');
 await migrate();assert.equal((await db.query("SELECT count(*)::int n FROM nebu_orders WHERE id='TOLD1'")).rows[0].n,1,'Migration wiederholbar');
});

test('retention off (default): order data untouched, technical cleanup still runs',async()=>{
 await reset();
 const o=(await request(shop,{body:{action:'create',requestId:crypto.randomUUID(),customer:'Anna',phone:'0211 1234567',fulfillment:'pickup',cart:[{id:'p017',qty:1}]},ip:freshIp()})).order;
 await db.query("UPDATE nebu_orders SET status='picked_up', closed_at=now()-interval '90 days', token_expires_at=now()-interval '1 day' WHERE id=$1",[o.id]);
 const out=await tx(runRetention);
 assert.equal(out.anonymized,null);assert.equal(out.tokens,1);
 const row=(await db.query('SELECT data,token_hash,anonymized_at FROM nebu_orders WHERE id=$1',[o.id])).rows[0];
 assert.equal(row.data.customer,'Anna');assert.equal(row.anonymized_at,null);assert.equal(row.token_hash,null);
});

test('retention on: personal data of old closed orders anonymized, bookkeeping data kept, open orders untouched',async()=>{
 await reset();
 await request(admin,{body:{action:'bootstrap',setupCode:'setup-code-0123456789',name:'Toto',pin:'482915'},ip:freshIp()});
 const t=(await request(login,{body:{action:'login',name:'Toto',pin:'482915'},ip:freshIp()})).token;
 assert.equal((await request(admin,{token:t,body:{action:'settings',set:{retention:{enabled:true,personalDataDays:3}}}})).status,422,'mind. 7 Tage');
 await request(admin,{token:t,body:{action:'settings',set:{retention:{enabled:true,personalDataDays:30}}}});
 const mk=async()=>(await request(shop,{body:{action:'create',requestId:crypto.randomUUID(),customer:'Anna',phone:'0211 1234567',email:'a@b.de',notes:'Klingel kaputt',fulfillment:'pickup',cart:[{id:'p017',qty:2}]},ip:freshIp()})).order;
 const old=await mk(),recent=await mk(),open=await mk();
 await db.query("UPDATE nebu_orders SET status='picked_up', closed_at=now()-interval '31 days' WHERE id=$1",[old.id]);
 await db.query("UPDATE nebu_orders SET status='picked_up', closed_at=now()-interval '5 days' WHERE id=$1",[recent.id]);
 await db.query("UPDATE nebu_orders SET created_at=now()-interval '60 days' WHERE id=$1",[open.id]);
 assert.equal((await request(admin,{token:t,body:{action:'retention-preview'}})).due,1);
 assert.equal((await tx(runRetention)).anonymized,1);
 const rows=Object.fromEntries((await db.query('SELECT id,data,anonymized_at,phone_key FROM nebu_orders')).rows.map(r=>[r.id,r]));
 const a=rows[old.id];
 assert.equal(a.data.customer,'(anonymisiert)');for(const f of ['phone','email','notes','address'])assert.equal(a.data[f],undefined,f);
 assert.equal(a.phone_key,null);assert.equal(a.data.total,13);assert.equal(a.data.items[0].qty,2);
 assert.equal(rows[recent.id].data.customer,'Anna');assert.equal(rows[open.id].data.customer,'Anna','offene Bestellung bleibt');
 assert.ok((await db.query("SELECT 1 FROM nebu_audit WHERE action='retention_run'")).rows.length);
});
