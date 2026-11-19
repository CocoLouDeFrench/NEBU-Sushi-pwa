#!/usr/bin/env node
// NEBU Druckdienst · holt angenommene Bestellungen aus NEBU Control und druckt Küchenbons.
// Keine npm-Abhängigkeiten. Läuft unter Windows als geplante Aufgabe (SYSTEM, Autostart).
//
//   node nebu-print-agent.mjs            Dienst starten
//   node nebu-print-agent.mjs --check    Konfiguration + Druckerstatus prüfen
//   node nebu-print-agent.mjs --test     Testseite drucken
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {renderTicket,renderTestPage,STATUS_QUERIES,interpretStatus} from './escpos.mjs';

export const VERSION='1.0.0';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR=process.env.NEBU_PRINT_DATA||(process.platform==='win32'?path.join(process.env.ProgramData||'C:\\ProgramData','NEBU-Druckdienst'):path.join(os.homedir(),'.nebu-druckdienst'));
const CONFIG_PATH=process.env.NEBU_PRINT_CONFIG||path.join(DATA_DIR,'config.json');
const JOURNAL_PATH=path.join(DATA_DIR,'journal.json');
const LOG_DIR=path.join(DATA_DIR,'logs');
const STATUS_PORT=47123;

// ---------- Protokoll ----------
let logStream=null,logDay='';
export function log(level,msg){
 const now=new Date();const day=now.toISOString().slice(0,10);
 const line=now.toISOString()+' ['+level+'] '+msg;
 console.log(line);
 try{
  if(day!==logDay){logStream?.end();fs.mkdirSync(LOG_DIR,{recursive:true});logStream=fs.createWriteStream(path.join(LOG_DIR,'druckdienst-'+day+'.log'),{flags:'a'});logDay=day;pruneLogs()}
  logStream.write(line+os.EOL);
 }catch{}
}
function pruneLogs(){try{for(const f of fs.readdirSync(LOG_DIR)){const p=path.join(LOG_DIR,f);if(Date.now()-fs.statSync(p).mtimeMs>14*86400000)fs.unlinkSync(p)}}catch{}}

// ---------- Konfiguration (Zugangsdaten nur hier, nie im Code) ----------
export function loadConfig(file=CONFIG_PATH){
 const c=JSON.parse(fs.readFileSync(file,'utf8'));
 const errors=[];
 if(!/^https:\/\/[^/]+/.test(c.apiUrl||''))errors.push('apiUrl muss eine https-Adresse sein');
 if(/shop\.nebusushi\.com/i.test(c.apiUrl||'')&&c.allowProduction!==true)errors.push('apiUrl zeigt auf den Live-Shop – im Testbetrieb nicht erlaubt');
 if(typeof c.token!=='string'||c.token.length<32)errors.push('token fehlt oder ist zu kurz');
 const p=c.printer||{};
 if(!['tcp','windows'].includes(p.mode))errors.push('printer.mode muss "tcp" oder "windows" sein');
 if(p.mode==='tcp'&&!p.host)errors.push('printer.host (IP-Adresse des Druckers) fehlt');
 if(p.mode==='windows'&&!p.name)errors.push('printer.name (Windows-Druckername) fehlt');
 if(errors.length)throw Error('Konfiguration ungültig: '+errors.join('; '));
 return {pollSeconds:5,agentId:os.hostname(),...c,printer:{port:9100,timeoutMs:8000,...p}};
}

// ---------- Lokales Journal gegen Doppeldruck ----------
// Eintrag wird VOR dem Senden an den Drucker dauerhaft gespeichert.
// state: sending → printed; acked=true sobald NEBU Control den Druck bestätigt hat.
export class Journal{
 constructor(file=JOURNAL_PATH){this.file=file;this.entries={};try{this.entries=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}}
 get(id){return this.entries[id]}
 set(id,patch){this.entries[id]={...this.entries[id],...patch,updatedAt:new Date().toISOString()};this.save()}
 remove(id){delete this.entries[id];this.save()}
 pendingAcks(){return Object.entries(this.entries).filter(([,e])=>!e.acked&&['printed','sending'].includes(e.state)).map(([jobId,e])=>({jobId,...e}))}
 save(){
  const cutoff=Date.now()-7*86400000;
  for(const [k,e] of Object.entries(this.entries))if(e.acked&&Date.parse(e.updatedAt)<cutoff)delete this.entries[k];
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const tmp=this.file+'.tmp';const fd=fs.openSync(tmp,'w');fs.writeSync(fd,JSON.stringify(this.entries,null,1));fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,this.file);
 }
}

