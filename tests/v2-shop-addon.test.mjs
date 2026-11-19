// Shop-Erweiterung im simulierten Browser (jsdom) + Build-Prüfung. Benötigt: npm i --no-save jsdom@24
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
let JSDOM;try{({JSDOM}=await import('jsdom'))}catch{}
const skip=!JSDOM&&'jsdom fehlt';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const build=env=>execFileSync(process.execPath,[path.join(ROOT,'scripts/build.mjs')],{env:{...process.env,NEBU_ENV:env},encoding:'utf8'});

async function boot({config,createResponse,configFails=false}){
 build('test');
 const html=fs.readFileSync(path.join(ROOT,'dist/shop.html'),'utf8').replace('<script src="/nebu-online.js" defer></script>','');
 const addon=fs.readFileSync(path.join(ROOT,'dist/nebu-online.js'),'utf8');
 const map=fs.readFileSync(path.join(ROOT,'dist/shop-product-map.json'),'utf8');
 const calls=[];
 const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://shop.nebusushi.com/',beforeParse(w){
  w.Response=globalThis.Response;w.Element.prototype.scrollIntoView=function(){};
  w.fetch=async(url,init={})=>{url=String(url);const body=init.body?JSON.parse(init.body):null;calls.push({url,body});
   const res=(s,o)=>new w.Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
   if(url.includes('shop-api')&&body.action==='config'){if(configFails)throw new TypeError('offline');return res(200,config)}
   if(url.includes('shop-api')&&body.action==='create')return res(...createResponse);
   if(url.endsWith('shop-product-map.json'))return new w.Response(map,{status:200});
   if(url.includes('menu-state'))return res(200,{statusMode:'open',prepTime:'ca. 35 Minuten',soldOut:[]});
   return res(404,{});
  };
  w.confirm=()=>true;w.alert=()=>{};w.open=(u)=>calls.push({url:'OPEN '+u});
 }});
 const w=dom.window;
 await new Promise(r=>setTimeout(r,50));
 const s=w.document.createElement('script');s.textContent=addon;w.document.body.append(s);
 await new Promise(r=>setTimeout(r,100));
 opened.push(w);return {w,d:w.document,calls};
}
const opened=[];test.after(()=>{for(const w of opened)try{w.close()}catch{}});
const addFirst=(t,n=2)=>{const btn=t.d.querySelector('.add-button');for(let i=0;i<n;i++)btn.click();t.w.renderCart()};

test('WhatsApp mode: shop unchanged (WhatsApp button stays)',{skip},async()=>{
 const t=await boot({config:{orderingMode:'whatsapp',accepting:false,disabled:[]}});
 addFirst(t);
 assert.ok(t.d.querySelector('#cartContent .whatsapp-button'));
 assert.ok(!t.d.querySelector('#nebuSubmit'));
});

test('server unreachable: automatic fallback to WhatsApp',{skip},async()=>{
 const t=await boot({configFails:true});
 addFirst(t);
 assert.match(t.d.querySelector('#cartContent .whatsapp-button').textContent,/WhatsApp/);
 assert.ok(!t.d.querySelector('#nebuSubmit'));
});

test('online mode: pickup order sent with catalog IDs, cart cleared, status page opened',{skip},async()=>{
 const t=await boot({config:{orderingMode:'online',accepting:true,prepTime:'ca. 35 Minuten',disabled:[]},createResponse:[201,{order:{id:'N123ABC'},token:'tok-1'}]});
 addFirst(t,2);
 assert.ok(!t.d.querySelector('#cartContent .whatsapp-button:not(#nebuSubmit)'),'WhatsApp-Button ersetzt');
 assert.ok(!t.d.querySelector('#pickupTimeNow'),'keine Abholzeit-Auswahl (Personal legt Zeit fest)');
 const btn=t.d.querySelector('#nebuSubmit');assert.equal(btn.textContent,'Zahlungspflichtig bestellen');
 t.d.getElementById('customerName').value='Anna';t.d.getElementById('customerPhone').value='0211 1234567';t.d.getElementById('orderNote').value='ohne Wasabi';
 btn.click();await new Promise(r=>setTimeout(r,50));
 const create=t.calls.find(c=>c.body?.action==='create');
 assert.ok(create,'Bestellung gesendet');
 assert.equal(create.body.fulfillment,'pickup');assert.equal(create.body.notes,'ohne Wasabi');
 assert.deepEqual(create.body.cart,[{id:'p001',qty:2}]);
 for(const f of ['total','price','status'])assert.equal(create.body[f],undefined,'keine Preise vom Browser: '+f);
 assert.deepEqual(JSON.parse(t.w.localStorage.getItem('nebu-order')),{...JSON.parse(t.w.localStorage.getItem('nebu-order')),id:'N123ABC',token:'tok-1'});
});

