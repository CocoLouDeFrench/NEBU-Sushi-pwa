// NEBU Control · automatischer Küchendruck (nur Testbranch).
// Der lokale Windows-Druckdienst holt hier angenommene Bestellungen ab (Pull-Modell,
// keine eingehende Verbindung zum Restaurant-PC nötig) und bestätigt jeden Druck.
//
// Schutz vor Doppeldruck:
//  1. Jede Annahme erzeugt genau einen Druckauftrag (kitchenPrint.jobId) in derselben
//     gesperrten Datenbanktransaktion wie der Statuswechsel.
//  2. claim vergibt einen Auftrag mit Lease (Sperrfrist); nur abgelaufene Leases werden neu vergeben.
//  3. ack 'printed' ist idempotent; der Druckdienst führt zusätzlich ein lokales Journal.
// Der Druckdienst-Token (NEBU_PRINT_AGENT_TOKEN) ist getrennt vom Mitarbeiterzugang.
import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';

const json=(x,s=200)=>Response.json(x,{status:s,headers:{'cache-control':'no-store, private','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const enc=new TextEncoder();
const digest=async v=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(String(v))));
const sameSecret=async(a,b)=>{const x=await digest(a),y=await digest(b);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0};

export const LEASE_MS=120000;
export const MAX_JOBS_PER_CLAIM=5;
export const KITCHEN_STATES=['accepted','preparing'];
const OPEN=['queued','claimed'];
const text=(v,max)=>String(v??'').slice(0,max);

export const ticketFor=o=>({
 id:text(o.id,40),fulfillment:o.fulfillment==='pickup'?'pickup':'delivery',customer:text(o.customer,80),
 items:(Array.isArray(o.items)?o.items:[]).slice(0,80).map(i=>({qty:Number.isInteger(i?.qty)?i.qty:1,name:text(i?.name,120)})),
 notes:text(o.notes,500),eta:Number.isInteger(o.eta)?o.eta:null,createdAt:o.createdAt||null,acceptedAt:o.acceptedAt||null,deliveryDueAt:o.deliveryDueAt||null
});
export const retryDelayMs=attempts=>Math.min(60000,5000*2**Math.max(0,attempts-1));

export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const expected=Netlify.env.get('NEBU_PRINT_AGENT_TOKEN');
 if(!expected||expected.length<32)return json({error:'Druckdienst noch nicht konfiguriert'},503);
 const auth=req.headers.get('authorization')||'';
 if(!auth.startsWith('Bearer ')||!await sameSecret(auth.slice(7),expected))return json({error:'Zugang verweigert'},403);
 let body;
 try{const raw=await req.text();if(raw.length>4096)return json({error:'Anfrage zu groß'},413);body=JSON.parse(raw)}catch{return json({error:'Ungültige JSON-Anfrage'},400)}
 if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Ungültige Anfrage'},400);
 const agentId=text(body.agentId,60)||'unbekannt';
 if(!['claim','ack'].includes(body.action))return json({error:'Ungültige Aktion'},400);
 if(body.action==='ack'&&(typeof body.jobId!=='string'||body.jobId.length>80||typeof body.orderId!=='string'||body.orderId.length>80||!['printed','failed','unconfirmed'].includes(body.result)))return json({error:'Ungültige Druckbestätigung'},422);

 if(body.action==='claim'){
  // Lebenszeichen für die Anzeige „Druckdienst online“ in NEBU Control.
  try{await getStore('nebu-print-agent').setJSON('heartbeat',{lastSeenAt:new Date().toISOString(),agentId,printerOk:body.printer?.ok===true,printerDetail:text(body.printer?.detail,160),version:text(body.version,20)})}catch(e){console.error('Print heartbeat',e.message)}
 }

 const db=getDatabase();let client=null;
 try{
  client=await db.pool.connect();
  await client.query('BEGIN');
  const res=await client.query('SELECT orders, migrated FROM nebu_test_order_state WHERE id = 1 FOR UPDATE');
  if(res.rows.length!==1||!res.rows[0].migrated)throw Error('NEBU test orders not migrated');
  const orders=res.rows[0].orders;
  const now=Date.now(),nowIso=new Date(now).toISOString();
  let changed=false;const out={};

  if(body.action==='claim'){
   const jobs=[];let waiting=0;const printerReady=body.printer&&typeof body.printer.ok==='boolean'?body.printer.ok:undefined;
   for(const o of orders){
    const k=o.kitchenPrint;if(!k||!OPEN.includes(k.status))continue;
    // Bon nur, solange die Bestellung in der Küche ist. Sonst sichtbar überspringen statt Altbon zu drucken.
    if(!KITCHEN_STATES.includes(o.status)){k.status='skipped';k.skippedAt=nowIso;k.reason='Bestellung war beim Druck nicht mehr in der Küche';changed=true;continue}
    if(jobs.length>=MAX_JOBS_PER_CLAIM)continue;
    // Drucker meldet „nicht bereit“: Auftrag NICHT vergeben – er bleibt gespeichert und geht raus,
    // sobald der Drucker wieder bereit ist (keine unnötigen Fehlversuche, kein wachsender Wartezeit-Abstand).
    if(printerReady===false){waiting++;continue}
    const leaseExpired=k.status==='claimed'&&!(Date.parse(k.leaseUntil)>now);
    // Drucker gerade wieder bereit geworden → wartende Aufträge sofort, ohne Backoff.
    const due=k.status==='queued'&&(body.retryNow===true||!(Date.parse(k.nextAttemptAt)>now));
    if(!leaseExpired&&!due)continue;
    k.status='claimed';k.claimedAt=nowIso;k.leaseUntil=new Date(now+LEASE_MS).toISOString();k.attempts=(k.attempts||0)+1;k.agentId=agentId;changed=true;
    jobs.push({jobId:k.jobId,orderId:o.id,attempt:k.attempts,ticket:ticketFor(o)});
   }
   // Älteste zuerst drucken.
   jobs.sort((a,b)=>(Date.parse(a.ticket.acceptedAt)||0)-(Date.parse(b.ticket.acceptedAt)||0));
   out.jobs=jobs;out.waiting=waiting;
  }else{
   const o=orders.find(x=>x.id===body.orderId);const k=o?.kitchenPrint;
   if(!k||k.jobId!==body.jobId){out.ok=false;out.unknown=true}
   else if(k.status==='printed'){out.ok=true;out.alreadyPrinted=true}
   else if(body.result==='printed'){k.status='printed';k.printedAt=nowIso;k.agentId=agentId;delete k.leaseUntil;delete k.nextAttemptAt;delete k.lastError;changed=true;out.ok=true}
   // Daten sind beim Drucker, Druck aber nicht bestätigt: NICHT erneut vergeben (Doppeldruck-Schutz), Personal prüft.
   else if(body.result==='unconfirmed'){k.status='unconfirmed';k.sentAt=nowIso;k.agentId=agentId;k.lastError=text(body.error,200)||'Druck nicht bestätigt';delete k.leaseUntil;delete k.nextAttemptAt;changed=true;out.ok=true}
   else if(k.status==='skipped'){out.ok=true}
   else{k.status='queued';k.lastError=text(body.error,200)||'Druckfehler';k.lastErrorAt=nowIso;k.nextAttemptAt=new Date(now+retryDelayMs(k.attempts||1)).toISOString();delete k.leaseUntil;changed=true;out.ok=true;out.retryAt=k.nextAttemptAt}
  }

  if(changed)await client.query('UPDATE nebu_test_order_state SET orders = $1::jsonb, migrated = TRUE WHERE id = 1',[JSON.stringify(orders)]);
  await client.query(changed?'COMMIT':'ROLLBACK');client.release();client=null;
  return json(out);
 }catch(e){console.error('Kitchen print',e.message);return json({error:'Testserver-Fehler'},500)}
 finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}}
};