// ---------- Drucker ----------
class PrintError extends Error{constructor(msg,{sent=false}={}){super(msg);this.sent=sent}}

// TCP/9100 direkt zum Epson (LAN). Status vor UND nach dem Druck wird abgefragt.
export function tcpSession(printer){
 return new Promise((resolve,reject)=>{
  const sock=net.createConnection({host:printer.host,port:printer.port});
  let buf=Buffer.alloc(0),waiter=null;
  const fail=e=>{sock.destroy();reject(new PrintError('Drucker nicht erreichbar ('+printer.host+'): '+e.message))};
  sock.setTimeout(printer.timeoutMs,()=>fail(Error('Zeitüberschreitung')));
  sock.once('error',fail);
  sock.on('data',d=>{buf=Buffer.concat([buf,d]);waiter?.()});
  sock.once('connect',()=>{
   sock.removeListener('error',fail);
   let broken=null;sock.on('error',e=>{broken=e;waiter?.()});
   const readByte=ms=>new Promise(res=>{const t=setTimeout(()=>{waiter=null;res(undefined)},ms);waiter=()=>{if(buf.length||broken){clearTimeout(t);waiter=null;const b=buf[0];buf=buf.subarray(1);res(b)}};waiter()});
   resolve({
    async status(){const out=[];for(const q of STATUS_QUERIES){if(broken)break;sock.write(Buffer.from(q));out.push(await readByte(1500))}return interpretStatus(out)},
    write(bytes){return new Promise((res,rej)=>{if(broken)return rej(broken);sock.write(bytes,e=>e?rej(e):res())})},
    close(){return new Promise(res=>{sock.end(()=>res());setTimeout(()=>{sock.destroy();res()},2000)})},
    get broken(){return broken}
   });
  });
 });
}
export async function printerStatus(printer){
 if(printer.mode==='windows')return windowsPrinterStatus(printer);
 let s;try{s=await tcpSession(printer);return await s.status()}catch(e){return {ok:false,detail:e.message}}finally{await s?.close()}
}
async function printTcp(printer,bytes){
 const s=await tcpSession(printer);
 let sent=false;
 try{
  const before=await s.status();
  if(!before.ok)throw new PrintError('Drucker nicht bereit: '+before.detail);
  sent=true;await s.write(bytes);
  const after=await s.status();
  if(s.broken)throw new PrintError('Verbindung während des Drucks abgebrochen',{sent:true});
  // Papier leer nach dem Druck: Bon kann unvollständig sein → als „unsicher“ melden.
  return {uncertain:!after.ok,detail:after.detail};
 }catch(e){if(e instanceof PrintError)throw e;throw new PrintError(e.message,{sent})}
 finally{await s.close()}
}