test('online mode: delivery needs address; server error shown; closed shop disables button',{skip},async()=>{
 const t=await boot({config:{orderingMode:'online',accepting:true,disabled:[]},createResponse:[422,{error:'Über 3 km Fahrstrecke: Bitte Selbstabholung wählen.',offerPickup:true}]});
 addFirst(t,1);
 [...t.d.querySelectorAll('.pickup-mode-button')].find(b=>b.textContent==='Lieferung').click();
 assert.notEqual(t.d.getElementById('nebuDelivery').style.display,'none');
 t.d.getElementById('customerName').value='Ben';t.d.getElementById('customerPhone').value='0211 7654321';
 t.d.getElementById('nebuSubmit').click();await new Promise(r=>setTimeout(r,20));
 assert.match(t.d.getElementById('nebuMsg').textContent,/Lieferadresse/);
 const addr=t.d.getElementById('nebuAddress');addr.value='Weit weg 1, 40000';addr.dispatchEvent(new t.w.Event('input'));
 t.d.getElementById('nebuSubmit').click();await new Promise(r=>setTimeout(r,50));
 assert.match(t.d.getElementById('nebuMsg').textContent,/3 km.*Abholung/);
 assert.equal(t.calls.find(c=>c.body?.action==='create').body.address,'Weit weg 1, 40000');

 const c=await boot({config:{orderingMode:'online',accepting:false,reason:'Online-Bestellungen sind täglich 16:00–21:00 Uhr möglich.',disabled:[]}});
 addFirst(c,1);
 assert.equal(c.d.getElementById('nebuSubmit').disabled,true);
 assert.match(c.d.getElementById('cartContent').textContent,/16:00–21:00/);
});

test('live build: shop at /, control under /control/, no test pages, noindex for internal pages',()=>{
 build('live');
 const dist=path.join(ROOT,'dist');
 assert.ok(fs.existsSync(path.join(dist,'control/index.html')));
 for(const f of ['security-check.html','security-test.html','customer.html','shop.html'])assert.ok(!fs.existsSync(path.join(dist,f)),f+' darf nicht live sein');
 const shop=fs.readFileSync(path.join(dist,'index.html'),'utf8');
 assert.match(shop,/<script src="\/nebu-online.js" defer><\/script>\s*<\/body>/);
 assert.match(shop,/sendWhatsAppOrder/,'WhatsApp-Weg bleibt im Shop enthalten (Rückweg)');
 const headers=fs.readFileSync(path.join(dist,'_headers'),'utf8');
 assert.match(headers,/\/control\/\*\n\s+X-Robots-Tag: noindex/);
 assert.doesNotMatch(fs.readFileSync(path.join(dist,'control/index.html'),'utf8'),/Testumgebung/);
 build('test');
});

test('shop menu (index.html) matches the server catalog: names, categories, prices',async()=>{
 const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
 const start=html.indexOf('const menu = [');let i=html.indexOf('[',start),depth=0,end=i;
 for(;end<html.length;end++){const ch=html[end];if(ch==='[')depth++;else if(ch===']'){depth--;if(!depth)break}}
 const menu=Function('return '+html.slice(i,end+1))();
 const {catalog}=await import('../netlify/functions/nebu-catalog.mjs');
 const byKey=new Map(catalog.map(p=>[p.category+'||'+p.name,p]));
 let n=0;
 for(const g of menu)for(const it of g.items){n++;const p=byKey.get(g.category+'||'+it.name);assert.ok(p,'Im Server-Katalog fehlt: '+g.category+' / '+it.name);assert.equal(p.cents,Math.round(it.price*100),'Preis weicht ab: '+it.name)}
 assert.equal(n,catalog.length,'Anzahl Artikel Shop = Katalog');
});
