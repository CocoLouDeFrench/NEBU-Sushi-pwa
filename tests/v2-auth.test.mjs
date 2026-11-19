import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db,migrate,reset,shutdown,request,freshIp} from './pg-harness.mjs';
const {default:login}=await import('../netlify/functions/staff-login.mjs');
const {default:admin}=await import('../netlify/functions/staff-admin.mjs');
const {default:orders}=await import('../netlify/functions/nebu-orders.mjs');
before(migrate);after(shutdown);beforeEach(reset);

export async function setupOwner(){
 assert.equal((await request(admin,{body:{action:'bootstrap',setupCode:'setup-code-0123456789',name:'Toto',pin:'482915'},ip:freshIp()})).status,201);
 const s=await request(login,{body:{action:'login',name:'toto',pin:'482915',device:'Kassen-PC'},ip:freshIp()});
 assert.equal(s.status,200);return s;
}

test('bootstrap only with setup code, only once',async()=>{
 assert.equal((await request(admin,{body:{action:'bootstrap',setupCode:'falsch',name:'X Y',pin:'482915'},ip:freshIp()})).status,403);
 await setupOwner();
 assert.equal((await request(admin,{body:{action:'bootstrap',setupCode:'setup-code-0123456789',name:'Zweiter',pin:'482916'},ip:freshIp()})).status,409);
});

test('weak PINs and duplicate names are rejected',async()=>{
 const o=await setupOwner();
 for(const pin of ['111111','123456','987654','12345'])assert.equal((await request(admin,{token:o.token,body:{action:'create',name:'Mia',role:'staff',pin}})).status,422,pin);
 assert.equal((await request(admin,{token:o.token,body:{action:'create',name:'Mia',role:'staff',pin:'830194'}})).status,201);
 assert.equal((await request(admin,{token:o.token,body:{action:'create',name:' mia ',role:'staff',pin:'830195'}})).status,409);
});

test('login: generic error, lockout after 5 wrong PINs, PIN stored only as hash',async()=>{
 const o=await setupOwner();
 await request(admin,{token:o.token,body:{action:'create',name:'Mia',role:'staff',pin:'830194'}});
 const ip=freshIp();
 const unknown=await request(login,{body:{action:'login',name:'Niemand',pin:'830194'},ip});
 const wrong=await request(login,{body:{action:'login',name:'Mia',pin:'000001'},ip});
 assert.equal(unknown.error,wrong.error,'kein Hinweis, ob der Name existiert');
 for(let i=0;i<4;i++)await request(login,{body:{action:'login',name:'Mia',pin:'000002'},ip:freshIp()});
 const locked=await request(login,{body:{action:'login',name:'Mia',pin:'830194'},ip:freshIp()});
 assert.equal(locked.status,429,'nach 5 Fehlversuchen gesperrt – auch mit richtiger PIN');
 const row=(await db.query("SELECT pin_hash FROM nebu_staff WHERE name='Mia'")).rows[0];
 assert.match(row.pin_hash,/^pbkdf2-sha256\$210000\$/);assert.ok(!row.pin_hash.includes('830194'));
 // Inhaber setzt neue PIN → Sperre aufgehoben.
 const id=(await db.query("SELECT id FROM nebu_staff WHERE name='Mia'")).rows[0].id;
 await request(admin,{token:o.token,body:{action:'update',id,pin:'592047'}});
 assert.equal((await request(login,{body:{action:'login',name:'Mia',pin:'592047'},ip:freshIp()})).status,200);
});

test('IP throttle is atomic under parallel attempts',async()=>{
 await setupOwner();
 const ip=freshIp();
 const results=await Promise.all(Array.from({length:30},(_,i)=>request(login,{body:{action:'login',name:'Gast'+i,pin:'000000'},ip})));
 assert.equal(results.filter(r=>r.status===429).length,10,'genau 20 Versuche erlaubt, Rest gesperrt');
});

