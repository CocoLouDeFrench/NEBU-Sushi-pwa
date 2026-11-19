// ESC/POS-Küchenbon für Epson TM-T20III, 80 mm Papier (Font A = 48 Zeichen/Zeile).
const ESC=0x1b,GS=0x1d,DLE=0x10;
export const COLS=48;

// Codepage PC858 (Epson ESC t 19): Umlaute, ß und €.
const PC858={'Ç':0x80,'ü':0x81,'é':0x82,'â':0x83,'ä':0x84,'à':0x85,'å':0x86,'ç':0x87,'ê':0x88,'ë':0x89,'è':0x8a,'ï':0x8b,'î':0x8c,'ì':0x8d,'Ä':0x8e,'Å':0x8f,'É':0x90,'æ':0x91,'Æ':0x92,'ô':0x93,'ö':0x94,'ò':0x95,'û':0x96,'ù':0x97,'ÿ':0x98,'Ö':0x99,'Ü':0x9a,'ø':0x9b,'£':0x9c,'Ø':0x9d,'×':0x9e,'á':0xa0,'í':0xa1,'ó':0xa2,'ú':0xa3,'ñ':0xa4,'Ñ':0xa5,'¿':0xa8,'½':0xab,'¼':0xac,'¡':0xad,'«':0xae,'»':0xaf,'Á':0xb5,'Â':0xb6,'À':0xb7,'ã':0xc6,'Ã':0xc7,'€':0xd5,'Ê':0xd2,'Ë':0xd3,'È':0xd4,'Í':0xd6,'Î':0xd7,'Ï':0xd8,'Ì':0xde,'Ó':0xe0,'ß':0xe1,'Ô':0xe2,'Ò':0xe3,'õ':0xe4,'Õ':0xe5,'µ':0xe6,'Ú':0xe9,'Û':0xea,'Ù':0xeb,'°':0xf8,'·':0xfa};
const REPL={'–':'-','—':'-','„':'"','“':'"','”':'"','‚':"'",'‘':"'",'’':"'",'…':'...','•':'*','\t':' '};

// Nur druckbare Zeichen: Steuerzeichen aus Kundentext dürfen keine Druckerbefehle auslösen.
export function clean(value){
 let out='';
 for(const ch of String(value??'').normalize('NFC')){
  if(REPL[ch]){out+=REPL[ch];continue}
  const c=ch.codePointAt(0);
  if(c===0x0a){out+='\n';continue}
  if(c<0x20||c===0x7f||(c>=0x80&&c<0xa0))continue;
  if(c<0x80||PC858[ch]){out+=ch;continue}
  const base=ch.normalize('NFD').replace(/[̀-ͯ]/g,'');
  out+=[...base].every(x=>x.codePointAt(0)<0x80||PC858[x])?base:'?';
 }
 return out.replace(/\?{2,}/g,'?');
}
export function encode(text){
 const bytes=[];
 for(const ch of clean(text)){const c=ch.codePointAt(0);bytes.push(c<0x80?c:(PC858[ch]??0x3f))}
 return bytes;
}
export function wrap(text,width){
 const lines=[];
 for(const para of clean(text).split('\n')){
  let line='';
  for(let word of para.split(/ +/).filter(Boolean)){
   while(word.length>width){if(line){lines.push(line);line=''}lines.push(word.slice(0,width));word=word.slice(width)}
   if(!word)continue;
   if(!line)line=word;else if(line.length+1+word.length<=width)line+=' '+word;else{lines.push(line);line=word}
  }
  if(line)lines.push(line);
 }
 return lines;
}
const fmt=(iso,opts)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString('de-DE',{timeZone:'Europe/Berlin',...opts})};
export const clock=iso=>fmt(iso,{hour:'2-digit',minute:'2-digit'});

