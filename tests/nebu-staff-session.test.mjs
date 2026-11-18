import test from 'node:test';
import assert from 'node:assert/strict';
import {issueStaffSession,verifyStaffSession} from '../netlify/functions/nebu-staff-session.mjs';
const secret='test-only-long-session-secret-12345678901234567890';
const other='another-long-session-secret-12345678901234567890';
test('issued token is accepted only with its signing secret',async()=>{
 const token=await issueStaffSession(secret);
 assert.equal(await verifyStaffSession(token,secret),true);
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
