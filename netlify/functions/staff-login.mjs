import {issueStaffSession} from './nebu-staff-session.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','pragma':'no-cache'}});
export default async req=>{
 if(req.method!=='POST')return reply({error:'Methode nicht erlaubt'},405);
 const secret=Netlify.env.get('NEBU_TEST_SESSION_SECRET');
 const adminKey=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
 if(!secret||secret.length<32||!adminKey)return reply({error:'Sitzungsanmeldung noch nicht konfiguriert'},503);
 let body;try{const raw=await req.text();if(raw.length>2048)return reply({error:'Anfrage zu groß'},413);body=JSON.parse(raw)}catch{return reply({error:'Ungültige Anfrage'},400)}
 if(!body||typeof body.key!=='string'||body.key.length>256||body.key!==adminKey)return reply({error:'Zugang verweigert'},403);
 const token=await issueStaffSession(secret);
 return reply({token,expiresInSeconds:1800});
};
