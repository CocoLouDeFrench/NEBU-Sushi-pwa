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
    let changed=false;
    for(const o of orders){
      if(o.status!=='new'||o.reminderSentAt||!o.createdAt)continue;
      if(now-Date.parse(o.createdAt)<5*60*1000)continue;
      // Reserve the reminder before sending, so retries cannot spam the restaurant.
      o.reminderSentAt=new Date(now).toISOString();
      changed=true;
    }
    if(!changed)return;
    await store.setJSON('orders',orders);
    const subscription=await getStore('nebu-push-test').get('iphone-subscription',{type:'json'});
    if(!subscription)return;
    for(const o of orders){
      if(o.status!=='new'||!o.reminderSentAt||now-Date.parse(o.reminderSentAt)>60*1000)continue;
      try{
        await webpush.sendNotification(subscription,JSON.stringify({
          title:'NEBU · Bestellung wartet auf Annahme',
          body:'Bestellung #'+o.id+' ist seit mindestens 5 Minuten offen.',
          url:'/',tag:'nebu-reminder-'+o.id
        }),{TTL:180,urgency:'high'});
      }catch(e){console.error('NEBU reminder push',o.id,e.message)}
    }
  }catch(e){console.error('NEBU reminder schedule',e)}
};