test('revoking a device ends access and renewal immediately',async()=>{
 const o=await setupOwner();
 await request(admin,{token:o.token,body:{action:'create',name:'Mia',role:'staff',pin:'830194'}});
 const mia=await request(login,{body:{action:'login',name:'Mia',pin:'830194',device:'iPhone'},ip:freshIp()});
 assert.equal((await request(orders,{method:'GET',token:mia.token})).status,200);
 const list=await request(admin,{token:o.token,body:{action:'list'}});
 const sid=list.sessions.find(s=>s.name==='Mia').id;
 assert.equal((await request(admin,{token:o.token,body:{action:'revoke',sessionId:sid}})).revoked,1);
 assert.equal((await request(orders,{method:'GET',token:mia.token})).status,403,'Zugang sofort weg');
 assert.equal((await request(login,{body:{action:'renew',refreshToken:mia.refreshToken}})).status,403,'Verlängerung weg');
 const log=await request(admin,{token:o.token,body:{action:'audit'}});
 assert.ok(log.entries.some(e=>e.action==='session_revoke'&&e.staff_name==='Toto'));
});

test('deactivated staff and changed PIN log out all devices; staff cannot use owner functions',async()=>{
 const o=await setupOwner();
 const created=await request(admin,{token:o.token,body:{action:'create',name:'Ben',role:'staff',pin:'830194'}});
 const ben=await request(login,{body:{action:'login',name:'Ben',pin:'830194'},ip:freshIp()});
 assert.equal((await request(admin,{token:ben.token,body:{action:'list'}})).status,403,'Mitarbeiter ≠ Inhaber');
 await request(admin,{token:o.token,body:{action:'update',id:created.staff.id,active:false}});
 assert.equal((await request(orders,{method:'GET',token:ben.token})).status,403);
 assert.equal((await request(login,{body:{action:'login',name:'Ben',pin:'830194'},ip:freshIp()})).status,403);
});

test('last active owner cannot be removed',async()=>{
 const o=await setupOwner();
 const id=(await db.query("SELECT id FROM nebu_staff WHERE role='owner'")).rows[0].id;
 assert.equal((await request(admin,{token:o.token,body:{action:'update',id,active:false}})).status,409);
 assert.equal((await request(admin,{token:o.token,body:{action:'update',id,role:'staff'}})).status,409);
});

test('renew keeps the shift end; logout revokes; forged/expired tokens fail',async()=>{
 const o=await setupOwner();
 const r=await request(login,{body:{action:'renew',refreshToken:o.refreshToken}});
 assert.equal(r.status,200);assert.equal(r.sessionEndsAt,o.sessionEndsAt);assert.equal(r.staff.name,'Toto');
 assert.equal((await request(login,{body:{action:'renew',refreshToken:o.token}})).status,403,'Zugangstoken taugt nicht zum Verlängern');
 assert.equal((await request(orders,{method:'GET',token:o.refreshToken})).status,403,'Verlängerungs-Token taugt nicht als Zugang');
 const [p,sig]=o.token.split('.');
 const forged=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(p,'base64url')),exp:9999999999})).toString('base64url')+'.'+sig;
 assert.equal((await request(orders,{method:'GET',token:forged})).status,403);
 await db.query("UPDATE nebu_staff_sessions SET expires_at=now()-interval '1 second'");
 assert.equal((await request(orders,{method:'GET',token:r.token})).status,403,'Schichtende');
 const fresh=await request(login,{body:{action:'login',name:'Toto',pin:'482915'},ip:freshIp()});
 await request(login,{body:{action:'logout',refreshToken:fresh.refreshToken}});
 assert.equal((await request(orders,{method:'GET',token:fresh.token})).status,403);
});

test('old shared-code login is refused with a clear message',async()=>{
 const r=await request(login,{body:{key:'irgendwas'}});
 assert.equal(r.status,400);assert.match(r.error,/Name und PIN/);
});
