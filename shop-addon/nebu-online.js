// NEBU Online-Bestellung für shop.nebusushi.com.
// Ergänzt den bestehenden Shop, ohne ihn umzubauen: Nur wenn NEBU Control auf „Online-Bestellung“ steht,
// wird der WhatsApp-Abschnitt im Warenkorb durch das Online-Formular ersetzt.
// Fällt der Server aus oder steht der Schalter auf WhatsApp, bleibt alles wie bisher (WhatsApp-Bestellung).
(()=>{'use strict';
const API='/.netlify/functions/shop-api';
const ORDER_KEY='nebu-order';
let cfg=null,idMap=null,busy=false;
const form={fulfillment:'pickup',email:'',address:'',bell:'',floor:''};
const h=(tag,props={},...kids)=>{const e=document.createElement(tag);for(const [k,v] of Object.entries(props)){if(k==='on')for(const [ev,fn] of Object.entries(v))e.addEventListener(ev,fn);else if(k==='style')e.setAttribute('style',v);else if(k in e)e[k]=v;else e.setAttribute(k,v)}for(const c of kids.flat())if(c!=null)e.append(c instanceof Node?c:document.createTextNode(String(c)));return e};
const euroFmt=n=>Number(n).toFixed(2).replace('.',',')+' €';
async function post(body){const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json()}catch{}return {ok:r.ok,status:r.status,data:d}}

async function init(){
 try{const r=await post({action:'config'});if(!r.ok)return;cfg=r.data}catch{return}
 if(!cfg||cfg.orderingMode!=='online')return;
 try{const m=await fetch('/shop-product-map.json',{cache:'no-store'}).then(r=>r.json());idMap=new Map(m.products.map(p=>[p.shopKey,p.testId]))}catch{cfg=null;return}
 if(typeof window.renderCart!=='function')return;
 const original=window.renderCart;
 window.renderCart=function(){const out=original.apply(this,arguments);try{transform()}catch(e){console.warn('NEBU online',e&&e.message)}return out};
 activeOrderBanner();
 try{window.renderCart()}catch{}
}

function transform(){
 const box=document.querySelector('#cartContent .order-form');if(!box)return;
 // WhatsApp-spezifische Teile entfernen (Abholzeit-Auswahl, WhatsApp-Button, WhatsApp-Hinweis, Öffnungs-Banner des Shops).
 box.querySelectorAll('.pickup-mode-toggle,#pickupMode,#pickupTimeNow,#pickupTimeLater,.whatsapp-button,.cart-notice').forEach(n=>n.remove());
 document.querySelectorAll('#cartContent > .cart-notice').forEach(n=>n.remove());
 const prev=box.previousElementSibling;if(prev&&!prev.classList.contains('cart-total')&&prev.tagName==='DIV')prev.remove();
 const phone=box.querySelector('#customerPhone'),note=box.querySelector('#orderNote');
 if(note)note.placeholder='Sonderwünsche (z. B. ohne Wasabi)';
 const delivery=h('div',{id:'nebuDelivery',style:form.fulfillment==='delivery'?'':'display:none'},
  h('input',{id:'nebuAddress',type:'text',placeholder:'Straße, Hausnummer, PLZ *',autocomplete:'street-address',maxLength:150,value:form.address,on:{input:e=>form.address=e.target.value}}),
  h('input',{id:'nebuBell',type:'text',placeholder:'Name an der Klingel',maxLength:80,value:form.bell,on:{input:e=>form.bell=e.target.value}}),
  h('input',{id:'nebuFloor',type:'text',placeholder:'Etage',maxLength:30,value:form.floor,on:{input:e=>form.floor=e.target.value}}),
  h('div',{className:'cart-notice'},'Lieferung bis 3 km Fahrstrecke (nicht in die Altstadt). Bis 1,5 km: 2,00 € Liefergebühr, Mindestbestellwert 30 €. Bis 3 km: 3,50 €, Mindestbestellwert 40 €.'));
 const modeBtn=(mode,label)=>h('button',{type:'button',className:'pickup-mode-button'+(form.fulfillment===mode?' active':''),on:{click:()=>{form.fulfillment=mode;window.renderCart()}}},label);
 const toggle=h('div',{className:'pickup-mode-toggle'},modeBtn('pickup','Abholung'),modeBtn('delivery','Lieferung'));
 const email=h('input',{id:'nebuEmail',type:'email',placeholder:'E-Mail (optional)',autocomplete:'email',maxLength:254,value:form.email,on:{input:e=>form.email=e.target.value}});
 const honeypot=h('input',{id:'nebuWebsite',type:'text',tabIndex:-1,autocomplete:'off',style:'position:absolute;left:-9999px;width:1px;height:1px;opacity:0','aria-hidden':'true'});
 const msg=h('div',{id:'nebuMsg',className:'cart-notice',role:'alert',style:'color:#ffb3b3'});
 const closed=!cfg.accepting;
 const button=h('button',{type:'button',className:'whatsapp-button',id:'nebuSubmit',style:'background:var(--gold);color:black'+(closed?';opacity:.45':''),disabled:closed,on:{click:submit}},'Zahlungspflichtig bestellen');
 const info=h('div',{className:'cart-notice'},
  'Bezahlung: bar bei Abholung bzw. beim Fahrer. Deine Abhol- bzw. Lieferzeit bestätigen wir direkt nach Annahme'+(cfg.prepTime?' (Zubereitung aktuell '+cfg.prepTime+')':'')+'. Den Status siehst du nach dem Absenden.');
 const anchor=phone||box.firstChild;
 anchor.after(toggle,delivery,email);
 if(note)note.after(honeypot);else box.append(honeypot);
 box.append(...(closed?[h('div',{className:'cart-notice',style:'color:#ffb3b3'},cfg.reason||'Wir nehmen gerade keine Bestellungen an.')]:[]),button,msg,info);
}

function setMsg(text){const m=document.getElementById('nebuMsg');if(m)m.textContent=text||''}
async function submit(){
 if(busy)return;
 const val=id=>(document.getElementById(id)?.value||'').trim();
 const customer=val('customerName'),phone=val('customerPhone'),notes=val('orderNote');
 if(!customer)return setMsg('Bitte deinen Namen eintragen.');
 if(!phone)return setMsg('Bitte deine Telefonnummer eintragen.');
 if(form.fulfillment==='delivery'&&form.address.trim().length<8)return setMsg('Bitte die vollständige Lieferadresse eintragen.');
 const entries=Object.entries(window.cart||cart);
 if(!entries.length)return setMsg('Dein Warenkorb ist leer.');
 const lines=entries.map(([key,item])=>({id:idMap.get(key),qty:item.quantity}));
 if(lines.some(l=>!l.id))return setMsg('Ein Artikel konnte nicht zugeordnet werden. Bitte Seite neu laden oder telefonisch bestellen.');
 const total=entries.reduce((s,[,i])=>s+i.price*i.quantity,0);
 if(!window.confirm('Bitte kurz prüfen:\n\n'+(form.fulfillment==='delivery'?'Lieferung an: '+form.address.trim():'Abholung im Restaurant')+'\nName: '+customer+'\nTelefon: '+phone+'\nWarenwert: '+euroFmt(total)+(form.fulfillment==='delivery'?' zzgl. Liefergebühr':'')+'\n\nJetzt zahlungspflichtig bestellen?'))return;
 busy=true;const btn=document.getElementById('nebuSubmit');if(btn){btn.disabled=true;btn.textContent='Wird gesendet …'}setMsg('');
 try{
  const body={action:'create',requestId:crypto.randomUUID(),customer,phone,email:form.email.trim(),notes,fulfillment:form.fulfillment,cart:lines};
  if(form.fulfillment==='delivery')Object.assign(body,{address:form.address.trim(),bell:form.bell.trim(),floor:form.floor.trim()});
  const hp=val('nebuWebsite');if(hp)body.website=hp;
  const r=await post(body);
  if(r.ok&&r.data.order&&r.data.token){
   try{localStorage.setItem(ORDER_KEY,JSON.stringify({id:r.data.order.id,token:r.data.token,at:Date.now()}))}catch{}
   try{for(const k of Object.keys(cart))delete cart[k];if(typeof updateCartIndicators==='function')updateCartIndicators()}catch{}
   location.href='/bestellung.html';return;
  }
  if(r.status===409&&r.data.orderingMode==='whatsapp'){setMsg('Online-Bestellung ist gerade nicht aktiv. Die Seite wird neu geladen – bitte per WhatsApp bestellen.');setTimeout(()=>location.reload(),2500);return}
  setMsg((r.data.error||'Bestellung fehlgeschlagen.')+(r.data.offerPickup?' Du kannst stattdessen „Abholung“ wählen.':''));
 }catch{setMsg('Keine Verbindung. Bitte erneut versuchen oder telefonisch bestellen.')}
 finally{busy=false;const b=document.getElementById('nebuSubmit');if(b&&b.textContent==='Wird gesendet …'){b.disabled=!cfg.accepting;b.textContent='Zahlungspflichtig bestellen'}}
}

function activeOrderBanner(){
 let o=null;try{o=JSON.parse(localStorage.getItem(ORDER_KEY)||'null')}catch{}
 if(!o||!o.id||Date.now()-o.at>24*3600000)return;
 document.body.append(h('a',{href:'/bestellung.html',style:'position:fixed;left:12px;right:12px;bottom:12px;z-index:999;background:var(--gold);color:black;font-weight:800;text-align:center;padding:12px;border-radius:12px;text-decoration:none'},'Deine Bestellung #'+o.id+' – Status ansehen'));
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
