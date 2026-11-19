// Bestelllogik (gemeinsam für öffentliche Shop-API und Mitarbeiter-API).
import webpush from 'web-push';
import {config,pool,sha256,logError} from './core.mjs';

export const FINAL_STATES=['picked_up','delivered','rejected','delivery_failed'];
export const KITCHEN_STATES=['accepted','preparing'];
export const ETA_CHOICES=[30,45,60,75];
export const CUSTOMER_TOKEN_HOURS=48;

export function validatePhone(value){const phone=String(value||'').trim();if(!/^\+?[0-9\s()\/-]+$/.test(phone))return 'Bitte nur Ziffern und übliche Telefonnummern-Zeichen eingeben.';const digits=phone.replace(/\D/g,'');if(digits.length<7||digits.length>15)return 'Bitte eine Telefonnummer mit 7 bis 15 Ziffern eingeben.';if(/^(\d)\1{6,}$/.test(digits)||/^(?:0123456789|1234567890|9876543210|0987654321)/.test(digits))return 'Diese Telefonnummer wirkt ungültig. Bitte überprüfe sie.';if(phone.startsWith('+')&&digits.startsWith('00'))return 'Bitte die Landesvorwahl nur einmal angeben.';if(digits.startsWith('49')){const local=digits.slice(2).replace(/^0/,'');if(!/^1[567]\d{8,9}$/.test(local)&&!/^\d{3,13}$/.test(local))return 'Bitte die deutsche Telefonnummer überprüfen.';}else if(digits.startsWith('0')&&!digits.startsWith('00')){if(!/^01[567]\d{8,9}$/.test(digits)&&!/^0[2-9]\d{5,13}$/.test(digits))return 'Bitte die deutsche Telefonnummer überprüfen.';}return ''}
export const phoneKey=phone=>String(phone||'').replace(/\D/g,'').replace(/^49(?=1[567])/,'0').replace(/^0049/,'0');
export const addressKey=value=>String(value||'').toLocaleLowerCase('de-DE').normalize('NFKC').replace(/straße|strasse|str\./g,'str').replace(/[^a-z0-9äöüß]/g,'');

