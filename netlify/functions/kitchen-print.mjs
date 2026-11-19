// NEBU Control · automatischer Küchendruck.
// Der lokale Windows-Druckdienst holt hier angenommene Bestellungen ab (Pull-Modell,
// keine eingehende Verbindung zum Restaurant-PC nötig) und bestätigt jeden Druck.
//
// Schutz vor Doppeldruck:
//  1. Jede Annahme erzeugt genau einen Druckauftrag (kitchenPrint.jobId) in derselben
//     gesperrten Datenbanktransaktion wie der Statuswechsel.
//  2. claim vergibt einen Auftrag mit Lease (Sperrfrist); nur abgelaufene Leases werden neu vergeben.
//  3. ack 'printed' ist idempotent; der Druckdienst führt zusätzlich ein lokales Journal.
// Der Druckdienst-Token (NEBU_PRINT_AGENT_TOKEN) ist getrennt vom Mitarbeiterzugang; Test und Live haben eigene Tokens.
import {json,readJson,tx,pool,logError,config,setSetting} from '../lib/core.mjs';
import {rowToOrder} from '../lib/orders.mjs';

const enc=new TextEncoder();
const digest=async v=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(String(v))));
const sameSecret=async(a,b)=>{const x=await digest(a),y=await digest(b);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0};

export const LEASE_MS=120000;
export const MAX_JOBS_PER_CLAIM=5;
export const KITCHEN_STATES=['accepted','preparing'];
const text=(v,max)=>String(v??'').slice(0,max);

export const ticketFor=o=>({
 id:text(o.id,40),fulfillment:o.fulfillment==='pickup'?'pickup':'delivery',customer:text(o.customer,80),
 items:(Array.isArray(o.items)?o.items:[]).slice(0,80).map(i=>({qty:Number.isInteger(i?.qty)?i.qty:1,name:text(i?.name,120)})),
 notes:text(o.notes,500),eta:Number.isInteger(o.eta)?o.eta:null,createdAt:o.createdAt||null,acceptedAt:o.acceptedAt||null,deliveryDueAt:o.deliveryDueAt||null
});
export const retryDelayMs=attempts=>Math.min(60000,5000*2**Math.max(0,attempts-1));

export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const expected=config.printAgentToken;
 if(!expected||expected.length<32)return json({error:'Druckdienst noch nicht konfiguriert'},503);
 const auth=req.headers.get('authorization')||'';
 if(!auth.startsWith('Bearer ')||!await sameSecret(auth.slice(7),expected))return json({error:'Zugang verweigert'},403);
 const {body,error}=await readJson(req,4096);if(error)return error;
 const agentId=text(body.agentId,60)||'unbekannt';
 if(!['claim','ack'].includes(body.action))return json({error:'Ungültige Aktion'},400);
 if(body.action==='ack'&&(typeof body.jobId!=='string'||body.jobId.length>80||typeof body.orderId!=='string'||body.orderId.length>80||!['printed','failed','unconfirmed'].includes(body.result)))return json({error:'Ungültige Druckbestätigung'},422);
 try{
  if(body.action==='claim'){
   // Lebenszeichen für die Anzeige „Druckdienst bereit/offline“ in NEBU Control.
   try{await setSetting(pool(),'printAgent',{lastSeenAt:new Date().toISOString(),agentId,printerOk:body.printer?.ok===true,printerDetail:text(body.printer?.detail,160),version:text(body.version,20)},'druckdienst')}catch(e){logError('print heartbeat',e)}
   const printerReady=body.printer&&typeof body.printer.ok==='boolean'?body.printer.ok:undefined;
   return json(await tx(async db=>{
    const now=Date.now(),nowIso=new Date(now).toISOString();
    const rows=(await db.query("SELECT * FROM nebu_orders WHERE kitchen_print IS NOT NULL AND kitchen_print->>'status' IN ('queued','claimed') ORDER BY created_at FOR UPDATE SKIP LOCKED")).rows;
    const jobs=[];let waiting=0;
    for(const row of rows){
     const o=rowToOrder(row);const k=o.kitchenPrint;let changed=false;
     // Bon nur, solange die Bestellung in der Küche ist. Sonst sichtbar überspringen statt Altbon zu drucken.
     if(!KITCHEN_STATES.includes(o.status)){k.status='skipped';k.skippedAt=nowIso;k.reason='Bestellung war beim Druck nicht mehr in der Küche';changed=true}
     else if(jobs.length<MAX_JOBS_PER_CLAIM){
      // Drucker meldet „nicht bereit“: Auftrag NICHT vergeben – bleibt gespeichert, geht raus, sobald der Drucker bereit ist.
      if(printerReady===false)waiting++;
      else{
       const leaseExpired=k.status==='claimed'&&!(Date.parse(k.leaseUntil)>now);
       const due=k.status==='queued'&&(body.retryNow===true||!(Date.parse(k.nextAttemptAt)>now));
       if(leaseExpired||due){k.status='claimed';k.claimedAt=nowIso;k.leaseUntil=new Date(now+LEASE_MS).toISOString();k.attempts=(k.attempts||0)+1;k.agentId=agentId;changed=true;jobs.push({jobId:k.jobId,orderId:o.id,attempt:k.attempts,ticket:ticketFor(o)})}
      }
     }
     // Nur die Druckspalte ändern – Bestellversion bleibt (kein falscher Konflikt für Mitarbeiter).
     if(changed)await db.query('UPDATE nebu_orders SET kitchen_print=$2 WHERE id=$1',[o.id,JSON.stringify(k)]);
    }
    jobs.sort((a,b)=>(Date.parse(a.ticket.acceptedAt)||0)-(Date.parse(b.ticket.acceptedAt)||0));
    return {jobs,waiting};
   }));
  }
  return json(await tx(async db=>{
   const nowIso=new Date().toISOString();
   const row=(await db.query('SELECT id,kitchen_print FROM nebu_orders WHERE id=$1 FOR UPDATE',[body.orderId])).rows[0];
   const k=row?.kitchen_print;const out={};
   if(!k||k.jobId!==body.jobId)return {ok:false,unknown:true};
   if(k.status==='printed')return {ok:true,alreadyPrinted:true};
   if(body.result==='printed'){k.status='printed';k.printedAt=nowIso;k.agentId=agentId;delete k.leaseUntil;delete k.nextAttemptAt;delete k.lastError;out.ok=true}
   // Daten sind beim Drucker, Druck aber nicht bestätigt: NICHT erneut vergeben (Doppeldruck-Schutz), Personal prüft.
   else if(body.result==='unconfirmed'){k.status='unconfirmed';k.sentAt=nowIso;k.agentId=agentId;k.lastError=text(body.error,200)||'Druck nicht bestätigt';delete k.leaseUntil;delete k.nextAttemptAt;out.ok=true}
   else if(k.status==='skipped')return {ok:true};
   else{k.status='queued';k.lastError=text(body.error,200)||'Druckfehler';k.lastErrorAt=nowIso;k.nextAttemptAt=new Date(Date.now()+retryDelayMs(k.attempts||1)).toISOString();delete k.leaseUntil;out.ok=true;out.retryAt=k.nextAttemptAt}
   await db.query('UPDATE nebu_orders SET kitchen_print=$2 WHERE id=$1',[row.id,JSON.stringify(k)]);
   return out;
  }));
 }catch(e){logError('kitchen-print',e);return json({error:'Serverfehler'},500)}
};
