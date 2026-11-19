// Test-Mitteilung an alle registrierten Mitarbeitergeräte.
import {json,logError} from '../lib/core.mjs';
import {requireStaff} from '../lib/auth.mjs';
import {sendPush,staffSubscriptions} from '../lib/orders.mjs';
export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const auth=await requireStaff(req);if(auth.error)return json({error:'Nicht angemeldet'},401);
 try{
  const subs=await staffSubscriptions();
  if(!subs.length)return json({error:'Noch kein Gerät registriert'},404);
  const r=await sendPush(subs,{title:'NEBU – Push-Test',body:'Testmeldung von '+auth.staff.name+' an alle NEBU-Control-Geräte',url:'/index.html'});
  return json({ok:r.sent>0,registered:subs.length,sent:r.sent,failed:r.failed});
 }catch(e){logError('push-send',e);return json({error:'Senden fehlgeschlagen'},500)}
};
