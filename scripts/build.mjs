// Baut die zu veröffentlichende Seite nach dist/ – je nach Umgebung (NEBU_ENV=live|test).
//  live: Shop (wie bisher) unter /, Online-Bestellung als Zusatz, Bestellstatus /bestellung.html, NEBU Control unter /control/.
//        Testseiten werden NICHT veröffentlicht.
//  test: NEBU Control unter / (wie bisher), Kunden-Testseite, Shop-Vorschau /shop.html (Bilder vom Live-Shop).
import fs from 'node:fs';
import path from 'node:path';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const OUT=path.join(ROOT,'dist');
const ENV=process.env.NEBU_ENV==='live'?'live':'test';
const r=p=>path.join(ROOT,p);
const copy=(from,to)=>{if(!fs.existsSync(r(from)))return false;fs.mkdirSync(path.dirname(path.join(OUT,to)),{recursive:true});fs.cpSync(r(from),path.join(OUT,to),{recursive:true});return true};
const write=(to,content)=>{fs.mkdirSync(path.dirname(path.join(OUT,to)),{recursive:true});fs.writeFileSync(path.join(OUT,to),content)};
fs.rmSync(OUT,{recursive:true,force:true});fs.mkdirSync(OUT);

const ADDON='<script src="/nebu-online.js" defer></script>';
function shopHtml({imageBase=''}={}){
 let html=fs.readFileSync(r('index.html'),'utf8');
 if(!html.includes('</body>'))throw Error('index.html ohne </body>');
 if(imageBase)html=html.replace(/(["'(])images\//g,'$1'+imageBase+'images/').replace(/(["'(])nebu-logo\.png/g,'$1'+imageBase+'nebu-logo.png');
 return html.replace('</body>',ADDON+'\n</body>');
}
const CSP_BASE="default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; upgrade-insecure-requests";
const headers=(img)=>`/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${CSP_BASE}; img-src ${img}
/control/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
/bestellung.html
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
/print-agent/*
  X-Robots-Tag: noindex, nofollow
`;

if(ENV==='live'){
 write('index.html',shopHtml());
 for(const f of ['images','nebu-logo.png','robots.txt','sitemap.xml'])copy(f,f);
 copy('shop-addon/nebu-online.js','nebu-online.js');copy('shop-addon/bestellung.html','bestellung.html');
 copy('push-test/shop-product-map.json','shop-product-map.json');
 for(const f of ['index.html','manifest.webmanifest','sw.js','icon.svg'])copy('push-test/'+f,'control/'+f);
 // NEBU Control live: Testhinweise anpassen
 let control=fs.readFileSync(path.join(OUT,'control/index.html'),'utf8').replace('Bestellcenter · Testumgebung','Bestellcenter').replace('Isolierter iPhone-Test · keine echten Bestellungen','Geräte-Einstellungen');
 fs.writeFileSync(path.join(OUT,'control/index.html'),control);
 write('_headers',headers("'self' data:"));
}else{
 for(const f of fs.readdirSync(r('push-test')))if(f!=='_headers')copy('push-test/'+f,f);
 write('shop.html',shopHtml({imageBase:'https://shop.nebusushi.com/'}));
 copy('shop-addon/nebu-online.js','nebu-online.js');copy('shop-addon/bestellung.html','bestellung.html');
 write('_headers',headers("'self' data: https://shop.nebusushi.com")+'/*\n  X-Robots-Tag: noindex, nofollow\n');
}
// Druckdienst-Paket bleibt bewusst nicht öffentlich: es wird als ZIP direkt an den Restaurant-PC gegeben.
console.log('NEBU build ('+ENV+') → dist/: '+fs.readdirSync(OUT).join(', '));
