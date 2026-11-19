// Short-lived, signed test-staff sessions. Never expose signing secret to browsers.
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const sign=async(message,secret)=>{
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(message))));
};
const equal=(a,b)=>{if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0};
// Jeder Token gilt 30 Minuten und wird von einem aktiven Gerät automatisch verlängert –
// höchstens bis SHIFT_SECONDS nach der Code-Eingabe (dann neue Anmeldung nötig).
export const SHIFT_SECONDS=12*3600;
export async function issueStaffSession(secret,{authTime}={}){
 if(!secret||secret.length<32)throw Error('NEBU_TEST_SESSION_SECRET must contain at least 32 characters');
 const now=Math.floor(Date.now()/1000);
 const auth=Number.isInteger(authTime)&&authTime<=now&&now-authTime<SHIFT_SECONDS?authTime:now;
 const exp=Math.min(now+1800,auth+SHIFT_SECONDS);
 const payload=b64(enc.encode(JSON.stringify({v:1,scope:'nebu-test-staff',iat:now,exp,auth,nonce:crypto.randomUUID()})));
 return payload+'.'+await sign(payload,secret);
}
export async function verifyStaffSession(token,secret){
 if(!secret||secret.length<32||typeof token!=='string'||token.length>2048)return false;
 const parts=token.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]+$/.test(parts[1]))return false;
 try{
  if(!equal(parts[1],await sign(parts[0],secret)))return false;
  const data=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  const now=Math.floor(Date.now()/1000);
  const auth=Number.isInteger(data.auth)?data.auth:data.iat;
  const ok=data.v===1&&data.scope==='nebu-test-staff'&&Number.isInteger(data.iat)&&Number.isInteger(data.exp)&&data.iat<=now+30&&data.exp>now&&data.exp-data.iat<=1800&&auth<=data.iat&&now-auth<SHIFT_SECONDS;
  return ok?{iat:data.iat,exp:data.exp,auth}:false;
 }catch{return false}
}
// Geräte-Schlüssel zum Verlängern („Refresh-Token“): darf NUR neue 30-Min.-Sitzungen anfordern,
// gilt nie direkt für Bestelldaten und endet fest SHIFT_SECONDS nach der Code-Eingabe.
// Wird auf dem Gerät gespeichert, damit iOS-Web-Apps nach Hintergrund/Neustart angemeldet bleiben.
export async function issueRefreshToken(secret,authTime){
 if(!secret||secret.length<32)throw Error('NEBU_TEST_SESSION_SECRET must contain at least 32 characters');
 const now=Math.floor(Date.now()/1000);
 const auth=Number.isInteger(authTime)&&authTime<=now&&now-authTime<SHIFT_SECONDS?authTime:now;
 const payload=b64(enc.encode(JSON.stringify({v:1,scope:'nebu-test-refresh',auth,exp:auth+SHIFT_SECONDS,nonce:crypto.randomUUID()})));
 return payload+'.'+await sign(payload,secret);
}
export async function verifyRefreshToken(token,secret){
 if(!secret||secret.length<32||typeof token!=='string'||token.length>2048)return false;
 const parts=token.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]+$/.test(parts[1]))return false;
 try{
  if(!equal(parts[1],await sign(parts[0],secret)))return false;
  const data=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  const now=Math.floor(Date.now()/1000);
  const ok=data.v===1&&data.scope==='nebu-test-refresh'&&Number.isInteger(data.auth)&&data.exp===data.auth+SHIFT_SECONDS&&data.auth<=now+30&&data.exp>now;
  return ok?{auth:data.auth,exp:data.exp}:false;
 }catch{return false}
}
