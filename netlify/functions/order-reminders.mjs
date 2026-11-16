import {getStore} from '@netlify/blobs';
import webpush from 'web-push';

export const config={schedule:'* * * * *'};

export default async ()=>{
  const pub=Netlify.env.get('NEBU_VAPID_PUBLIC');
  const priv=Netlify.env.get('NEBU_VAPID_PRIVATE');
  if(!pub||!priv)return;
  webpush.setVapidDetails('mailto:test@nebusushi.com',pub,priv);
  const store=getStore('nebu-orders-demo');
  try{
    const orders=await store.get('orders',{type:'json'})||[];
    const now=Date.now();
    const due=orders.filter(o=>o.status==='new'&&!o.reminderSentAt&&o.createdAt&&now-Date.parse(o.createdAt)>=5*60*1000);
    if(!due.length)return;
    // Only send one aggregated reminder for this batch of overdue orders.
    const pending=orders.filter(o=>o.status==='new');
    for(const o of due)o.reminderSentAt=new Date(now).toISOString();
    await store.setJSON('orders',orders);
    const subscription=await getStore('nebu-push-test').get('iphone-subscription',{type:'json'});
    if(!subscription)return;
    try{
      await webpush.sendNotification(subscription,JSON.stringify({
        title:'NEBU · '+pending.length+' offene '+(pending.length===1?'Bestellung':'Bestellungen'),
        body:pending.length===1?'Bestellung #'+pending[0].id+' wartet seit mindestens 5 Minuten auf Annahme.':pending.length+' Bestellungen warten auf Annahme. Bitte Bestellcenter prüfen.',
        url:'/',tag:'nebu-reminders-summary'
      }),{TTL:180,urgency:'high'});
    }catch(e){console.error('NEBU reminder summary push',e.message)}
  }catch(e){console.error('NEBU reminder schedule',e)}
};
