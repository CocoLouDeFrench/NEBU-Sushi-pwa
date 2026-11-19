// Anbindung an den bisherigen Shop-Admin (/api/menu-state, Blob „nebu-sushi-state“):
// Öffnungsstatus, Zubereitungszeit und Ausverkauft-Liste werden weiterhin dort gepflegt (Inhaber-Entscheidung).
import {getStore} from '@netlify/blobs';
import {catalog} from '../functions/nebu-catalog.mjs';

export const OPENING={open:16*60,lastOrder:20*60+50,label:'täglich 16:00–21:00 Uhr (letzte Bestellung 20:50 Uhr)'};
const shopKeyToId=new Map(catalog.map(p=>[p.category+'||'+p.name,p.id]));

export async function shopState(){
 try{
  const s=await getStore('nebu-sushi-state').get('state',{type:'json'});
  const statusMode=['auto','open','closed'].includes(s?.statusMode)?s.statusMode:(s?.isOpen===false?'closed':'auto');
  const soldOutKeys=Array.isArray(s?.soldOut)?s.soldOut.filter(k=>typeof k==='string').slice(0,200):[];
  return {statusMode,prepTime:typeof s?.prepTime==='string'&&s.prepTime.trim()?s.prepTime.trim().slice(0,80):'ca. 35 Minuten',soldOutIds:soldOutKeys.map(k=>shopKeyToId.get(k)).filter(Boolean)};
 }catch{return {statusMode:'auto',prepTime:'ca. 35 Minuten',soldOutIds:[],unavailable:true}}
}
export function berlinMinutes(d=new Date()){
 const p=new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
 return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);
}
// Ob gerade bestellt werden kann. Öffnungszeiten gelten nur live (Test soll jederzeit testbar sein).
export function acceptingNow(state,environment,now=new Date()){
 if(state.statusMode==='closed')return {ok:false,reason:'Wir nehmen gerade keine Bestellungen an. Öffnungszeiten: '+OPENING.label+'.'};
 if(state.statusMode==='open'||environment!=='live')return {ok:true};
 const m=berlinMinutes(now);
 return m>=OPENING.open&&m<OPENING.lastOrder?{ok:true}:{ok:false,reason:'Online-Bestellungen sind '+OPENING.label+' möglich.'};
}
