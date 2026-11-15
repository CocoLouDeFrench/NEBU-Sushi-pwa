import {getStore} from '@netlify/blobs';
export default async req=>{
 if(req.method!=='POST')return Response.json({error:'Methode nicht erlaubt'},{status:405});
 const secret=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
 if(!secret||req.headers.get('x-nebu-test-key')!==secret)return Response.json({error:'Test-Zugangscode ungültig'},{status:401});
 try{
  const {orderId,subscription}=await req.json();
  if(!/^T[A-Z0-9]{5,30}$/.test(String(orderId||''))||!subscription?.endpoint?.startsWith('https://')||!subscription.keys?.p256dh||!subscription.keys?.auth)return Response.json({error:'Ungültige Registrierung'},{status:400});
  const orders=await getStore('nebu-orders-demo').get('orders',{type:'json'})||[];
  if(!orders.some(o=>o.id===orderId))return Response.json({error:'Bestellung nicht gefunden'},{status:404});
  await getStore('nebu-customer-push-test').setJSON(orderId,subscription);
  return Response.json({ok:true});
 }catch(e){console.error('Customer push register',e);return Response.json({error:'Registrierung fehlgeschlagen'},{status:500})}
};