// Liefert die Bytes für einen Küchenbon.
export function renderTicket(t,{printedAt=new Date().toISOString(),reprint=false}={}){
 const b=[];
 const raw=(...x)=>b.push(...x);
 const txt=s=>b.push(...encode(s));
 const nl=(n=1)=>{for(let i=0;i<n;i++)b.push(0x0a)};
 const align=n=>raw(ESC,0x61,n); // 0 links, 1 mitte
 const size=(w,h)=>raw(GS,0x21,((w-1)<<4)|(h-1));
 const bold=on=>raw(ESC,0x45,on?1:0);
 const invert=on=>raw(GS,0x42,on?1:0);
 const rule=ch=>{size(1,1);txt(ch.repeat(COLS));nl()};
 const pickup=t.fulfillment==='pickup';

 raw(ESC,0x40);        // Reset
 raw(ESC,0x74,19);     // Codepage PC858
 raw(ESC,0x32);        // Standard-Zeilenabstand
 align(1);size(2,2);bold(true);txt('NEBU · KÜCHE');nl();
 size(3,3);txt('#'+t.id);nl();
 size(2,2);invert(true);txt(' '+(pickup?'ABHOLUNG':'LIEFERUNG')+' ');invert(false);nl();
 if(reprint){size(1,1);txt('*** ERNEUTER DRUCK ***');nl()}
 bold(false);size(1,1);nl();
 align(0);
 if(t.deliveryDueAt){
  size(2,2);bold(true);txt((pickup?'Abholung ':'Fertig ')+clock(t.deliveryDueAt)+' Uhr');nl();
  size(1,1);bold(false);txt('('+(t.eta?t.eta+' Min. ab Annahme':'')+(pickup?'':', Lieferzeit')+')');nl();
 }else{size(1,2);bold(true);txt('Zeit: '+(t.eta?t.eta+' Minuten':'nicht angegeben'));nl();bold(false)}
 size(1,1);
 txt('Angenommen '+clock(t.acceptedAt)+'   Bestellt '+clock(t.createdAt));nl();
 if(t.customer){bold(true);txt('Kunde: ');bold(false);txt(wrap(t.customer,COLS-7)[0]||'');nl()}
 rule('=');
 let count=0;
 for(const item of t.items||[]){
  const qty=String(item.qty)+'x';count+=Number(item.qty)||0;
  const prefix=qty.padEnd(4,' ');
  // Doppelte Höhe, normale Breite: gut lesbar, 48 Zeichen bleiben erhalten.
  size(1,2);bold(true);
  wrap(item.name,COLS-4).forEach((line,i)=>{txt((i?'    ':prefix)+line);nl()});
  bold(false);
 }
 size(1,1);rule('-');
 txt('Artikel gesamt: '+count);nl();
 rule('=');
 if(t.notes&&clean(t.notes).trim()){
  invert(true);bold(true);txt(' SONDERWÜNSCHE ');invert(false);nl();
  size(1,2);for(const line of wrap(t.notes,COLS))(txt(line),nl());bold(false);size(1,1);
  rule('=');
 }else{txt('Sonderwünsche: keine');nl();rule('-')}
 align(1);txt('Gedruckt '+fmt(printedAt,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · automatisch');nl();
 nl(4);
 raw(GS,0x56,0x42,0x03); // Vorschub + Teilschnitt
 return Buffer.from(b);
}

export function renderTestPage(){
 const b=[ESC,0x40,ESC,0x74,19,ESC,0x61,1,GS,0x21,0x11,...encode('NEBU Druckdienst'),0x0a,GS,0x21,0,...encode('Testdruck ok · Umlaute: ÄÖÜ äöü ß €'),0x0a,...encode(new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'})),0x0a,0x0a,0x0a,0x0a,GS,0x56,0x42,0x03];
 return Buffer.from(b);
}

// Echtzeit-Statusabfragen (DLE EOT n). Antwort jeweils 1 Byte.
export const STATUS_QUERIES=[[DLE,0x04,1],[DLE,0x04,2],[DLE,0x04,4]];
export function interpretStatus([s1,s2,s4]){
 // Nur eine vollständige Antwort gilt als „bereit“ – fehlende Antworten bedeuten: nicht bereit.
 if(s1===undefined)return {ok:false,detail:'keine Antwort vom Drucker (offline, Deckel offen oder Fehler?)'};
 if(s2===undefined||s4===undefined)return {ok:false,detail:'Drucker antwortet unvollständig (offline?)'};
 const problems=[];
 if(s2!==undefined){
  if(s2&0x04)problems.push('Deckel offen');
  if(s2&0x20)problems.push('Papier leer');
  if(s2&0x40)problems.push('Druckerfehler');
 }
 if(s4!==undefined&&(s4&0x60)&&!problems.includes('Papier leer'))problems.push('Papier leer');
 if((s1&0x08)&&!problems.length)problems.push('Drucker offline');
 const nearEnd=s4!==undefined&&(s4&0x0c);
 return problems.length?{ok:false,detail:problems.join(', ')}:{ok:true,detail:nearEnd?'bereit · Papier fast leer':'bereit'};
}