// Ersatzweg über den Windows-Spooler (RAW, ohne Treiber-Rendering), falls keine feste IP.
const PS_RAW=`param([string]$Printer,[string]$File)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class NebuRaw{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public class DOCINFO{public string pDocName;public string pOutputFile;public string pDataType;}
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] static extern int StartDocPrinter(IntPtr h,int l,[In] DOCINFO di);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool WritePrinter(IntPtr h,byte[] b,int c,out int w);
 public static void Send(string printer,byte[] data){IntPtr h;if(!OpenPrinter(printer,out h,IntPtr.Zero))throw new Exception("Drucker nicht gefunden: "+printer);
  try{var di=new DOCINFO{pDocName="NEBU Kuechenbon",pDataType="RAW"};if(StartDocPrinter(h,1,di)==0)throw new Exception("StartDoc fehlgeschlagen");
   try{StartPagePrinter(h);int w;if(!WritePrinter(h,data,data.Length,out w)||w!=data.Length)throw new Exception("WritePrinter fehlgeschlagen");EndPagePrinter(h);}finally{EndDocPrinter(h);}}
  finally{ClosePrinter(h);}}}
'@
[NebuRaw]::Send($Printer,[IO.File]::ReadAllBytes($File))`;
function powershell(args){return new Promise((res,rej)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{timeout:30000,windowsHide:true},(e,out,err)=>e?rej(Error((err||e.message).trim().slice(0,200))):res(out.trim())))}
async function windowsPrinterStatus(printer){
 try{const out=await powershell(['-Command','$p=Get-Printer -Name $args[0] -ErrorAction Stop; "$($p.PrinterStatus)"',printer.name]);
  return /^(Normal|Idle|0)$/i.test(out)?{ok:true,detail:'bereit (Windows-Spooler)'}:{ok:false,detail:'Windows meldet: '+out}}catch(e){return {ok:false,detail:e.message}}
}
async function printWindows(printer,bytes){
 const tmp=path.join(DATA_DIR,'spool-'+process.pid+'-'+Date.now()+'.bin');const script=path.join(DATA_DIR,'raw-print.ps1');
 fs.writeFileSync(script,PS_RAW);fs.writeFileSync(tmp,bytes);
 try{await powershell(['-File',script,'-Printer',printer.name,'-File',tmp]);return {uncertain:false,detail:'an Windows-Spooler übergeben'}}
 catch(e){throw new PrintError('Windows-Druck fehlgeschlagen: '+e.message)}
 finally{try{fs.unlinkSync(tmp)}catch{}}
}
export async function sendToPrinter(printer,bytes){return printer.mode==='windows'?printWindows(printer,bytes):printTcp(printer,bytes)}

// ---------- NEBU Control ----------
export async function api(cfg,body){
 const ctl=AbortSignal.timeout(15000);
 const r=await fetch(cfg.apiUrl.replace(/\/$/,'')+'/.netlify/functions/kitchen-print',{method:'POST',signal:ctl,headers:{'content-type':'application/json',authorization:'Bearer '+cfg.token},body:JSON.stringify({agentId:cfg.agentId,version:VERSION,...body})});
 let data={};try{data=await r.json()}catch{}
 if(!r.ok)throw Error('NEBU Control antwortet '+r.status+(data.error?': '+data.error:''));
 return data;
}

// ---------- Ein Durchlauf ----------
export async function cycle(cfg,journal,deps={}){
 const {apiCall=api,status=printerStatus,send=sendToPrinter}=deps;
 // 1) Offene Bestätigungen nachholen (z. B. nach Internetausfall).
 for(const e of journal.pendingAcks()){
  try{const r=await apiCall(cfg,{action:'ack',jobId:e.jobId,orderId:e.orderId,result:'printed',uncertain:e.state==='sending'||e.uncertain===true});
   journal.set(e.jobId,{acked:true});log('INFO','Druck von #'+e.orderId+' an NEBU Control bestätigt'+(r.alreadyPrinted?' (war bereits bestätigt)':''))}
  catch(err){log('WARN','Bestätigung für #'+e.orderId+' noch offen: '+err.message);throw err}
 }
 // 2) Drucker prüfen, neue Aufträge abholen.
 const printer=await status(cfg.printer);
 const {jobs=[]}=await apiCall(cfg,{action:'claim',printer});
 const result={printer,printed:0,failed:0,deduplicated:0};
 for(const job of jobs){
  const known=journal.get(job.jobId);
  if(known&&['printed','sending'].includes(known.state)){
   // Schon gedruckt (oder Druck lief beim Absturz) → NICHT erneut drucken, nur bestätigen.
   result.deduplicated++;log('INFO','#'+job.orderId+' bereits gedruckt – kein zweiter Bon');
   await apiCall(cfg,{action:'ack',jobId:job.jobId,orderId:job.orderId,result:'printed',uncertain:known.state==='sending'||known.uncertain===true});
   journal.set(job.jobId,{acked:true});continue;
  }
  if(!printer.ok){
   await apiCall(cfg,{action:'ack',jobId:job.jobId,orderId:job.orderId,result:'failed',error:printer.detail}).catch(()=>{});
   result.failed++;log('WARN','#'+job.orderId+' wartet: '+printer.detail);continue;
  }
  journal.set(job.jobId,{orderId:job.orderId,state:'sending',acked:false});
  try{
   const out=await send(cfg.printer,renderTicket(job.ticket));
   journal.set(job.jobId,{state:'printed',uncertain:out.uncertain,printedAt:new Date().toISOString()});
   result.printed++;log('INFO','Küchenbon #'+job.orderId+' gedruckt ('+out.detail+')');
  }catch(e){
   if(e.sent){journal.set(job.jobId,{state:'sending',uncertain:true});log('ERROR','#'+job.orderId+' Druck unterbrochen – wird NICHT automatisch wiederholt (Doppeldruck-Schutz): '+e.message)}
   else{journal.remove(job.jobId);await apiCall(cfg,{action:'ack',jobId:job.jobId,orderId:job.orderId,result:'failed',error:e.message}).catch(()=>{});result.failed++;log('WARN','#'+job.orderId+' nicht gedruckt, neuer Versuch folgt: '+e.message);continue}
  }
  try{await apiCall(cfg,{action:'ack',jobId:job.jobId,orderId:job.orderId,result:'printed',uncertain:journal.get(job.jobId).uncertain===true});journal.set(job.jobId,{acked:true})}
  catch(e){log('WARN','Bestätigung für #'+job.orderId+' wird nachgeholt: '+e.message)}
 }
 return result;
}

