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

// Fake-Epson: beantwortet DLE EOT und GS ( H (Prozess-ID), sammelt Druckdaten.
// state.cover=true simuliert offenen Deckel: Drucker offline, Echtzeit-Status wird (wie beim echten Gerät) NICHT beantwortet,
// empfangene Daten bleiben im Puffer und werden nach dem Schließen gedruckt.
function fakePrinter({paper=true,answerWhenOffline=false,coverOpensDuringPrint=false}={}){
 const state={cover:false,printed:[],pending:[],sockets:new Set()};
 const flush=()=>{for(const p of state.pending.splice(0)){state.printed.push(p.data);if(p.pid&&!p.sock.destroyed)p.sock.write(Buffer.from([0x37,0x22,...p.pid,0x00]))}};
 state.close=()=>{state.cover=false;flush()};
 const server=net.createServer(sock=>{state.sockets.add(sock);let data=[];sock.on('error',()=>{});sock.on('data',d=>{
  for(let i=0;i<d.length;i++){
   if(d[i]===0x10&&d[i+1]===0x04){const n=d[i+2];i+=2;
    if(state.cover&&!answerWhenOffline)continue;
    const off=state.cover?0x08:0;
    sock.write(Buffer.from([n===1?0x16|off:n===2?(0x12|(state.cover?0x04:0)|(paper?0:0x20)):(paper?0x12:0x72)]));continue}
   if(d[i]===0x1d&&d[i+1]===0x28&&d[i+2]===0x48){const pid=[...d.subarray(i+7,i+11)];i+=10;
    const job={data:Buffer.from(data),pid,sock};data=[];
    if(coverOpensDuringPrint){coverOpensDuringPrint=false;state.cover=true}
    if(state.cover||!paper)state.pending.push(job);else{state.printed.push(job.data);sock.write(Buffer.from([0x37,0x22,...pid,0x00]))}
    continue}
   data.push(d[i]);
  }})});
 server.unref();
 return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,state,port:server.address().port})));
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

test('TCP print is only reported as printed after the printer confirms it',async()=>{
 const p=await fakePrinter();const printer={mode:'tcp',host:'127.0.0.1',port:p.port,timeoutMs:3000};
 assert.equal((await printerStatus(printer)).ok,true);
 const out=await sendToPrinter(printer,renderTicket(ticket));
 assert.equal(out.confirmed,true);
 assert.equal(p.state.printed.length,1);assert.match(p.state.printed[0].toString('latin1'),/#TMI4X2Z1/);
 p.server.close();
});

test('cover open: status not ready, nothing is sent',async()=>{
 const p=await fakePrinter();p.state.cover=true;const printer={mode:'tcp',host:'127.0.0.1',port:p.port,timeoutMs:3000};
 const st=await printerStatus(printer);assert.equal(st.ok,false);assert.match(st.detail,/keine Antwort/);
 await assert.rejects(sendToPrinter(printer,renderTicket(ticket)),e=>e.sent===false);
 assert.equal(p.state.printed.length+p.state.pending.length,0);
 const q=await fakePrinter({answerWhenOffline:true});q.state.cover=true;
 const st2=await printerStatus({...printer,port:q.port});assert.equal(st2.ok,false);assert.match(st2.detail,/Deckel offen/);
 p.server.close();q.server.close();
});

test('cover opened during print: confirmed once the cover is closed, printed exactly once',async()=>{
 const p=await fakePrinter({coverOpensDuringPrint:true});const printer={mode:'tcp',host:'127.0.0.1',port:p.port,timeoutMs:3000};
 const promise=sendToPrinter(printer,renderTicket(ticket));
 setTimeout(()=>p.state.close(),500); // Deckel wird nach 0,5 s geschlossen
 const out=await promise;
 assert.equal(out.confirmed,true);assert.equal(p.state.printed.length,1);
 p.server.close();
});

test('paper out after sending and not fixed: unconfirmed, never auto-reprinted',async()=>{
 const p=await fakePrinter({paper:false,answerWhenOffline:true});
 const {printTcpForTest}=await import('../print-agent/nebu-print-agent.mjs');
 // Status vorher simuliert ok, damit Daten gesendet werden; danach bleibt Bestätigung aus.
 await assert.rejects(printTcpForTest({mode:'tcp',host:'127.0.0.1',port:p.port,timeoutMs:3000},renderTicket(ticket),{pidWaitMs:300,skipPrecheck:true}),e=>e.sent===true&&/nicht vom Drucker bestätigt/.test(e.message));
 p.server.close();
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
 const send=async()=>{prints++;return {confirmed:true,detail:'ok'}};
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
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>{prints++;return {confirmed:true}}});
 assert.equal(prints,0);
 assert.equal(srv.acks[0].result,'unconfirmed','als „bitte prüfen“ gemeldet, nicht als gedruckt');
});

