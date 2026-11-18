import {lookup} from './nebu-catalog.mjs';
import {checkAddress} from './delivery-check.mjs';
import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';
import webpush from 'web-push';
function validatePhone(value){const phone=String(value||'').trim();if(!/^\+?[0-9\s()\/-]+$/.test(phone))return 'Bitte nur Ziffern und übliche Telefonnummern-Zeichen eingeben.';const digits=phone.replace(/\D/g,'');if(digits.length<7||digits.length>15)return 'Bitte eine Telefonnummer mit 7 bis 15 Ziffern eingeben.';if(/^(\d)\1{6,}$/.test(digits)||/^(?:0123456789|1234567890|9876543210|0987654321)/.test(digits))return 'Diese Telefonnummer wirkt ungültig. Bitte überprüfe sie.';if(phone.startsWith('+')&&digits.startsWith('00'))return 'Bitte die Landesvorwahl nur einmal angeben.';if(digits.startsWith('49')){const local=digits.slice(2).replace(/^0/,'');if(!/^1[567]\d{8,9}$/.test(local)&&!/^\d{3,13}$/.test(local))return 'Bitte die deutsche Telefonnummer überprüfen.';}else if(digits.startsWith('0')&&!digits.startsWith('00')){if(!/^01[567]\d{8,9}$/.test(digits)&&!/^0[2-9]\d{5,13}$/.test(digits))return 'Bitte die deutsche Telefonnummer überprüfen.';}return ''};
const json=(x,s=200)=>Response.json(x,{status:s,headers:{'cache-control':'no-store'}});
export default async req=>{
 const adminKey=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
 const customerKey=Netlify.env.get('NEBU_TEST_CUSTOMER_KEY');
 const suppliedKey=req.headers.get('x-nebu-test-key');
 const isAdmin=Boolean(adminKey&&suppliedKey===adminKey);
 const isCustomer=Boolean(customerKey&&suppliedKey===customerKey&&customerKey!==adminKey);
 const db=getDatabase();let client=null;
 try{
 // A row-level PostgreSQL lock makes every write to the test queue serial.
 // Old Blobs orders are imported on the first committed write.
 let orders;
 if(req.method==='GET'){
  const result=await db.sql`SELECT orders, migrated FROM nebu_test_order_state WHERE id = 1`;
  orders=result[0]?.migrated?result[0].orders:(await getStore('nebu-orders-demo').get('orders',{type:'json'})||[]);
 }else{
  client=await db.pool.connect();
  await client.query('BEGIN');
  const result=await client.query('SELECT orders, migrated FROM nebu_test_order_state WHERE id = 1 FOR UPDATE');
  if(result.rows.length!==1)throw Error('NEBU test orders migration not applied');
  orders=result.rows[0].migrated?result.rows[0].orders:(await getStore('nebu-orders-demo').get('orders',{type:'json'})||[]);
 }
 const persistOrders=async value=>{
  if(!client)throw Error('Missing order transaction');
  await client.query('UPDATE nebu_test_order_state SET orders = $1::jsonb, migrated = TRUE WHERE id = 1',[JSON.stringify(value)]);
  await client.query('COMMIT');client.release();client=null;
  return true;
 };
 if(req.method==='GET'){if(!isAdmin)return json({error:'Nur für NEBU-Mitarbeiter'},403);return json({orders:orders.map(({customerToken,...order})=>order)});}
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const body=await req.json();
 if(body.action==='status'){const order=orders.find(o=>o.id===body.id);if(!order||!body.token||body.token!==order.customerToken)return json({error:'Bestellung nicht gefunden oder Zugriff verweigert'},403);const {customerToken,customer,email,phone,address,bell,floor,notes,riskFlag,...safe}=order;return json({order:safe});}
 if(body.action==='create'){
 if(!isCustomer){
  const ip=req.headers.get('x-nf-client-connection-ip');
  if(!ip)return json({error:'Öffentliche Bestellung derzeit nicht verfügbar.'},503);
  const limiter=getStore('nebu-public-order-limits-v2');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const bucket='ip-'+digest;
  const now=Date.now();
  const recent=(await limiter.get(bucket,{type:'json'})||[]).filter(t=>Number.isFinite(t)&&now-t<86400000&&now>=t);
  if(recent.filter(t=>now-t<900000).length>=20||recent.length>=100)return json({error:'Zu viele Testbestellungen. Bitte später erneut versuchen.'},429);
  if(body.website||body.company)return json({error:'Bestellung konnte nicht verarbeitet werden.'},422);
  // Test-only throttle: non-atomic, not suitable for public production.
  await limiter.setJSON(bucket,[...recent,now]);
 }
 const protectedFields=['fee','total','subtotal','routeKm','minimum','eligible','subtotal','paymentReceived','paymentMethod','status','riskFlag','delivery','deliveryQuote','acceptedAt','createdAt','updatedAt'];
 const injected=protectedFields.filter(field=>Object.prototype.hasOwnProperty.call(body,field));
 if(injected.length)return json({error:'Manipulierte Bestelldaten: Preis-, Liefer-, Zahlungs- und Statuswerte dürfen nicht vom Kunden vorgegeben werden.'},422);
 const requestId=String(body.requestId||'');if(!/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(requestId))return json({error:'Ungültige Bestellkennung. Bitte Kundenseite neu laden.'},422);
 const existing=orders.find(o=>o.requestId===requestId);if(existing){const {customerToken:token,...safeOrder}=existing;return json({order:safeOrder,token,duplicate:true},200)}
 const customer=String(body.customer||'').trim();if(!customer||customer.length>80)return json({error:'Bitte einen Namen mit maximal 80 Zeichen eingeben.'},422);const email=String(body.email||'').trim();if(email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return json({error:'Bitte eine gültige E-Mail-Adresse eingeben oder das Feld leer lassen.'},422);const phone=String(body.phone||'').trim();const phoneError=validatePhone(phone);if(phoneError)return json({error:phoneError},422);
 const requested=body.cart;if(!Array.isArray(requested)||!requested.length||requested.length>76)return json({error:'Bitte mindestens einen gültigen Artikel auswählen.'},422);
 const seen=new Set();let subtotalCents=0;const items=[];for(const line of requested){if(!line||typeof line!=='object'||Object.keys(line).some(k=>!['id','qty'].includes(k)))return json({error:'Ungültige Warenkorb-Daten'},422);const product=lookup.get(line.id);if(!product||!Number.isInteger(line.qty)||line.qty<1||line.qty>30||seen.has(line.id))return json({error:'Ungültiger Artikel oder Menge'},422);seen.add(line.id);subtotalCents+=product.cents*line.qty;items.push({name:product.name,price:product.cents/100,qty:line.qty});}if(subtotalCents>100000)return json({error:'Bestellwert überschreitet das Testlimit'},422);
 const notes=String(body.notes||'').trim(),floor=String(body.floor||'').trim(),bell=String(body.bell||'').trim();if(notes.length>500||floor.length>30||bell.length>80)return json({error:'Sonderwünsche oder Adresszusätze sind zu lang.'},422);
 const fulfillment=body.fulfillment==='pickup'?'pickup':'delivery';let delivery=null;if(fulfillment==='delivery'){try{delivery=await checkAddress(String(body.address||''));if(!delivery.eligible)return json({error:delivery.message,offerPickup:true},422);if(subtotalCents<Math.round(delivery.minimum*100))return json({error:'Mindestbestellwert '+delivery.minimum.toFixed(2)+' €',offerPickup:true},422)}catch(e){return json({error:'Lieferadresse nicht verifizierbar: '+e.message,offerPickup:true},422)}}
 const normalizedPhone=phone.replace(/\D/g,'').replace(/^49(?=1[567])/, '0');const recentMatches=orders.filter(o=>String(o.phone||'').replace(/\D/g,'').replace(/^49(?=1[567])/, '0')===normalizedPhone&&Date.now()-Date.parse(o.createdAt)<10*60*1000&&Date.now()-Date.parse(o.createdAt)>=0).length;const normalizeAddress=value=>String(value||'').toLocaleLowerCase('de-DE').normalize('NFKC').replace(/straße|strasse|str\./g,'str').replace(/[^a-z0-9äöüß]/g,'');const addressKey=fulfillment==='delivery'?normalizeAddress(body.address):'';const addressMatches=addressKey?orders.filter(o=>o.fulfillment==='delivery'&&normalizeAddress(o.address)===addressKey&&Date.now()-Date.parse(o.createdAt)<10*60*1000&&Date.now()-Date.parse(o.createdAt)>=0).length:0;const reasons=[];if(recentMatches>=2)reasons.push('Mindestens 3 Bestellungen mit derselben Telefonnummer innerhalb von 10 Minuten.');if(addressMatches>=2)reasons.push('Mindestens 3 Lieferbestellungen an dieselbe Adresse innerhalb von 10 Minuten.');const riskFlag=reasons.length?{level:'review',reason:reasons.join(' '),recentCount:Math.max(recentMatches,addressMatches)+1}:null;
 const fee=fulfillment==='pickup'?0:delivery.fee;

 const customerToken=crypto.randomUUID()+crypto.randomUUID();
 const order={requestId,customerToken,version:0,id:'T'+Date.now().toString(36).toUpperCase(),customer,email,phone,notes,floor:fulfillment==='delivery'?floor:'',bell:fulfillment==='delivery'?bell:'',riskFlag,address:fulfillment==='pickup'?'':String(body.address||'').slice(0,150),items,subtotal:subtotalCents/100,fee,total:(subtotalCents+Math.round(fee*100))/100,fulfillment,routeKm:delivery?.km??null,paymentMethod:'cash',paymentReceived:false,status:'new',reminderSentAt:null,eta:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 orders.unshift(order);if(!await persistOrders(orders.slice(0,100)))return json({error:'Eine andere Bestellung wurde gleichzeitig gespeichert. Bitte erneut versuchen.'},409);
 let push='not-registered';
 try{
  const pushStore=getStore('nebu-push-test');
  const subscriptions=await pushStore.get('admin-subscriptions',{type:'json'})||[];
  const legacy=await pushStore.get('iphone-subscription',{type:'json'});
  const all=[...subscriptions,...(legacy?[legacy]:[])].filter((sub,i,a)=>sub?.endpoint&&a.findIndex(x=>x?.endpoint===sub.endpoint)===i);
  const pub=Netlify.env.get('NEBU_VAPID_PUBLIC'),priv=Netlify.env.get('NEBU_VAPID_PRIVATE');
  if(all.length&&pub&&priv){
   webpush.setVapidDetails('mailto:test@nebusushi.com',pub,priv);
   const payload=JSON.stringify({title:'NEBU – Neue Testbestellung '+order.id,body:order.total.toFixed(2).replace('.',',')+' € · '+(fulfillment==='pickup'?'Abholung':'Lieferung')+' · Jetzt annehmen oder ablehnen',url:'/'});
   const results=await Promise.allSettled(all.map(sub=>webpush.sendNotification(sub,payload,{TTL:120,urgency:'high'})));
   push=results.some(x=>x.status==='fulfilled')?'sent':'failed';
   const stale=results.flatMap((x,i)=>x.status==='rejected'&&[404,410].includes(x.reason?.statusCode)?[all[i].endpoint]:[]);
   if(stale.length)await pushStore.setJSON('admin-subscriptions',subscriptions.filter(sub=>!stale.includes(sub.endpoint)));
   for(const result of results)if(result.status==='rejected')console.error('Demo admin push failed',result.reason?.message);
  }
 }catch(e){console.error('Demo push error',e.message);push='failed'}
 const {customerToken:token,...safeOrder}=order;return json({order:safeOrder,token,push},201);
 }
 if(body.action==='update'){
 if(!isAdmin)return json({error:'Nur für NEBU-Mitarbeiter'},403);
 const o=orders.find(o=>o.id===body.id);if(!o)return json({error:'Bestellung nicht gefunden'},404);
 const next=body.status;
 // Repeated action from another staff device: report the current order, never send a second push.
 if(next&&next===o.status&&(body.paymentReceived===undefined||body.paymentReceived===o.paymentReceived)){const {customerToken,...safe}=o;return json({order:safe,unchanged:true,alreadyApplied:true});}
 if(!next&&typeof body.paymentReceived==='boolean'&&body.paymentReceived===o.paymentReceived){const {customerToken,...safe}=o;return json({order:safe,unchanged:true,alreadyApplied:true});}
 if(!Number.isInteger(body.expectedVersion)||body.expectedVersion!==(o.version??0))return json({error:'Bestellung wurde auf einem anderen Gerät geändert. Bitte aktualisieren.'},409);
const transitions={new:['accepted','rejected'],accepted:['preparing'],preparing:['ready'],ready:o.fulfillment==='pickup'?['picked_up']:['enroute'],picked_up:[],enroute:o.fulfillment==='pickup'?['picked_up']:['delivered','delivery_failed'],delivered:[],rejected:[],delivery_failed:[]};
 if(o.fulfillment==='pickup'&&['enroute','delivered','delivery_failed'].includes(next))return json({error:'Für Selbstabholung ist dieser Lieferstatus nicht erlaubt.'},409);if(o.fulfillment!=='pickup'&&next==='picked_up')return json({error:'Abholung nur für Abholbestellungen erlaubt.'},409);if(next===o.status){const {customerToken,...safe}=o;return json({order:safe,unchanged:true});}
 if(next&&!(transitions[o.status]||[]).includes(next))return json({error:'Bestellstatus wurde bereits geändert. Bitte Ansicht aktualisieren.'},409);
 if(next==='delivery_failed'&&o.paymentReceived===true)return json({error:'Zahlung bereits bestätigt. Zustellung fehlgeschlagen kann nicht gewählt werden.'},409);
 if((next==='delivered'||next==='picked_up')&&o.paymentMethod==='cash'&&o.paymentReceived!==true)return json({error:'Barzahlung noch offen: Bitte Zahlungseingang bestätigen, bevor du die Bestellung abschließt.'},409);
 if(next==='accepted'&&o.riskFlag?.level==='review'&&body.riskReviewed!==true)return json({error:'Auffälliges Bestellmuster: Bitte Bestellung prüfen und die Annahme ausdrücklich bestätigen.'},409);
 if(next){if(next==='accepted'){const eta=Number(body.eta);if(![30,45,60,75].includes(eta))return json({error:'Ungültige Lieferzeit'},400);o.eta=eta;o.acceptedAt=new Date().toISOString();o.deliveryDueAt=new Date(Date.parse(o.acceptedAt)+eta*60000).toISOString()}o.status=next}
 if(typeof body.paymentReceived==='boolean'){
  if(['rejected','delivery_failed'].includes(o.status))return json({error:'Bei abgelehnten oder gescheiterten Bestellungen kann keine Zahlung bestätigt werden.'},409);
  o.paymentReceived=body.paymentReceived;
 }
 if(next==='delivery_failed'){o.failureReason='Zahlung verweigert';o.failedAt=new Date().toISOString();}
 o.version=(o.version??0)+1;o.updatedAt=new Date().toISOString();if(!await persistOrders(orders))return json({error:'Bestellung wurde auf einem anderen Gerät geändert. Bitte aktualisieren.'},409);
 if(next&&['accepted','preparing','ready','enroute','delivered','picked_up','delivery_failed','rejected'].includes(next)){
  try{
   const subscription=await getStore('nebu-customer-push-test').get(o.id,{type:'json'});
   const pub=Netlify.env.get('NEBU_VAPID_PUBLIC'),priv=Netlify.env.get('NEBU_VAPID_PRIVATE');
   if(subscription&&pub&&priv){
    const messages={accepted:['Bestellung angenommen','Wir haben deine Bestellung bestätigt.'],preparing:['Zubereitung gestartet','Dein Sushi wird jetzt frisch zubereitet.'],ready:['Deine Bestellung ist fertig',o.fulfillment==='pickup'?'Dein Sushi ist zur Abholung bereit.':'Dein Sushi wartet auf unseren Fahrer.'],picked_up:['Bestellung abgeholt','Vielen Dank und guten Appetit!'],enroute:['Dein Fahrer ist unterwegs!','Dein Sushi ist auf dem Weg zu dir.'],delivered:['Deine Bestellung wurde zugestellt','Guten Appetit!'],delivery_failed:['Zustellung nicht abgeschlossen','Die Bestellung konnte nicht übergeben werden.'],rejected:['Bestellung leider abgelehnt','Deine Bestellung kann leider nicht ausgeführt werden. Es erfolgt keine Lieferung.']};
    webpush.setVapidDetails('mailto:test@nebusushi.com',pub,priv);
    await webpush.sendNotification(subscription,JSON.stringify({title:'NEBU Sushi · '+messages[next][0],body:messages[next][1],url:'/customer.html',tag:'nebu-customer-'+o.id+'-'+next}),{TTL:180,urgency:'normal'});
   }
  }catch(e){console.error('Customer status push failed',e.message)}
 }
 const {customerToken,...safe}=o;return json({order:safe});
 }
 return json({error:'Ungültige Aktion'},400)
 }catch(e){console.error('Demo orders',e);return json({error:'Testserver-Fehler'},500)}
 finally{if(client){try{await client.query('ROLLBACK')}catch(e){console.error('Demo rollback',e)}client.release()}}
};