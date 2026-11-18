import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';
export default async req=>{
 if(req.method!=='POST')return Response.json({error:'Methode nicht erlaubt'},{status:405});
 try{
  const {orderId,token,subscription}=await req.json();
  if(!/^T[A-Z0-9]{5,30}$/.test(String(orderId||''))||!subscription?.endpoint?.startsWith('https://')||!subscription.keys?.p256dh||!subscription.keys?.auth)return Response.json({error:'Ungültige Registrierung'},{status:400});
  const rows=await getDatabase().sql`SELECT orders, migrated FROM nebu_test_order_state WHERE id=1`;
  const orders=rows[0]?.migrated?rows[0].orders:(await getStore('nebu-orders-demo').get('orders',{type:'json'})||[]);
  if(!orders.some(o=>o.id===orderId&&o.customerToken&&o.customerToken===token))return Response.json({error:'Bestellung nicht gefunden oder Zugriff verweigert'},{status:403});
  await getStore('nebu-customer-push-test').setJSON(orderId,subscription);
  return Response.json({ok:true});
 }catch(e){console.error('Customer push register',e);return Response.json({error:'Registrierung fehlgeschlagen'},{status:500})}
};