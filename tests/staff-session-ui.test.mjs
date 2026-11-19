import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let JSDOM;try{({JSDOM}=await import('jsdom'))}catch{}
const skip=!JSDOM&&'jsdom nicht installiert (npm i --no-save jsdom@24)';
const html=readFileSync(new URL('../push-test/index.html',import.meta.url),'utf8');
function boot({loginOk=true,renewable=false}={}){
 let now=Date.UTC(2026,10,19,12,0,0);const timers=[];
 const calls=[];let orders=[{id:'T1',status:'new',fulfillment:'delivery',version:0,customer:'Anna',phone:'0211123456',address:'Kö 1',items:[{name:'Maki',qty:1,price:5}],total:5,paymentReceived:false,createdAt:new Date(now).toISOString()},
  {id:'T2',status:'enroute',fulfillment:'delivery',version:3,customer:'Ben',phone:'0211654321',address:'Kö 2',items:[],total:9,paymentReceived:true,paymentReversed:false,paymentHistory:[{at:new Date(now).toISOString(),from:false,to:true,orderStatus:'enroute',reason:null}],createdAt:new Date(now).toISOString()}];
 let serverRejects=false;let prompts=[];let confirms=true;
 const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://nebu-iphone-push-test.netlify.app/',beforeParse(w){
  w.Date=class extends Date{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}};
  w.setInterval=(fn,ms)=>{timers.push({fn,ms,next:now+ms});return timers.length};w.setTimeout=(fn)=>{fn();return 0};
  w.alert=m=>calls.push(['alert',m]);w.confirm=()=>confirms;w.prompt=()=>prompts.shift()??null;
  w.navigator.vibrate=()=>true;w.Response=globalThis.Response;
  w.fetch=async(url,init={})=>{url=String(url);const b=init.body?JSON.parse(init.body):null;calls.push([url,b&&b.action||init.method||'GET',(init.headers||{}).authorization||null]);
   const res=(st,obj)=>new w.Response(JSON.stringify(obj),{status:st,headers:{'content-type':'application/json'}});
   if(url.endsWith('staff-login')&&renewable&&b&&b.renew){const a=(init.headers||{}).authorization||'';return a.startsWith('Bearer tok')?res(200,{token:'tok'+now,expiresInSeconds:1800,sessionEndsAt:new Date(Date.UTC(2026,10,20,0,0,0)).toISOString()}):res(403,{error:'Sitzung abgelaufen'})}
   if(url.endsWith('staff-login')&&renewable&&b.key==='richtig')return res(200,{token:'tok'+now,expiresInSeconds:1800,sessionEndsAt:new Date(Date.UTC(2026,10,20,0,0,0)).toISOString()});
   if(url.endsWith('staff-login'))return loginOk&&b.key==='richtig'?res(200,{token:'tok'+now,expiresInSeconds:1800}):res(403,{error:'Zugang verweigert'});
   if(url.includes('demo-orders')){if(serverRejects)return res(403,{error:'Nur für NEBU-Mitarbeiter'});
    if(!init.method||init.method==='GET')return res(200,{orders});
    if(b.action==='inventory')return res(200,{disabled:[]});
    if(b.action==='update'){const o=orders.find(x=>x.id===b.id);calls.push(['UPDATE',b]);if(b.paymentReceived===false&&!b.paymentReason)return res(422,{error:'Begründung fehlt'});Object.assign(o,{paymentReceived:b.paymentReceived,version:o.version+1});return res(200,{order:o})}}
   if(url.endsWith('shop-product-map.json'))return res(200,{products:[]});
   return res(200,{});
  };
 }});
 const w=dom.window,d=w.document;
 const advance=async ms=>{const end=now+ms;while(true){const t=timers.filter(t=>t.next<=end).sort((a,b)=>a.next-b.next)[0];if(!t)break;now=t.next;t.next+=t.ms;await t.fn();await new Promise(r=>setImmediate(r))}now=end;await new Promise(r=>setImmediate(r))};
 const flush=()=>new Promise(r=>setTimeout(r,20));
 const login=async key=>{d.getElementById('loginKey').value=key;d.getElementById('loginForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();await flush()};
 return {w,d,calls,advance,flush,login,setReject:v=>serverRejects=v,prompts,setConfirm:v=>confirms=v,orders};
}
const txt=(d,id)=>d.getElementById(id).textContent;

test('initial state: not logged in, no order data shown, no polling',{skip},async()=>{
 const t=boot();await t.flush();
 assert.match(txt(t.d,'sessionInfo'),/Nicht angemeldet/);assert.match(txt(t.d,'remoteorders'),/Bitte anmelden/);
 await t.advance(10000);assert.equal(t.calls.filter(c=>c[0].includes('demo-orders')).length,0);
});
test('login, countdown, auto-polling with bearer token',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();assert.equal(t.d.getElementById('loginOverlay').hidden,false);
 await t.login('richtig');
 assert.equal(t.d.getElementById('loginOverlay').hidden,true);assert.match(txt(t.d,'sessionInfo'),/Angemeldet · noch 30 Min/);
 assert.match(txt(t.d,'remoteorders'),/T1|Anna/);assert.equal(t.d.getElementById('loginKey').value,'');assert.equal(t.d.getElementById('testkey').value,'');
 const before=t.calls.length;await t.advance(10000);assert.ok(t.calls.slice(before).some(c=>c[0].includes('demo-orders')&&c[2]==='Bearer tok'+Date.UTC(2026,10,19,12,0,0)));
});
test('wrong code shows error, no session',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('falsch');
 assert.equal(t.d.getElementById('loginError').hidden,false);assert.match(txt(t.d,'loginError'),/Zugang verweigert/);assert.match(txt(t.d,'sessionInfo'),/Nicht angemeldet/);
});
test('warning 5 min before expiry, then expiry clears data and opens login; re-login extends',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');
 await t.advance(20*60000);assert.equal(t.d.getElementById('sessionBanner').hidden,true);
 await t.advance(5*60000);assert.equal(t.d.getElementById('sessionBanner').hidden,false);assert.match(txt(t.d,'sessionBannerText'),/läuft in [1-5] Min ab/);
 await t.advance(5*60000);
 assert.match(txt(t.d,'sessionInfo'),/Nicht angemeldet/);assert.ok(t.d.getElementById('sessionBanner').classList.contains('expired'));
 assert.equal(t.d.getElementById('loginOverlay').hidden,false);assert.doesNotMatch(txt(t.d,'remoteorders'),/Anna|Ben/);
 const n=t.calls.length;await t.advance(30000);assert.equal(t.calls.slice(n).filter(c=>c[0].includes('demo-orders')).length,0,'no polling after expiry');
 await t.login('richtig');assert.match(txt(t.d,'sessionInfo'),/noch 30 Min/);assert.equal(t.d.getElementById('sessionBanner').hidden,true);assert.match(txt(t.d,'remoteorders'),/Anna/);
});
test('renew early from warning banner keeps working',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');await t.advance(26*60000);
 t.d.getElementById('sessionBannerButton').click();assert.equal(t.d.getElementById('loginOverlay').hidden,false);await t.login('richtig');
 assert.match(txt(t.d,'sessionInfo'),/noch 30 Min/);await t.advance(20*60000);assert.match(txt(t.d,'sessionInfo'),/Angemeldet/);
});
test('logout clears token and data immediately',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');
 t.d.getElementById('sessionButton').click();await t.flush();
 assert.match(txt(t.d,'sessionInfo'),/Nicht angemeldet/);assert.match(txt(t.d,'remoteorders'),/Abgemeldet/);
 const n=t.calls.length;await t.advance(20000);assert.equal(t.calls.slice(n).filter(c=>c[0].includes('demo-orders')).length,0);
});
test('server rejecting the session ends it locally (no stale token reuse)',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');
 t.setReject(true);await t.advance(5000);
 assert.match(txt(t.d,'sessionInfo'),/Nicht angemeldet/);assert.match(txt(t.d,'sessionBannerText'),/Server hat die Sitzung abgelehnt/);assert.doesNotMatch(txt(t.d,'remoteorders'),/Anna/);
 const n=t.calls.length;await t.advance(20000);assert.equal(t.calls.slice(n).filter(c=>c[0].includes('demo-orders')).length,0);
});
test('payment UI: locked on new order; reversal asks for reason and sends it',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');
 // tab "prepare" shows T1 (new)
 const cb1=[...t.d.querySelectorAll('#remoteorders input[type=checkbox]')];assert.ok(cb1.length>=1);assert.equal(cb1[0].disabled,true);assert.match(t.d.getElementById('remoteorders').textContent,/Erst nach Annahme/);
 t.d.querySelector('.tab[data-tab=handoff]').click();await t.flush();
 const cb=t.d.querySelector('#remoteorders input[type=checkbox]');assert.equal(cb.checked,true);
 t.prompts.push('ab');cb.checked=false;cb.dispatchEvent(new t.w.Event('change'));await t.flush();
 assert.equal(cb.checked,true);assert.ok(!t.calls.some(c=>c[0]==='UPDATE'),'no request with too short reason');
 t.prompts.push('Kunde hat Geld zurückbekommen');cb.checked=false;cb.dispatchEvent(new t.w.Event('change'));await t.flush();await t.flush();
 const u=t.calls.find(c=>c[0]==='UPDATE');assert.ok(u);assert.equal(u[1].paymentReceived,false);assert.equal(u[1].paymentReason,'Kunde hat Geld zurückbekommen');
});
test('payment log appears in order details',{skip},async()=>{
 const t=boot();t.d.getElementById('sessionButton').click();await t.login('richtig');
 t.d.querySelector('.tab[data-tab=handoff]').click();await t.flush();
 t.d.querySelector('#remoteorders article').click();await t.flush();
 assert.match(txt(t.d,'detailContent'),/Zahlungsprotokoll/);assert.match(txt(t.d,'detailContent'),/offen → bezahlt/);
});

