// Öffentliche Shop-API (ohne Anmeldung): Bestellweg/Verfügbarkeit lesen, Bestellung aufgeben,
// eigene Bestellung per Kunden-Token abfragen, Push für die eigene Bestellung registrieren.
// Gibt niemals Daten anderer Kunden oder interne Felder heraus.
import {lookup} from './nebu-catalog.mjs';
import {checkAddress} from './delivery-check.mjs';
import {json,readJson,clientIp,sha256,tx,pool,rateLimited,logError,config,getSetting} from '../lib/core.mjs';
import {shopState,acceptingNow} from '../lib/shop-state.mjs';
import {validatePhone,phoneKey,addressKey,newOrderId,newCustomerToken,tokenHash,rowToOrder,customerView,sendPush,staffSubscriptions,envLabel,CUSTOMER_TOKEN_HOURS} from '../lib/orders.mjs';

const ORDER_ID=/^[TN][A-Z0-9]{6,20}$/;
const PROTECTED=['fee','total','subtotal','routeKm','minimum','eligible','paymentReceived','paymentMethod','status','riskFlag','delivery','deliveryQuote','acceptedAt','createdAt','updatedAt','id','version','kitchenPrint'];

export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const {body,error}=await readJson(req);if(error)return error;
 try{
  switch(body.action){
   case 'config':case 'inventory':{
    const [mode,state,disabled]=await Promise.all([getSetting('orderingMode'),shopState(),disabledIds()]);
    const open=acceptingNow(state,config.environment);
    return json({orderingMode:mode,accepting:mode==='online'&&open.ok,reason:open.ok?null:open.reason,statusMode:state.statusMode,prepTime:state.prepTime,disabled},200,{'cache-control':'no-store'});
   }
   case 'create':return await create(req,body);
   case 'status':return await status(req,body);
   case 'push-register':return await pushRegister(req,body);
   default:return json({error:'Ungültige Aktion'},400);
  }
 }catch(e){logError('shop-api '+body.action,e);return json({error:'Die Bestellung konnte gerade nicht verarbeitet werden. Bitte erneut versuchen oder telefonisch bestellen.'},500)}
};

// Ausverkauft = Liste aus NEBU Control ∪ Ausverkauft-Liste des Shop-Admins.
async function disabledIds(state){
 const own=await getSetting('disabledProducts');const shop=state||await shopState();
 return [...new Set([...(Array.isArray(own)?own:[]),...shop.soldOutIds])];
}
async function limited(req,name,limits){
 const ip=clientIp(req);if(!ip)return true;
 const key=await sha256(name+':'+ip);
 for(const [limit,windowSeconds] of limits)if(await rateLimited(name+':'+key,{limit,windowSeconds}))return true;
 return false;
}

