// Test-Hilfe: echte PostgreSQL-Instanz (embedded-postgres), Migrationen, Netlify-Umgebung, Push-Attrappe.
// Einmalig: npm i --no-save embedded-postgres pg jsdom@24
import {mock} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export const env={NEBU_ENV:'test',NEBU_SESSION_SECRET:'test-only-session-secret-0123456789abcdef',NEBU_OWNER_SETUP_CODE:'setup-code-0123456789',NEBU_PRINT_AGENT_TOKEN:'test-only-print-agent-token-abcdefghijklmnopqrstuvwxyz',NEBU_VAPID_PUBLIC:'pub',NEBU_VAPID_PRIVATE:'priv'};
globalThis.Netlify={env:{get:k=>env[k]}};
export const pushes=[];
// Bisheriger Shop-Admin (Blob nebu-sushi-state): im Test steuerbar.
export const shopAdmin={state:{statusMode:'open',prepTime:'ca. 35 Minuten',soldOut:[]}};
mock.module('@netlify/blobs',{namedExports:{getStore:()=>({get:async()=>shopAdmin.state,setJSON:async()=>{},set:async()=>{}})}});
mock.module('web-push',{defaultExport:{setVapidDetails(){},sendNotification:async(sub,payload)=>{pushes.push({endpoint:sub.endpoint,payload:JSON.parse(payload)});if(sub.endpoint.includes('gone'))throw Object.assign(Error('gone'),{statusCode:410})}}});
mock.module(new URL('../netlify/functions/delivery-check.mjs',import.meta.url).href,{namedExports:{checkAddress:async a=>/außerhalb/.test(a)?{eligible:false,message:'Außerhalb des Liefergebiets'}:{eligible:true,minimum:15,fee:2.5,km:1.2}}});

const dir=fs.mkdtempSync(path.join('/tmp/pgdata','db-'));fs.chmodSync(dir,0o777);
const port=50000+Math.floor(Math.random()*10000);
const ep=new EmbeddedPostgres({databaseDir:path.join(dir,'data'),user:'postgres',password:'pw',port,persistent:false,onLog:()=>{},onError:()=>{}});
await ep.initialise();await ep.start();
export const db=new pg.Pool({host:'127.0.0.1',port,user:'postgres',password:'pw',database:'postgres',max:20});
db.on('error',()=>{});
const core=await import('../netlify/lib/core.mjs');
core.setPoolForTests(db);
const migrations=path.join(path.dirname(new URL(import.meta.url).pathname),'../netlify/database/migrations');
export async function migrate(){for(const f of fs.readdirSync(migrations).sort())await db.query(fs.readFileSync(path.join(migrations,f),'utf8'))}
export async function reset(){
 await db.query('TRUNCATE nebu_audit, nebu_rate_limits, nebu_push_subscriptions, nebu_settings, nebu_staff_sessions, nebu_staff, nebu_orders CASCADE');
 pushes.length=0;shopAdmin.state={statusMode:'open',prepTime:'ca. 35 Minuten',soldOut:[]};
}
export async function shutdown(){await db.end();await ep.stop()}

// HTTP-Helfer
let ipCounter=1;
export const freshIp=()=>'10.0.'+Math.floor(ipCounter/250)+'.'+(ipCounter++%250);
export function request(handler,{method='POST',body,token,ip='10.9.9.9',headers={}}={}){
 const h={'content-type':'application/json','x-nf-client-connection-ip':ip,...headers};if(token)h.authorization='Bearer '+token;
 return handler(new Request('https://nebu.test/',{method,headers:h,body:method==='GET'?undefined:JSON.stringify(body||{})})).then(async r=>({status:r.status,...(await r.json().catch(()=>({})))}));
}