test('session renews itself in the background until shift end – no repeated login',{skip},async()=>{
 const t=boot({renewable:true});t.d.getElementById('sessionButton').click();await t.login('richtig');
 assert.match(txt(t.d,'sessionInfo'),/Schicht bis/);
 await t.advance(2*60*60*1000); // 2 Stunden aktiv
 assert.match(txt(t.d,'sessionInfo'),/Angemeldet/);
 assert.equal(t.d.getElementById('loginOverlay').hidden,true,'kein erneutes Anmelden');
 const renewals=t.calls.filter(c=>c[0].endsWith('staff-login')&&c[2]);
 assert.ok(renewals.length>=4,'Token wurde mehrfach verlängert');
 const last=t.calls.filter(c=>c[0].includes('demo-orders')).at(-1);
 assert.notEqual(last[2],'Bearer tok'+Date.UTC(2026,10,19,12,0,0),'neuer Token in Benutzung');
 assert.ok(JSON.parse(t.w.sessionStorage.getItem('nebu-staff-session')).t.startsWith('tok'),'Sitzung übersteht Neuladen im Tab');
 t.d.getElementById('sessionButton').click();
 assert.equal(t.w.sessionStorage.getItem('nebu-staff-session'),null,'Abmelden löscht gespeicherte Sitzung');
});