test('printer not ready → job reported as failed, retried later and printed',async()=>{
 const j=new Journal(path.join(dir,'j3.json'));const srv=fakeServer();let prints=0;
 const send=async()=>{prints++;return {confirmed:true,detail:'ok'}};
 await cycle({},j,{apiCall:srv.call,status:async()=>({ok:false,detail:'Papier leer'}),send});
 assert.equal(prints,0);assert.equal(srv.acks[0].result,'failed');assert.equal(srv.acks[0].error,'Papier leer');
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send});
 assert.equal(prints,1);
});

test('offline NEBU Control: nothing lost, cycle throws for backoff',async()=>{
 const j=new Journal(path.join(dir,'j4.json'));const srv=fakeServer();srv.down=true;
 await assert.rejects(cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>({confirmed:true})}),/offline/);
 srv.down=false;let prints=0;
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send:async()=>{prints++;return {confirmed:true}}});
 assert.equal(prints,1);
});

test('config written by Windows PowerShell (UTF-8 with BOM) is accepted; parse errors never echo file content',()=>{
 const f=path.join(dir,'bom.json');
 const secret='geheim-'.repeat(8);
 fs.writeFileSync(f,'\uFEFF'+JSON.stringify({apiUrl:'https://nebu-iphone-push-test.netlify.app',token:secret,printer:{mode:'tcp',host:'192.168.178.33'}},null,4).replace(/\n/g,'\r\n'));
 const c=loadConfig(f);
 assert.equal(c.printer.host,'192.168.178.33');assert.equal(c.printer.port,9100);
 fs.writeFileSync(f,'\uFEFF{"token":"'+secret+'", kaputt');
 assert.throws(()=>loadConfig(f),e=>/kein gültiges JSON/.test(e.message)&&!e.message.includes(secret));
});

test('unconfirmed print is reported as unconfirmed (not printed) and never re-sent',async()=>{
 const j=new Journal(path.join(dir,'j5.json'));const srv=fakeServer();let prints=0;
 const {PrintErrorForTest}=await import('../print-agent/nebu-print-agent.mjs');
 const send=async()=>{prints++;throw new PrintErrorForTest('Druck nicht vom Drucker bestätigt (Papier leer)',{sent:true})};
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send});
 assert.equal(prints,1);
 assert.equal(srv.acks.at(-1).result,'unconfirmed');
 assert.ok(!srv.acks.some(a=>a.result==='printed'));
 srv.acks.length=0; // Server bietet (fälschlich) erneut an
 await cycle({},j,{apiCall:srv.call,status:okPrinter,send});
 assert.equal(prints,1,'kein zweiter Druck');
});

test('after printer recovery the agent asks for waiting jobs immediately (retryNow)',async()=>{
 const j=new Journal(path.join(dir,'j6.json'));const calls=[];const state={};
 const api=async(c,b)=>{calls.push(b);return {jobs:[]}};
 let ok=false;const st=async()=>({ok,detail:ok?'bereit':'Deckel offen'});
 await cycle({},j,{apiCall:api,status:st,send:async()=>({confirmed:true}),state});
 assert.equal(calls.at(-1).printer.ok,false);
 ok=true;
 await cycle({},j,{apiCall:api,status:st,send:async()=>({confirmed:true}),state});
 assert.equal(calls.at(-1).retryNow,true,'sofort nach dem Schließen');
 await cycle({},j,{apiCall:api,status:st,send:async()=>({confirmed:true}),state});
 assert.equal(calls.at(-1).retryNow,false);
});
