import {getStore} from '@netlify/blobs';
import {issueStaffSession} from './nebu-staff-session.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store, private','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
export default async req=>{
 if(req.method!=='POST')return reply({error:'Methode nicht erlaubt'},405);
 const secret=Netlify.env.get('NEBU_TEST_SESSION_SECRET');
 const adminKey=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
 if(!secret||secret.length<32||!adminKey)return reply({error:'Sitzungsanmeldung noch nicht konfiguriert'},503);
 const ip=req.headers.get('x-nf-client-connection-ip');
 if(!ip)return reply({error:'Anmeldung derzeit nicht verfügbar'},503);
 // Test-only best-effort throttle. Netlify Blobs read/modify/write is NOT atomic.
 // Must be replaced with transactional/edge rate limiting before production.
 const store=getStore('nebu-test-login-limits');
 const bucket='login-'+await digest(ip+'|'+secret);
 let attempts;
 try{
  const now=Date.now();
  const saved=await store.get(bucket,{type:'json'});
  attempts=(Array.isArray(saved)?saved:[]).filter(t=>Number.isFinite(t)&&t<=now&&now-t<15*60*1000);
  if(attempts.length>=5)return reply({error:'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.'},429);
 }catch{return reply({error:'Anmeldung vorübergehend nicht verfügbar'},503)}
 let body;try{const raw=await req.text();if(raw.length>2048)return reply({error:'Anfrage zu groß'},413);body=JSON.parse(raw)}catch{return reply({error:'Ungültige Anfrage'},400)}
 if(!body||typeof body.key!=='string'||body.key.length>256||body.key!==adminKey){
  try{await store.setJSON(bucket,[...attempts,Date.now()])}catch{return reply({error:'Anmeldung vorübergehend nicht verfügbar'},503)}
  return reply({error:'Zugang verweigert'},403);
 }
 const token=await issueStaffSession(secret);
 return reply({token,expiresInSeconds:1800});
};
