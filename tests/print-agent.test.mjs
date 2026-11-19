import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nebu-print-'));
process.env.NEBU_PRINT_DATA=dir;
const {renderTicket,clean,wrap,interpretStatus}=await import('../print-agent/escpos.mjs');
const {Journal,cycle,loadConfig,sendToPrinter,printerStatus}=await import('../print-agent/nebu-print-agent.mjs');

const ticket={id:'TMI4X2Z1',fulfillment:'pickup',customer:'Anna Müller',items:[{qty:2,name:'Maki Box'},{qty:1,name:'Der Klassiker – große Platte mit extra langem Namen für den Umbruchtest'}],notes:'Ohne Wasabi\x1b@\x1dV, bitte Stäbchen',eta:45,createdAt:'2026-11-19T17:58:00Z',acceptedAt:'2026-11-19T18:00:00Z',deliveryDueAt:'2026-11-19T18:45:00Z'};

// Fake-Epson: beantwortet DLE EOT, sammelt Druckdaten.
function fakePrinter({paper=true}={}){
 const received=[];
 const server=net.createServer(sock=>{let data=Buffer.alloc(0);sock.on('data',d=>{
  for(let i=0;i<d.length;i++){
   if(d[i]===0x10&&d[i+1]===0x04){const n=d[i+2];sock.write(Buffer.from([n===1?0x16:n===2?(paper?0x12:0x32):(paper?0x12:0x72)]));i+=2;continue}
   data=Buffer.concat([data,d.subarray(i,i+1)]);
  }});sock.on('end',()=>{if(data.length)received.push(data);sock.end()})});
 return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,received,port:server.address().port})));
}

test('ticket contains order number, items, notes, time; control bytes from customer are removed',()=>{
 const bytes=renderTicket(ticket,{printedAt:'2026-11-19T18:00:05Z'});
 const latin=bytes.toString('latin1');
 assert.match(latin,/#TMI4X2Z1/);
 assert.match(latin,/ABHOLUNG/);
 assert.match(latin,/2x  Maki Box/);
 assert.match(latin,/Abholung 19:45 Uhr/,'Uhrzeit in deutscher Zeit (UTC+1)');
 assert.match(latin,/SONDERW\x9aNSCHE/,'Ü in PC858');
 assert.match(latin,/Ohne Wasabi@V, bitte St\x84bchen/);
 assert.ok(!latin.includes('\x1b@\x1dV'),'kein eingeschleuster Druckerbefehl');
 assert.ok(bytes.subarray(-4).equals(Buffer.from([0x1d,0x56,0x42,0x03])),'endet mit Schnitt');
 for(const line of wrap(ticket.items[1].name,44))assert.ok(line.length<=44);
 assert.equal(clean('Sushi 🍣 ok'),'Sushi ? ok');
});

test('printer status bits are interpreted',()=>{
 assert.deepEqual(interpretStatus([0x16,0x12,0x12]),{ok:true,detail:'bereit'});
 assert.equal(interpretStatus([0x1e,0x32,0x72]).detail,'Papier leer');
 assert.equal(interpretStatus([0x1e,0x16,0x12]).detail,'Deckel offen');
 assert.equal(interpretStatus([undefined]).ok,false);
});

test('config refuses live shop and missing token',()=>{
 const f=path.join(dir,'c.json');
 fs.writeFileSync(f,JSON.stringify({apiUrl:'https://shop.nebusushi.com',token:'x'.repeat(40),printer:{mode:'tcp',host:'1.2.3.4'}}));
 assert.throws(()=>loadConfig(f),/Live-Shop/);
 fs.writeFileSync(f,JSON.stringify({apiUrl:'https://nebu-iphone-push-test.netlify.app',printer:{mode:'tcp',host:'1.2.3.4'}}));
 assert.throws(()=>loadConfig(f),/token/);
});

test('TCP print to fake Epson, paper status checked',async()=>{
 const p=await fakePrinter();const printer={mode:'tcp',host:'127.0.0.1',port:p.port,timeoutMs:3000};
 assert.equal((await printerStatus(printer)).ok,true);
 const out=await sendToPrinter(printer,renderTicket(ticket));
 assert.equal(out.uncertain,false);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(p.received.length,1);assert.match(p.received[0].toString('latin1'),/#TMI4X2Z1/);
 p.server.close();
 const empty=await fakePrinter({paper:false});
 await assert.rejects(sendToPrinter({...printer,port:empty.port},renderTicket(ticket)),/Papier leer/);
 await new Promise(r=>setTimeout(r,100));assert.equal(empty.received.length,0,'bei leerem Papier wird nichts gesendet');
 empty.server.close();
});

// Simulierter Server mit realistischem Lease-Verhalten.
function fakeServer(){
 const s={jobs:[{jobId:'j1',orderId:'T1',ticket}],acks:[],claims:0,down:false};
 s.call=async(cfg,body)=>{if(s.down)throw Error('offline');if(body.action==='claim'){s.claims++;return {jobs:s.jobs.filter(j=>!s.acks.some(a=>a.jobId===j.jobId&&a.result==='printed'))}}s.acks.push(body);return {ok:true}};
 return s;
}
const okPrinter=async()=>({ok:true,detail:'bereit'});

test('job is printed once even if the server offers it again (lost ack)',async()=>{
 const j=new Journal(path.join(dir,'j1.json'));const srv=fakeServer();let prints=0;
 const send=async()=>{prints++;return {uncertain:false,detail:'ok'}};
 // Bestätigung geht verloren: Server bietet den Auftrag nach Lease-Ablauf erneut an.
 const flaky={...srv,call:async(c,b)=>{if(b.action==='ack'&&!flaky.once){flaky.once=true;throw Error('Netz weg')}return srv.call(c,b)}};
 await cycle({},j,{apiCall:flaky.call,status:okPrinter,send});
 assert.equal(prints,1);
 srv.acks.length=0; // Server hat nichts erhalten
 await cycle({},j,{apiCall:flaky.call,status:okPrinter,send});
 await cycle({},j,{apiCall:flaky.call,status:okPrinter,send});
 assert.equal(prints,1,'kein Doppeldruck');
 assert.ok(srv.acks.some(a=>a.result==='printed'&&a.jobId==='j1'));
});

test('journal survives restart: job interrupted during sending is not reprinted',async()=>{
 const file=path.join(dir,'j2.json');
 new Journal(file).set('j1',{orderId:'T1',state:'sending',acked:false});
 const j=new Journal(file);const srv=fakeServer();let prints=0;
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>{prints++;return {}}});
 assert.equal(prints,0);
 assert.equal(srv.acks[0].uncertain,true,'als „bitte prüfen“ gemeldet');
});

test('printer not ready → job reported as failed, retried later and printed',async()=>{
 const j=new Journal(path.join(dir,'j3.json'));const srv=fakeServer();let prints=0;
 const send=async()=>{prints++;return {uncertain:false,detail:'ok'}};
 await cycle({},j,{apiCall:srv.call,status:async()=>({ok:false,detail:'Papier leer'}),send});
 assert.equal(prints,0);assert.equal(srv.acks[0].result,'failed');assert.equal(srv.acks[0].error,'Papier leer');
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send});
 assert.equal(prints,1);
});

test('offline NEBU Control: nothing lost, cycle throws for backoff',async()=>{
 const j=new Journal(path.join(dir,'j4.json'));const srv=fakeServer();srv.down=true;
 await assert.rejects(cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>({})}),/offline/);
 srv.down=false;let prints=0;
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>{prints++;return {}}});
 assert.equal(prints,1);
});
