import test from 'node:test';
import assert from 'node:assert/strict';
import {issueStaffSession,verifyStaffSession} from '../netlify/functions/nebu-staff-session.mjs';
const secret='test-only-long-session-secret-12345678901234567890';
const other='another-long-session-secret-12345678901234567890';
test('issued token is accepted only with its signing secret',async()=>{
 const token=await issueStaffSession(secret);
 assert.ok(await verifyStaffSession(token,secret));
 assert.equal(await verifyStaffSession(token,other),false);
});
test('tampering and malformed tokens are rejected',async()=>{
 const token=await issueStaffSession(secret);
 assert.equal(await verifyStaffSession(token+'x',secret),false);
 assert.equal(await verifyStaffSession('not-a-token',secret),false);
 assert.equal(await verifyStaffSession('',secret),false);
 assert.equal(await verifyStaffSession('a'.repeat(3000),secret),false);
 const [payload,signature]=token.split('.');
 const changed=JSON.parse(Buffer.from(payload,'base64url').toString());
 changed.scope='nebu-admin';
 assert.equal(await verifyStaffSession(Buffer.from(JSON.stringify(changed)).toString('base64url')+'.'+signature,secret),false);
});
test('weak secrets are rejected',async()=>{
 await assert.rejects(issueStaffSession('short'));
 assert.equal(await verifyStaffSession('abc.def','short'),false);
});
test('session renewal keeps the original login time and ends after the shift limit',async t=>{
 const {SHIFT_SECONDS}=await import('../netlify/functions/nebu-staff-session.mjs');
 const realNow=Date.now;let now=Date.UTC(2026,10,19,8,0,0);Date.now=()=>now;
 t.after(()=>{Date.now=realNow});
 const first=await issueStaffSession(secret);
 const v1=await verifyStaffSession(first,secret);assert.ok(v1);
 now+=25*60*1000;
 const renewed=await issueStaffSession(secret,{authTime:v1.auth});
 const v2=await verifyStaffSession(renewed,secret);assert.equal(v2.auth,v1.auth);assert.ok(v2.exp>v1.exp);
 // Kurz vor Schichtende endet der Token spätestens zum Schichtende.
 now=(v1.auth+SHIFT_SECONDS-600)*1000;
 const late=await issueStaffSession(secret,{authTime:v1.auth});
 const v3=await verifyStaffSession(late,secret);assert.equal(v3.exp,v1.auth+SHIFT_SECONDS);
 now=(v1.auth+SHIFT_SECONDS+1)*1000;
 assert.equal(await verifyStaffSession(late,secret),false);
 // Eine gefälschte, in der Zukunft liegende Anmeldezeit wird nicht übernommen.
 const forged=await issueStaffSession(secret,{authTime:Math.floor(now/1000)+9999});
 assert.equal((await verifyStaffSession(forged,secret)).auth,Math.floor(now/1000));
});
