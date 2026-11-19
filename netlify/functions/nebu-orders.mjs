// Mitarbeiter-API für NEBU Control (nur mit persönlicher Anmeldung).
// GET: offene Bestellungen + abgeschlossene der letzten 24 Std. · POST update / inventory-update.
import {lookup} from './nebu-catalog.mjs';
import {json,readJson,tx,pool,audit,logError,getSetting,setSetting,config} from '../lib/core.mjs';
import {requireStaff} from '../lib/auth.mjs';
import {rowToOrder,staffView,applyStaffUpdate,orderColumns,sendPush,CUSTOMER_MESSAGES,FINAL_STATES} from '../lib/orders.mjs';

const UPDATE_FIELDS=new Set(['action','id','expectedVersion','status','eta','riskReviewed','cancelReason','paymentReceived','paymentReason']);

export default async req=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Methode nicht erlaubt'},405);
 const auth=await requireStaff(req);if(auth.error)return auth.error;
 try{
  if(req.method==='GET'){
   const r=await pool().query("SELECT * FROM nebu_orders WHERE closed_at IS NULL OR closed_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 500");
   return json({orders:r.rows.map(rowToOrder).map(staffView),printAgent:await getSetting('printAgent').catch(()=>null)||null,me:auth.staff,environment:config.environment});
  }
  const {body,error}=await readJson(req);if(error)return error;
  if(body.action==='inventory-update'){
   const ids=body.disabled;
   if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!lookup.has(id)))return json({error:'Ungültige Artikelliste'},422);
   const unique=[...new Set(ids)];
   await tx(async db=>{await setSetting(db,'disabledProducts',unique,auth.staff.name);await audit(db,{staff:auth.staff,action:'inventory',detail:{disabled:unique}})});
   return json({disabled:unique});
  }
  if(body.action!=='update')return json({error:'Ungültige Aktion'},400);
  if(Object.keys(body).some(k=>!UPDATE_FIELDS.has(k)))return json({error:'Nicht erlaubte Bestelländerung'},422);
  if(typeof body.id!=='string'||body.id.length>40||!Number.isInteger(body.expectedVersion)||body.expectedVersion<0)return json({error:'Ungültige Bestellversion'},422);
  if(body.status!==undefined&&typeof body.status!=='string')return json({error:'Ungültiger Bestellstatus'},422);
  if(body.paymentReason!==undefined&&(typeof body.paymentReason!=='string'||body.paymentReason.length>300))return json({error:'Ungültige Begründung'},422);
  const out=await tx(async db=>{
   const r=await db.query('SELECT * FROM nebu_orders WHERE id=$1 FOR UPDATE',[body.id]);
   if(!r.rows[0])return {status:404,body:{error:'Bestellung nicht gefunden'}};
   const res=applyStaffUpdate(rowToOrder(r.rows[0]),body,auth.staff);
   if(res.error)return {status:res.status,body:{error:res.error}};
   if(!res.changed)return {status:200,body:{order:staffView(res.order),unchanged:true,alreadyApplied:true}};
   const c=orderColumns(res.order);
   await db.query('UPDATE nebu_orders SET status=$2, version=$3, data=$4, kitchen_print=$5, updated_at=now(), closed_at=CASE WHEN $6 THEN COALESCE(closed_at,now()) ELSE NULL END WHERE id=$1',[c.id,c.status,c.version,JSON.stringify(c.data),c.kitchenPrint?JSON.stringify(c.kitchenPrint):null,c.closed]);
   const detail={};if(res.next)detail.status=res.next;if(res.next==='accepted')detail.eta=res.order.eta;if(typeof body.paymentReceived==='boolean')detail.paymentReceived=body.paymentReceived;if(res.next==='rejected')detail.reason=res.order.cancelReason;
   await audit(db,{staff:auth.staff,action:res.next?'order_'+res.next:(body.paymentReceived?'payment_confirm':'payment_reverse'),orderId:c.id,detail});
   return {status:200,body:{order:staffView(res.order)},push:res.next?res.order:null};
  });
  if(out.push&&out.push.status){
   const o=out.push;
   try{
    const subs=(await pool().query("SELECT endpoint,subscription FROM nebu_push_subscriptions WHERE kind='customer' AND order_id=$1",[o.id])).rows;
    const m=CUSTOMER_MESSAGES(o)[o.status];
    if(m&&subs.length)await sendPush(subs,{title:'NEBU Sushi · '+m[0],body:m[1],url:'/bestellung.html',tag:'nebu-customer-'+o.id+'-'+o.status},{ttl:180,urgency:'normal'});
    if(FINAL_STATES.includes(o.status))await pool().query("DELETE FROM nebu_push_subscriptions WHERE kind='customer' AND order_id=$1",[o.id]);
   }catch(e){logError('customer push',e)}
  }
  return json(out.body,out.status);
 }catch(e){logError('nebu-orders',e);return json({error:'Serverfehler'},500)}
};
