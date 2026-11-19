// Gemeinsame Bausteine: Konfiguration, HTTP-Antworten, Datenbank, sichere Protokollierung, Drosselung, Audit.
import {getDatabase} from '@netlify/database';

// ---------- Konfiguration (Test und Live getrennt über Netlify-Umgebungsvariablen) ----------
const env=name=>{try{return Netlify.env.get(name)||''}catch{return process.env[name]||''}};
export const config={
 get environment(){return env('NEBU_ENV')==='live'?'live':'test'},
 // Neue Namen; die alten NEBU_TEST_*-Namen gelten nur im Testprojekt weiter.
 get sessionSecret(){return env('NEBU_SESSION_SECRET')||(this.environment==='test'?env('NEBU_TEST_SESSION_SECRET'):'')},
 get ownerSetupCode(){return env('NEBU_OWNER_SETUP_CODE')},
 get printAgentToken(){return env('NEBU_PRINT_AGENT_TOKEN')},
 get vapidPublic(){return env('NEBU_VAPID_PUBLIC')},
 get vapidPrivate(){return env('NEBU_VAPID_PRIVATE')},
 get vapidContact(){return env('NEBU_VAPID_CONTACT')||'mailto:info@nebusushi.com'},
 // Nur im Testprojekt: Schlüssel für automatisierte Testbestellungen ohne Drosselung.
 get testCustomerKey(){return this.environment==='test'?env('NEBU_TEST_CUSTOMER_KEY'):''}
};

// ---------- HTTP ----------
export const SECURITY_HEADERS={'cache-control':'no-store, private','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{...SECURITY_HEADERS,...extra}});
export async function readJson(req,max=32768){
 const declared=Number(req.headers.get('content-length')||0);
 if(declared>max)return {error:json({error:'Anfrage zu groß'},413)};
 let raw;try{raw=await req.text()}catch{return {error:json({error:'Ungültige Anfrage'},400)}}
 if(raw.length>max)return {error:json({error:'Anfrage zu groß'},413)};
 let body;try{body=JSON.parse(raw||'{}')}catch{return {error:json({error:'Ungültige JSON-Anfrage'},400)}}
 if(!body||typeof body!=='object'||Array.isArray(body))return {error:json({error:'Ungültige Anfrage'},400)};
 return {body};
}
export const clientIp=req=>req.headers.get('x-nf-client-connection-ip')||'';
export const sha256=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');

// Protokolle: nie Anfrage-Inhalte, Kundendaten oder Tokens – nur Ort und Fehlerart.
export function logError(where,error){
 const msg=String(error?.message||error||'').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g,'[E-Mail]').replace(/\+?\d[\d\s()/-]{6,}\d/g,'[Nummer]').slice(0,200);
 console.error('[NEBU] '+where+': '+(error?.code?error.code+' ':'')+msg);
}

// ---------- Datenbank ----------
let poolOverride=null;
export const setPoolForTests=p=>{poolOverride=p};
export const pool=()=>poolOverride||getDatabase().pool;
export async function tx(fn){
 const client=await pool().connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}
 catch(e){try{await client.query('ROLLBACK')}catch{}throw e}
 finally{client.release()}
}

// ---------- Atomare Drosselung (Postgres) ----------
// Liefert true, wenn das Limit überschritten ist. Fenster: fest, z. B. 15 Minuten.
export async function rateLimited(bucket,{limit,windowSeconds}){
 const windowStart=new Date(Math.floor(Date.now()/1000/windowSeconds)*windowSeconds*1000);
 const r=await pool().query('INSERT INTO nebu_rate_limits (bucket, window_start, count) VALUES ($1,$2,1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = nebu_rate_limits.count + 1 RETURNING count',[bucket,windowStart]);
 if(Math.random()<0.02)pool().query("DELETE FROM nebu_rate_limits WHERE window_start < now() - interval '2 days'").catch(()=>{});
 return r.rows[0].count>limit;
}
export async function rateCount(bucket,windowSeconds){
 const windowStart=new Date(Math.floor(Date.now()/1000/windowSeconds)*windowSeconds*1000);
 const r=await pool().query('SELECT count FROM nebu_rate_limits WHERE bucket=$1 AND window_start=$2',[bucket,windowStart]);
 return r.rows[0]?.count||0;
}

// ---------- Änderungsprotokoll ----------
export async function audit(db,{staff,action,orderId=null,detail=null}){
 await db.query('INSERT INTO nebu_audit (staff_id, staff_name, action, order_id, detail) VALUES ($1,$2,$3,$4,$5)',[staff?.id||null,staff?.name||null,action,orderId,detail?JSON.stringify(detail):null]);
}

// ---------- Einstellungen ----------
export const DEFAULT_SETTINGS={
 orderingMode:'whatsapp',          // 'online' = Shop bestellt über NEBU; 'whatsapp' = bisheriger Weg (Rückweg)
 retention:{enabled:false,personalDataDays:30},
 disabledProducts:[]
};
export async function getSetting(key,db=pool()){
 const r=await db.query('SELECT value FROM nebu_settings WHERE key=$1',[key]);
 return r.rows[0]?r.rows[0].value:structuredClone(DEFAULT_SETTINGS[key]);
}
export async function setSetting(db,key,value,by){
 await db.query('INSERT INTO nebu_settings (key,value,updated_at,updated_by) VALUES ($1,$2,now(),$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by',[key,JSON.stringify(value),by||null]);
}
