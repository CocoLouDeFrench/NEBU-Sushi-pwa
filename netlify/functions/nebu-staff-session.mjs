// Short-lived, signed test-staff sessions. Never expose signing secret to browsers.
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const sign=async(message,secret)=>{
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(message))));
};
const equal=(a,b)=>{if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0};
export async function issueStaffSession(secret){
 if(!secret||secret.length<32)throw Error('NEBU_TEST_SESSION_SECRET must contain at least 32 characters');
 const now=Math.floor(Date.now()/1000);
 const payload=b64(enc.encode(JSON.stringify({v:1,scope:'nebu-test-staff',iat:now,exp:now+1800,nonce:crypto.randomUUID()})));
 return payload+'.'+await sign(payload,secret);
}
export async function verifyStaffSession(token,secret){
 if(!secret||secret.length<32||typeof token!=='string'||token.length>2048)return false;
 const parts=token.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]+$/.test(parts[1]))return false;
 try{
  if(!equal(parts[1],await sign(parts[0],secret)))return false;
  const data=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  const now=Math.floor(Date.now()/1000);
  return data.v===1&&data.scope==='nebu-test-staff'&&Number.isInteger(data.iat)&&Number.isInteger(data.exp)&&data.iat<=now+30&&data.exp>now&&data.exp-data.iat<=1800;
 }catch{return false}
}