async function create(req,body){
 const trusted=config.testCustomerKey&&req.headers.get('x-nebu-test-key')===config.testCustomerKey;
 if(!trusted){
  if(!clientIp(req))return json({error:'Bestellung derzeit nicht verfügbar.'},503);
  const limits=config.environment==='live'?[[6,900],[30,86400]]:[[20,900],[100,86400]];
  if(await limited(req,'order',limits))return json({error:'Zu viele Bestellungen in kurzer Zeit. Bitte später erneut versuchen oder telefonisch bestellen.'},429);
  if(body.website||body.company)return json({error:'Bestellung konnte nicht verarbeitet werden.'},422);
 }
 if((await getSetting('orderingMode'))!=='online'&&config.environment==='live')return json({error:'Online-Bestellung ist gerade nicht aktiv. Bitte per WhatsApp oder telefonisch bestellen.',orderingMode:'whatsapp'},409);
 const state=await shopState();
 const open=acceptingNow(state,config.environment);
 if(!open.ok)return json({error:open.reason,closed:true},409);
 const injected=PROTECTED.filter(f=>Object.prototype.hasOwnProperty.call(body,f));
 if(injected.length)return json({error:'Manipulierte Bestelldaten: Preis-, Liefer-, Zahlungs- und Statuswerte dürfen nicht vom Kunden vorgegeben werden.'},422);
 const requestId=String(body.requestId||'');if(!/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(requestId))return json({error:'Ungültige Bestellkennung. Bitte Seite neu laden.'},422);
 const customer=String(body.customer||'').trim();if(!customer||customer.length>80)return json({error:'Bitte einen Namen mit maximal 80 Zeichen eingeben.'},422);
 const email=String(body.email||'').trim();if(email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return json({error:'Bitte eine gültige E-Mail-Adresse eingeben oder das Feld leer lassen.'},422);
 const phone=String(body.phone||'').trim();const phoneError=validatePhone(phone);if(phoneError)return json({error:phoneError},422);
 const requested=body.cart;if(!Array.isArray(requested)||!requested.length||requested.length>76)return json({error:'Bitte mindestens einen gültigen Artikel auswählen.'},422);
 const disabled=await disabledIds(state);
 if(requested.some(l=>disabled.includes(l?.id)))return json({error:'Ein Artikel im Warenkorb ist inzwischen ausverkauft. Bitte Warenkorb aktualisieren.'},409);
 const seen=new Set();let subtotalCents=0;const items=[];
 for(const line of requested){
  if(!line||typeof line!=='object'||Object.keys(line).some(k=>!['id','qty'].includes(k)))return json({error:'Ungültige Warenkorb-Daten'},422);
  const product=lookup.get(line.id);
  if(!product||!Number.isInteger(line.qty)||line.qty<1||line.qty>30||seen.has(line.id))return json({error:'Ungültiger Artikel oder Menge'},422);
  seen.add(line.id);subtotalCents+=product.cents*line.qty;items.push({name:product.name,price:product.cents/100,qty:line.qty});
 }
 if(subtotalCents>100000)return json({error:'Bestellwert über 1.000 €: bitte telefonisch bestellen.'},422);
 const notes=String(body.notes||'').trim(),floor=String(body.floor||'').trim(),bell=String(body.bell||'').trim();
 if(notes.length>500||floor.length>30||bell.length>80)return json({error:'Sonderwünsche oder Adresszusätze sind zu lang.'},422);
 const fulfillment=body.fulfillment==='pickup'?'pickup':'delivery';let delivery=null;
 const address=fulfillment==='pickup'?'':String(body.address||'').slice(0,150);
 if(fulfillment==='delivery'){
  try{delivery=await checkAddress(address);if(!delivery.eligible)return json({error:delivery.message,offerPickup:true},422);if(subtotalCents<Math.round(delivery.minimum*100))return json({error:'Mindestbestellwert '+delivery.minimum.toFixed(2)+' €',offerPickup:true},422)}
  catch(e){return json({error:'Lieferadresse nicht verifizierbar: '+e.message,offerPickup:true},422)}
 }
 const pk=phoneKey(phone),ak=fulfillment==='delivery'?addressKey(address):null;
 const fee=fulfillment==='pickup'?0:delivery.fee;
 const token=newCustomerToken();
 const now=new Date();
 const result=await tx(async db=>{
  if((await db.query('SELECT 1 FROM nebu_orders WHERE request_id=$1',[requestId])).rows.length)return {conflict:true};
  const recent=(await db.query("SELECT count(*) FILTER (WHERE phone_key=$1)::int AS phone, count(*) FILTER (WHERE $2::text IS NOT NULL AND address_key=$2)::int AS addr FROM nebu_orders WHERE created_at > now() - interval '10 minutes'",[pk,ak])).rows[0];
  const reasons=[];
  if(recent.phone>=2)reasons.push('Mindestens 3 Bestellungen mit derselben Telefonnummer innerhalb von 10 Minuten.');
  if(recent.addr>=2)reasons.push('Mindestens 3 Lieferbestellungen an dieselbe Adresse innerhalb von 10 Minuten.');
  const riskFlag=reasons.length?{level:'review',reason:reasons.join(' '),recentCount:Math.max(recent.phone,recent.addr)+1}:null;
  const data={customer,email,phone,notes,floor:fulfillment==='delivery'?floor:'',bell:fulfillment==='delivery'?bell:'',riskFlag,address,items,subtotal:subtotalCents/100,fee,total:(subtotalCents+Math.round(fee*100))/100,routeKm:delivery?.km??null,paymentMethod:'cash',paymentReceived:false,reminderSentAt:null,eta:null};
  const th=await tokenHash(token);
  for(let attempt=0;attempt<5;attempt++){
   await db.query('SAVEPOINT ins');
   try{
    const r=await db.query("INSERT INTO nebu_orders (id,request_id,token_hash,token_expires_at,status,fulfillment,version,data,phone_key,address_key,created_at,updated_at) VALUES ($1,$2,$3,$4,'new',$5,0,$6,$7,$8,$9,$9) ON CONFLICT (request_id) DO NOTHING RETURNING *",
     [newOrderId(),requestId,th,new Date(now.getTime()+CUSTOMER_TOKEN_HOURS*3600000),fulfillment,JSON.stringify(data),pk,ak,now]);
    if(!r.rows[0])return {conflict:true};
    return {order:rowToOrder(r.rows[0])};
   }catch(e){
    // Bestellnummer zufällig doppelt (Primärschlüssel) → neue Nummer, sonst Fehler weitergeben.
    if(e.code==='23505'&&String(e.constraint||'').includes('pkey')){await db.query('ROLLBACK TO SAVEPOINT ins');continue}
    throw e;
   }
  }
  throw Error('Keine freie Bestellnummer');
 });
 if(result.conflict)return json({error:'Diese Bestellung wurde bereits gesendet. Bitte Bestellstatus prüfen.'},409);
 const o=result.order;
 let push='not-registered';
 try{
  const subs=await staffSubscriptions();
  if(subs.length){const r=await sendPush(subs,{title:'NEBU – Neue '+envLabel()+'Bestellung '+o.id,body:o.total.toFixed(2).replace('.',',')+' € · '+(fulfillment==='pickup'?'Abholung':'Lieferung')+' · Jetzt annehmen oder ablehnen',url:config.controlPath,tag:'nebu-order-'+o.id});push=r.sent?'sent':'failed'}
 }catch(e){logError('order push',e);push='failed'}
 return json({order:customerView(o),token,push},201);
}

async function status(req,body){
 if(typeof body.id!=='string'||!ORDER_ID.test(body.id)||typeof body.token!=='string'||body.token.length>160)return json({error:'Ungültige Statusanfrage'},400);
 if(await limited(req,'status',[[240,900]]))return json({error:'Zu viele Abfragen. Bitte kurz warten.'},429);
 const r=await pool().query('SELECT * FROM nebu_orders WHERE id=$1',[body.id]);const row=r.rows[0];
 if(!row||!row.token_hash||row.token_hash!==await tokenHash(body.token)||new Date(row.token_expires_at)<new Date())return json({error:'Bestellung nicht gefunden oder Zugriff verweigert'},403);
 return json({order:customerView(rowToOrder(row))});
}

async function pushRegister(req,body){
 const s=body.subscription;
 if(typeof body.orderId!=='string'||!ORDER_ID.test(body.orderId)||typeof body.token!=='string'||!s?.endpoint?.startsWith?.('https://')||s.endpoint.length>1000||!s.keys?.p256dh||!s.keys?.auth)return json({error:'Ungültige Registrierung'},400);
 if(await limited(req,'cpush',[[30,900]]))return json({error:'Zu viele Anfragen'},429);
 const r=await pool().query('SELECT token_hash,token_expires_at FROM nebu_orders WHERE id=$1',[body.orderId]);const row=r.rows[0];
 if(!row||row.token_hash!==await tokenHash(body.token)||new Date(row.token_expires_at)<new Date())return json({error:'Bestellung nicht gefunden oder Zugriff verweigert'},403);
 await pool().query("INSERT INTO nebu_push_subscriptions (endpoint,kind,order_id,subscription) VALUES ($1,'customer',$2,$3) ON CONFLICT (endpoint) DO UPDATE SET kind='customer', staff_id=NULL, order_id=EXCLUDED.order_id, subscription=EXCLUDED.subscription, created_at=now()",[s.endpoint,body.orderId,JSON.stringify({endpoint:s.endpoint,keys:{p256dh:String(s.keys.p256dh).slice(0,200),auth:String(s.keys.auth).slice(0,100)}})]);
 return json({ok:true});
}