export function newOrderId(){
 const prefix=config.environment==='live'?'N':'T';
 // Zeitanteil + 3 Zufallszeichen (32^3 Möglichkeiten je Millisekunde); Kollisionen fängt zusätzlich die Datenbank ab.
 const rand=[...crypto.getRandomValues(new Uint8Array(3))].map(b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
 return prefix+Date.now().toString(36).toUpperCase()+rand;
}
export function newCustomerToken(){const b=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
export const tokenHash=token=>sha256('customer:'+token);

// Datenbankzeile → Bestellobjekt (Spalten sind maßgeblich).
export function rowToOrder(r){
 return {...r.data,id:r.id,status:r.status,fulfillment:r.fulfillment,version:r.version,
  createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),
  kitchenPrint:r.kitchen_print||undefined,anonymized:r.anonymized_at?true:undefined};
}
// Kundensicht: keine Kontakt-/Adressdaten, keine internen Prüf- oder Zahlungsprotokolle.
export function customerView(o){
 const {customer,email,phone,address,bell,floor,notes,riskFlag,paymentHistory,paymentReversed,kitchenPrint,reminderSentAt,anonymized,...safe}=o;
 return safe;
}
// Mitarbeitersicht: alles, was für Annahme, Zubereitung, Lieferung und Kasse nötig ist.
export const staffView=o=>o;

export async function sendPush(subscriptions,payload,{ttl=120,urgency='high'}={}){
 if(!subscriptions.length||!config.vapidPublic||!config.vapidPrivate)return {sent:0,failed:0,stale:[]};
 webpush.setVapidDetails(config.vapidContact,config.vapidPublic,config.vapidPrivate);
 const results=await Promise.allSettled(subscriptions.map(s=>webpush.sendNotification(s.subscription,JSON.stringify(payload),{TTL:ttl,urgency})));
 const stale=results.flatMap((r,i)=>r.status==='rejected'&&[404,410].includes(r.reason?.statusCode)?[subscriptions[i].endpoint]:[]);
 if(stale.length)await pool().query('DELETE FROM nebu_push_subscriptions WHERE endpoint = ANY($1)',[stale]).catch(e=>logError('push cleanup',e));
 results.forEach(r=>{if(r.status==='rejected'&&![404,410].includes(r.reason?.statusCode))logError('push',r.reason)});
 return {sent:results.filter(r=>r.status==='fulfilled').length,failed:results.filter(r=>r.status==='rejected').length,stale};
}
export async function staffSubscriptions(){
 return (await pool().query("SELECT p.endpoint,p.subscription FROM nebu_push_subscriptions p JOIN nebu_staff st ON st.id=p.staff_id WHERE p.kind='staff' AND st.active")).rows;
}
export const envLabel=()=>config.environment==='live'?'':'Test-';

export const CUSTOMER_MESSAGES=o=>({accepted:['Bestellung angenommen','Wir haben deine Bestellung bestätigt.'],preparing:['Zubereitung gestartet','Dein Sushi wird jetzt frisch zubereitet.'],ready:['Deine Bestellung ist fertig',o.fulfillment==='pickup'?'Dein Sushi ist zur Abholung bereit.':'Dein Sushi wartet auf unseren Fahrer.'],picked_up:['Bestellung abgeholt','Vielen Dank und guten Appetit!'],enroute:['Dein Fahrer ist unterwegs!','Dein Sushi ist auf dem Weg zu dir.'],delivered:['Deine Bestellung wurde zugestellt','Guten Appetit!'],delivery_failed:['Zustellung nicht abgeschlossen','Die Bestellung konnte nicht übergeben werden.'],rejected:['Bestellung leider abgelehnt','Deine '+(o.fulfillment==='pickup'?'Abholbestellung':'Lieferbestellung')+' kann leider nicht ausgeführt werden.'+(o.cancelReason?' Grund: '+o.cancelReason:'')]});

export const transitionsFor=o=>({new:['accepted','rejected'],accepted:['preparing'],preparing:['ready'],ready:o.fulfillment==='pickup'?['picked_up']:['enroute'],picked_up:[],enroute:o.fulfillment==='pickup'?['picked_up']:['delivered','delivery_failed'],delivered:[],rejected:[],delivery_failed:[]});

// Wendet eine Mitarbeiter-Änderung auf das Bestellobjekt an. Liefert {error,status} oder {order,changed,next}.
export function applyStaffUpdate(o,body,staff){
 const next=body.status;
 if(body.paymentReceived!==undefined&&typeof body.paymentReceived!=='boolean')return {error:'Ungültiger Zahlungsstatus',status:422};
 if(o.anonymized)return {error:'Diese Bestellung ist archiviert und kann nicht mehr geändert werden.',status:409};
 if(body.paymentReceived!==undefined&&FINAL_STATES.includes(o.status)&&body.paymentReceived!==o.paymentReceived)return {error:'Abgeschlossene Bestellungen können nicht nachträglich über diese Funktion umgebucht werden.',status:409};
 if(next&&next===o.status&&(body.paymentReceived===undefined||body.paymentReceived===o.paymentReceived))return {order:o,changed:false,alreadyApplied:true};
 if(!next&&typeof body.paymentReceived==='boolean'&&body.paymentReceived===o.paymentReceived)return {order:o,changed:false,alreadyApplied:true};
 if(!Number.isInteger(body.expectedVersion)||body.expectedVersion!==(o.version??0))return {error:'Bestellung wurde auf einem anderen Gerät geändert. Bitte aktualisieren.',status:409};
 if(body.paymentReceived===true&&o.paymentReceived!==true&&!['accepted','preparing','ready','enroute'].includes(o.status))return {error:'Zahlung kann erst nach Annahme der Bestellung bestätigt werden.',status:409};
 if(body.paymentReceived===true&&next)return {error:'Zahlung und Statuswechsel bitte getrennt bestätigen.',status:422};
 if(o.fulfillment==='pickup'&&['enroute','delivered','delivery_failed'].includes(next))return {error:'Für Selbstabholung ist dieser Lieferstatus nicht erlaubt.',status:409};
 if(o.fulfillment!=='pickup'&&next==='picked_up')return {error:'Abholung nur für Abholbestellungen erlaubt.',status:409};
 if(next&&!(transitionsFor(o)[o.status]||[]).includes(next))return {error:'Bestellstatus wurde bereits geändert. Bitte Ansicht aktualisieren.',status:409};
 if(next==='delivery_failed'&&o.paymentReceived===true)return {error:'Zahlung bereits bestätigt. Zustellung fehlgeschlagen kann nicht gewählt werden.',status:409};
 if((next==='delivered'||next==='picked_up')&&o.paymentMethod==='cash'&&o.paymentReceived!==true)return {error:'Barzahlung noch offen: Bitte Zahlungseingang bestätigen, bevor du die Bestellung abschließt.',status:409};
 if(next==='accepted'&&o.riskFlag?.level==='review'&&body.riskReviewed!==true)return {error:'Auffälliges Bestellmuster: Bitte Bestellung prüfen und die Annahme ausdrücklich bestätigen.',status:409};
 const now=new Date().toISOString();
 if(next==='rejected'){const reason=String(body.cancelReason||'').trim();if(!reason||reason.length>300)return {error:'Bitte einen Ablehnungsgrund mit maximal 300 Zeichen angeben.',status:422};o.cancelReason=reason;o.cancelledAt=now}
 if(next==='accepted'){const eta=Number(body.eta);if(!ETA_CHOICES.includes(eta))return {error:'Ungültige Lieferzeit',status:400};o.eta=eta;o.acceptedAt=now;o.acceptedBy=staff.name;o.deliveryDueAt=new Date(Date.parse(now)+eta*60000).toISOString();if(!o.kitchenPrint)o.kitchenPrint={jobId:crypto.randomUUID(),status:'queued',queuedAt:now,attempts:0}}
 if(next)o.status=next;
 if(typeof body.paymentReceived==='boolean'&&body.paymentReceived!==o.paymentReceived){
  if(['rejected','delivery_failed'].includes(o.status))return {error:'Bei abgelehnten oder gescheiterten Bestellungen kann keine Zahlung bestätigt werden.',status:409};
  const history=Array.isArray(o.paymentHistory)?o.paymentHistory:[];
  if(history.length>=50)return {error:'Zu viele Zahlungsänderungen für diese Bestellung. Bitte Leitung informieren.',status:409};
  const reason=String(body.paymentReason||'').trim();
  if(body.paymentReceived===false&&reason.length<5)return {error:'Rücknahme einer bestätigten Zahlung nur mit Begründung (mindestens 5 Zeichen).',status:422};
  o.paymentHistory=[...history,{at:now,from:o.paymentReceived===true,to:body.paymentReceived,orderStatus:o.status,reason:body.paymentReceived===false?reason:null,actor:staff.name}];
  if(body.paymentReceived)o.paymentConfirmedAt=o.paymentConfirmedAt||now;else o.paymentReversed=true;
  o.paymentReceived=body.paymentReceived;
 }
 if(next==='delivery_failed'){o.failureReason='Zahlung verweigert';o.failedAt=now}
 o.version=(o.version??0)+1;o.updatedAt=now;
 return {order:o,changed:true,next};
}

// Bestellobjekt → Datenbankspalten (personenbezogene Daten nur in data).
export function orderColumns(o){
 const {id,status,fulfillment,version,createdAt,updatedAt,kitchenPrint,anonymized,...data}=o;
 return {id,status,fulfillment,version,data,kitchenPrint:kitchenPrint||null,closed:FINAL_STATES.includes(status)};
}
