import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';
import webpush from 'web-push';

export const config={schedule:'* * * * *'};

export default async ()=>{
 const pub=Netlify.env.get('NEBU_VAPID_PUBLIC'),priv=Netlify.env.get('NEBU_VAPID_PRIVATE');
 if(!pub||!priv)return;
 const db=getDatabase();
 let client=null;
 let pending=[],due=[];
 try{
  client=await db.pool.connect();
  await client.query('BEGIN');
  const res=await client.query('SELECT orders,migrated FROM nebu_test_order_state WHERE id=1 FOR UPDATE');
  if(res.rows.length!==1)throw Error('NEBU test orders migration not applied');
  const orders=res.rows[0].migrated?res.rows[0].orders:(await getStore('nebu-orders-demo').get('orders',{type:'json'})||[]);
  const now=Date.now();
  due=orders.filter(o=>o.status==='new'&&!o.reminderSentAt&&o.createdAt&&now-Date.parse(o.createdAt)>=5*60*1000);
  if(due.length){
   pending=orders.filter(o=>o.status==='new');
   for(const o of due)o.reminderSentAt=new Date(now).toISOString();
   await client.query('UPDATE nebu_test_order_state SET orders=$1::jsonb,migrated=TRUE WHERE id=1',[JSON.stringify(orders)]);
  }
  await client.query('COMMIT');client.release();client=null;
  if(!due.length)return;
  webpush.setVapidDetails('mailto:test@nebusushi.com',pub,priv);
  const store=getStore('nebu-push-test');
  const subscriptions=await store.get('admin-subscriptions',{type:'json'})||[];
  const legacy=await store.get('iphone-subscription',{type:'json'});
  const unique=[...subscriptions,...(legacy?[legacy]:[])].filter((s,i,all)=>s?.endpoint&&all.findIndex(x=>x?.endpoint===s.endpoint)===i);
  const payload=JSON.stringify({
   title:'NEBU · '+pending.length+' offene '+(pending.length===1?'Bestellung':'Bestellungen'),
   body:pending.length===1?'Bestellung #'+pending[0].id+' wartet seit mindestens 5 Minuten auf Annahme.':pending.length+' Bestellungen warten auf Annahme. Bitte Bestellcenter prüfen.',
   url:'/',tag:'nebu-reminders-summary'
  });
  const sent=await Promise.allSettled(unique.map(s=>webpush.sendNotification(s,payload,{TTL:180,urgency:'high'})));
  sent.forEach(r=>{if(r.status==='rejected')console.error('NEBU reminder push',r.reason?.message)});
 }catch(e){console.error('NEBU reminder schedule',e)}
 finally{if(client){try{await client.query('ROLLBACK')}catch(e){console.error('NEBU reminder rollback',e)}client.release()}}
};
