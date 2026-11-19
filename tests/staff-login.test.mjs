import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {blobs} from './payment-harness.mjs';
mock.module('@netlify/blobs',{namedExports:blobs});
const SECRET='test-only-long-session-secret-12345678901234567890';
globalThis.Netlify={env:{get:k=>({NEBU_TEST_SESSION_SECRET:SECRET,NEBU_TEST_ADMIN_KEY:'richtig'})[k]}};
const {default:login}=await import('../netlify/functions/staff-login.mjs');
const {verifyStaffSession}=await import('../netlify/functions/nebu-staff-session.mjs');
const call=(body,headers={})=>login(new Request('https://x/',{method:'POST',headers:{'x-nf-client-connection-ip':'1.2.3.4',...headers},body:JSON.stringify(body)}));
test('renewal needs a valid session, keeps login time, never needs the code',async()=>{
 const first=await (await call({key:'richtig'})).json();assert.ok(first.token);assert.ok(first.sessionEndsAt);
 const r=await call({renew:true},{authorization:'Bearer '+first.token});assert.equal(r.status,200);
 const renewed=await r.json();assert.notEqual(renewed.token,first.token);assert.equal(renewed.sessionEndsAt,first.sessionEndsAt);
 assert.equal((await verifyStaffSession(renewed.token,SECRET)).auth,(await verifyStaffSession(first.token,SECRET)).auth);
 assert.equal((await call({renew:true},{authorization:'Bearer kaputt.token'})).status,403);
 assert.equal((await call({key:'falsch'})).status,403);
});
