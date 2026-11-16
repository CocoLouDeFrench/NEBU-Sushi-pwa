import {getStore} from '@netlify/blobs';
import webpush from 'web-push';
const json=(x,s=200)=>Response.json(x,{status:s,headers:{'cache-control':'no-store'}});
export default async req=>{
 const secret=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
 if(!secret||req.headers.get('x-nebu-test-key')!==secret)return json({error:'Test-Zugangscode ungültig'},401);
 const store=getStore('nebu-orders-demo');const key='orders';
 try{
 const orders=await store.get(key,{type:'json'})||[];
 if(req.method==='GET')return json({orders});
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const body=await req.json();
 if(body.action==='create'){
 const items=[{name:'Der Klassiker',price:27,qty:1},{name:'Maki Box',price:17.5,qty:1}];
 const order={id:'T'+Date.now().toString(36).toUpperCase(),customer:String(body.customer||'Testkunde').slice(0,80),address:String(body.address||'Testadresse Düsseldorf').slice(0,150),items,subtotal:44.5,fee:3.5,total:48,paymentMethod:'cash',paymentReceived:false,status:'new',reminderSentAt:null,eta:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 orders.unshift(order);await store.setJSON(key,orders.slice(0,100));
 let push='not-registered';
 try{const sub=await getStore('nebu-push-test').get('iphone-subscription',{type:'json'});if(sub&&Netlify.env.get('NEBU_VAPID_PUBLIC')&&Netlify.env.get('NEBU_VAPID_PRIVATE')){webpush.setVapidDetails('mailto:test@nebusushi.com',Netlify.env.get('NEBU_VAPID_PUBLIC'),Netlify.env.get('NEBU_VAPID_PRIVATE'));await webpush.sendNotification(sub,JSON.stringify({title:'NEBU – Neue Testbestellung '+order.id,body:'48,00 € · Jetzt annehmen oder ablehnen',url:'/'}),{TTL:120,urgency:'high'});push='sent'}}catch(e){console.error('Demo push error',e.message);push='failed'}
 return json({order,push},201);
 }
 if(body.action==='update'){
 const o=orders.find(o=>o.id===body.id);if(!o)return json({error:'Bestellung nicht gefunden'},404);
 const next=body.status;const transitions={new:['accepted','rejected'],accepted:['preparing'],preparing:['ready'],ready:['enroute'],enroute:['delivered','delivery_failed'],delivered:[],rejected:[],delivery_failed:[]};
 if(next===o.status)return json({order:o,unchanged:true});
 if(next&&!(transitions[o.status]||[]).includes(next))return json({error:'Bestellstatus wurde bereits geändert. Bitte Ansicht aktualisieren.'},409);
 if(next==='delivery_failed'&&o.paymentReceived===true)return json({error:'Zahlung bereits bestätigt. Zustellung fehlgeschlagen kann nicht gewählt werden.'},409);
 if(next==='delivered'&&o.paymentMethod==='cash'&&o.paymentReceived!==true)return json({error:'Barzahlung noch offen: Bitte Zahlungseingang bestätigen, bevor du die Bestellung abschließt.'},409);
 if(next){if(next==='accepted'){const eta=Number(body.eta);if(![30,45,60,75].includes(eta))return json({error:'Ungültige Lieferzeit'},400);o.eta=eta;o.acceptedAt=new Date().toISOString();o.deliveryDueAt=new Date(Date.parse(o.acceptedAt)+eta*60000).toISOString()}o.status=next}
 if(typeof body.paymentReceived==='boolean'){
  if(['rejected','delivery_failed'].includes(o.status))return json({error:'Bei abgelehnten oder gescheiterten Bestellungen kann keine Zahlung bestätigt werden.'},409);
  o.paymentReceived=body.paymentReceived;
 }
 if(next==='delivery_failed'){o.failureReason='Zahlung verweigert';o.failedAt=new Date().toISOString();}
 o.updatedAt=new Date().toISOString();await store.setJSON(key,orders);
 if(next&&['accepted','preparing','ready','enroute','delivered','delivery_failed'].includes(next)){
  try{
   const subscription=await getStore('nebu-customer-push-test').get(o.id,{type:'json'});
   const pub=Netlify.env.get('NEBU_VAPID_PUBLIC'),priv=Netlify.env.get('NEBU_VAPID_PRIVATE');
   if(subscription&&pub&&priv){
    const messages={accepted:['Bestellung angenommen','Wir haben deine Bestellung bestätigt.'],preparing:['Zubereitung gestartet','Dein Sushi wird jetzt frisch zubereitet.'],ready:['Deine Bestellung ist fertig','Dein Sushi wartet auf unseren Fahrer.'],enroute:['Dein Fahrer ist unterwegs!','Dein Sushi ist auf dem Weg zu dir.'],delivered:['Deine Bestellung wurde zugestellt','Guten Appetit!'],delivery_failed:['Zustellung nicht abgeschlossen','Die Bestellung konnte nicht übergeben werden.']};
    webpush.setVapidDetails('mailto:test@nebusushi.com',pub,priv);
    await webpush.sendNotification(subscription,JSON.stringify({title:'NEBU Sushi · '+messages[next][0],body:messages[next][1],url:'/customer.html',tag:'nebu-customer-'+o.id+'-'+next}),{TTL:180,urgency:'normal'});
   }
  }catch(e){console.error('Customer status push failed',e.message)}
 }
 return json({order:o});
 }
 return json({error:'Ungültige Aktion'},400)
 }catch(e){console.error('Demo orders',e);return json({error:'Testserver-Fehler'},500)}
};