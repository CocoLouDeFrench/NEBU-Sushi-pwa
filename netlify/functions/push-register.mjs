// Mitarbeitergerät für Push-Benachrichtigungen registrieren (an den angemeldeten Mitarbeiter gebunden).
import {json,readJson,pool,logError} from '../lib/core.mjs';
import {requireStaff} from '../lib/auth.mjs';
export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const auth=await requireStaff(req);if(auth.error)return json({error:'Nicht angemeldet'},401);
 const {body:sub,error}=await readJson(req,4096);if(error)return error;
 if(typeof sub.endpoint!=='string'||!sub.endpoint.startsWith('https://')||sub.endpoint.length>1000||!sub.keys?.p256dh||!sub.keys?.auth)return json({error:'Ungültige Registrierung'},400);
 try{
  await pool().query("INSERT INTO nebu_push_subscriptions (endpoint,kind,staff_id,subscription) VALUES ($1,'staff',$2,$3) ON CONFLICT (endpoint) DO UPDATE SET kind='staff', staff_id=EXCLUDED.staff_id, order_id=NULL, subscription=EXCLUDED.subscription, created_at=now()",[sub.endpoint,auth.staff.id,JSON.stringify({endpoint:sub.endpoint,keys:{p256dh:String(sub.keys.p256dh).slice(0,200),auth:String(sub.keys.auth).slice(0,100)}})]);
  return json({ok:true});
 }catch(e){logError('push-register',e);return json({error:'Registrierung fehlgeschlagen'},500)}
};
