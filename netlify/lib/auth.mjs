// Persönliche Mitarbeiterzugänge: Name + PIN, serverseitige Sitzungen (sperrbar), signierte Kurzzeit-Tokens.
import {config,pool,json,sha256} from './core.mjs';

export const SHIFT_SECONDS=12*3600;      // Sitzung (Schicht) endet spätestens 12 Std. nach Anmeldung
export const ACCESS_SECONDS=30*60;       // Zugangstoken, wird automatisch erneuert
const PBKDF2_ITERATIONS=210000;
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0};
const nowSec=()=>Math.floor(Date.now()/1000);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- PIN ----------
export const nameKey=name=>String(name||'').trim().toLocaleLowerCase('de-DE').normalize('NFKC').replace(/\s+/g,' ');
export function validatePin(pin){
 if(typeof pin!=='string'||!/^\d{6,12}$/.test(pin))return 'Die PIN muss aus 6 bis 12 Ziffern bestehen.';
 if(/^(\d)\1+$/.test(pin)||'01234567890123'.includes(pin)||'98765432109876'.includes(pin))return 'Diese PIN ist zu einfach. Bitte keine Wiederholungen oder Zahlenfolgen.';
 return '';
}
export function validateName(name){const n=String(name||'').trim();if(n.length<2||n.length>40||!/^[\p{L}\p{N} .'-]+$/u.test(n))return 'Name: 2–40 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich.';return ''}
async function pbkdf2(pin,salt,iterations){
 const key=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}
export async function hashPin(pin){
 const salt=crypto.getRandomValues(new Uint8Array(16));
 return 'pbkdf2-sha256$'+PBKDF2_ITERATIONS+'$'+b64(salt)+'$'+b64(await pbkdf2(pin,salt,PBKDF2_ITERATIONS));
}
export async function checkPin(pin,stored){
 const [alg,iter,salt,hash]=String(stored||'').split('$');
 if(alg!=='pbkdf2-sha256'||!Number(iter)||!salt||!hash)return false;
 return equal(b64(await pbkdf2(String(pin),unb64(salt),Number(iter))),hash);
}
// Für Laufzeitgleichheit bei unbekanntem Namen (kein Rückschluss, ob ein Name existiert).
let dummyHash=null;export const dummyCheck=async pin=>{dummyHash=dummyHash||await hashPin('839201');await checkPin(pin,dummyHash);return false};

// ---------- Tokens ----------
async function sign(message){
 const secret=config.sessionSecret;
 if(!secret||secret.length<32)throw Error('NEBU_SESSION_SECRET fehlt oder ist zu kurz');
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(message))));
}
async function makeToken(payload){const p=b64(enc.encode(JSON.stringify(payload)));return p+'.'+await sign(p)}
export async function readToken(token,typ){
 if(typeof token!=='string'||token.length>2048)return null;
 const parts=token.split('.');if(parts.length!==2||!/^[\w-]+$/.test(parts[0])||!/^[\w-]+$/.test(parts[1]))return null;
 try{
  if(!equal(parts[1],await sign(parts[0])))return null;
  const d=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  if(d.v!==2||d.typ!==typ||!UUID.test(d.sid||'')||!Number.isInteger(d.exp)||d.exp<=nowSec())return null;
  return d;
 }catch{return null}
}
export async function issueTokens(session,staff){
 const exp=Math.floor(new Date(session.expires_at).getTime()/1000);
 const now=nowSec();
 const access=await makeToken({v:2,typ:'access',sid:session.id,uid:staff.id,iat:now,exp:Math.min(now+ACCESS_SECONDS,exp)});
 const refresh=await makeToken({v:2,typ:'refresh',sid:session.id,uid:staff.id,iat:now,exp});
 return {token:access,expiresInSeconds:Math.min(ACCESS_SECONDS,exp-now),refreshToken:refresh,sessionEndsAt:new Date(exp*1000).toISOString(),staff:{name:staff.name,role:staff.role}};
}

// ---------- Sitzung prüfen ----------
const SESSION_SQL='SELECT s.id, s.expires_at, s.revoked_at, s.last_seen_at, st.id AS staff_id, st.name, st.role, st.active FROM nebu_staff_sessions s JOIN nebu_staff st ON st.id=s.staff_id WHERE s.id=$1';
export async function loadSession(sid,db=pool()){
 const r=await db.query(SESSION_SQL,[sid]);const s=r.rows[0];
 if(!s||s.revoked_at||!s.active||new Date(s.expires_at)<=new Date())return null;
 return s;
}
// Liefert {staff,session} oder eine fertige Fehlerantwort (403). Jede Anfrage prüft die Sitzung in der
// Datenbank: Sperren eines Geräts/Mitarbeiters wirkt sofort.
export async function requireStaff(req,{role}={}){
 const h=req.headers.get('authorization')||'';
 const d=h.startsWith('Bearer ')?await readToken(h.slice(7),'access'):null;
 const s=d?await loadSession(d.sid):null;
 if(!s||s.staff_id!==d.uid)return {error:json({error:'Nur für NEBU-Mitarbeiter'},403)};
 if(role==='owner'&&s.role!=='owner')return {error:json({error:'Nur für den Inhaber'},403)};
 if(!s.last_seen_at||Date.now()-new Date(s.last_seen_at).getTime()>5*60000)pool().query('UPDATE nebu_staff_sessions SET last_seen_at=now() WHERE id=$1',[s.id]).catch(()=>{});
 return {staff:{id:s.staff_id,name:s.name,role:s.role},session:{id:s.id}};
}
export const sessionKeyHash=sid=>sha256('sid:'+sid);
