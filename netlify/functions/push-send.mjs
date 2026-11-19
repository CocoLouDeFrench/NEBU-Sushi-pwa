import {verifyStaffSession} from './nebu-staff-session.mjs';
import {getStore} from '@netlify/blobs';
import webpush from 'web-push';
export default async(req)=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 const bearer=req.headers.get('authorization')||'';
 const validSession=bearer.startsWith('Bearer ')&&await verifyStaffSession(bearer.slice(7),Netlify.env.get('NEBU_TEST_SESSION_SECRET'));
 if(!validSession)return new Response('Unauthorized',{status:401});
 try{
  const store=getStore('nebu-push-test');
  const registered=await store.get('admin-subscriptions',{type:'json'})||[];
  const legacy=await store.get('iphone-subscription',{type:'json'});
  const all=[...registered,...(legacy?[legacy]:[])].filter((sub,i,arr)=>sub?.endpoint&&arr.findIndex(x=>x?.endpoint===sub.endpoint)===i);
  if(!all.length)return Response.json({error:'Noch kein Gerät registriert'},{status:404});
  webpush.setVapidDetails('mailto:test@nebusushi.com',Netlify.env.get('NEBU_VAPID_PUBLIC'),Netlify.env.get('NEBU_VAPID_PRIVATE'));
  const payload=JSON.stringify({title:'NEBU – Push-Test',body:'Testmeldung an alle registrierten NEBU-Control-Geräte',url:'/index.html'});
  const results=await Promise.allSettled(all.map(sub=>webpush.sendNotification(sub,payload,{TTL:120,urgency:'high'})));
  const sent=results.filter(x=>x.status==='fulfilled').length;
  const stale=results.flatMap((x,i)=>x.status==='rejected'&&[404,410].includes(x.reason?.statusCode)?[all[i].endpoint]:[]);
  if(stale.length)await store.setJSON('admin-subscriptions',registered.filter(x=>!stale.includes(x.endpoint)));
  const failures=results.filter(x=>x.status==='rejected').map(x=>x.reason?.statusCode||'network');
  return Response.json({ok:sent>0,registered:all.length,sent,failed:failures.length,errors:failures},{status:sent?200:502});
 }catch(e){console.error('Push delivery error',e.statusCode||e.message);return Response.json({error:'Push konnte nicht gesendet werden'},{status:502})}
};