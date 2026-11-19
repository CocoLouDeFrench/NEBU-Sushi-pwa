// Erinnerung per Push, wenn eine neue Bestellung 5 Minuten nicht angenommen wurde (einmal pro Bestellung).
import {tx,logError,config as nebuConfig} from '../lib/core.mjs';
import {sendPush,staffSubscriptions} from '../lib/orders.mjs';
export const config={schedule:'* * * * *'};
export default async()=>{
 try{
  const due=await tx(async db=>{
   const r=await db.query("UPDATE nebu_orders SET data=jsonb_set(data,'{reminderSentAt}',to_jsonb(now()::text)) WHERE status='new' AND (data->>'reminderSentAt') IS NULL AND created_at <= now() - interval '5 minutes' RETURNING id");
   if(!r.rowCount)return null;
   const pending=(await db.query("SELECT id FROM nebu_orders WHERE status='new' ORDER BY created_at")).rows.map(x=>x.id);
   return pending;
  });
  if(!due)return;
  const subs=await staffSubscriptions();
  await sendPush(subs,{title:'NEBU · '+due.length+' offene '+(due.length===1?'Bestellung':'Bestellungen'),body:due.length===1?'Bestellung #'+due[0]+' wartet seit mindestens 5 Minuten auf Annahme.':due.length+' Bestellungen warten auf Annahme. Bitte NEBU Control prüfen.',url:nebuConfig.controlPath,tag:'nebu-reminders-summary'},{ttl:180});
 }catch(e){logError('order-reminders',e)}
};