// ---------- Dienst ----------
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 const cfg=loadConfig();const journal=new Journal();
 const health={startedAt:new Date().toISOString(),version:VERSION,lastOkAt:null,lastError:null,printer:null};
 // Lokale Statusseite (nur 127.0.0.1) und Schutz gegen doppelt laufende Dienste.
 const server=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json; charset=utf-8'});r.end(JSON.stringify(health,null,1))});
 await new Promise((res,rej)=>{server.once('error',e=>rej(e.code==='EADDRINUSE'?Error('Druckdienst läuft bereits'):e));server.listen(STATUS_PORT,'127.0.0.1',res)});
 log('INFO','NEBU Druckdienst '+VERSION+' gestartet · '+cfg.apiUrl+' · Drucker '+(cfg.printer.mode==='tcp'?cfg.printer.host:cfg.printer.name));
 let backoff=0,lastPrinter='';
 for(;;){
  try{
   const r=await cycle(cfg,journal);
   health.lastOkAt=new Date().toISOString();health.lastError=null;health.printer=r.printer;
   if(r.printer.detail!==lastPrinter){log(r.printer.ok?'INFO':'WARN','Drucker: '+r.printer.detail);lastPrinter=r.printer.detail}
   if(backoff){log('INFO','Verbindung zu NEBU Control wieder da');backoff=0}
   await sleep(r.printed?1000:cfg.pollSeconds*1000);
  }catch(e){
   health.lastError=e.message;backoff=Math.min(60000,backoff?backoff*2:5000);
   log('WARN','Durchlauf fehlgeschlagen, neuer Versuch in '+backoff/1000+' s: '+e.message);await sleep(backoff);
  }
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const arg=process.argv[2];
 const main=async()=>{
  if(arg==='--check'){
   const cfg=loadConfig();console.log('Konfiguration ok:',CONFIG_PATH);
   console.log('Drucker:',JSON.stringify(await printerStatus(cfg.printer)));
   const r=await fetch(cfg.apiUrl.replace(/\/$/,'')+'/.netlify/functions/kitchen-print',{method:'POST',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:'{"action":"ping"}'});
   console.log('NEBU Control:',r.status===400?'erreichbar, Token gültig':r.status===403?'Token ungültig':r.status===503?'Server: Druckdienst-Token noch nicht hinterlegt':'Status '+r.status);
  }else if(arg==='--test'){
   const cfg=loadConfig();console.log(JSON.stringify(await sendToPrinter(cfg.printer,renderTestPage())));
  }else await run();
 };
 main().catch(e=>{log('ERROR',e.message);process.exit(1)});
}
