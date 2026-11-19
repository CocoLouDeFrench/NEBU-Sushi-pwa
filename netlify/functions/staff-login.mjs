// Anmeldung, Verlängerung und Abmeldung für persönliche Mitarbeiterzugänge.
import {json,readJson,clientIp,sha256,tx,pool,rateLimited,audit,logError,config} from '../lib/core.mjs';
import {nameKey,checkPin,dummyCheck,issueTokens,readToken,loadSession,SHIFT_SECONDS} from '../lib/auth.mjs';

const FAIL_LIMIT=5,LOCK_MINUTES=15;
const generic=()=>json({error:'Name oder PIN falsch.'},403);

export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 if(!config.sessionSecret||config.sessionSecret.length<32)return json({error:'Anmeldung noch nicht eingerichtet'},503);
 const {body,error}=await readJson(req,4096);if(error)return error;
 try{
  if(body.action==='renew'){
   const d=await readToken(body.refreshToken,'refresh');
   const s=d?await loadSession(d.sid):null;
   if(!s||s.staff_id!==d.uid)return json({error:'Sitzung abgelaufen'},403);
   return json(await issueTokens({id:s.id,expires_at:s.expires_at},{id:s.staff_id,name:s.name,role:s.role}));
  }
  if(body.action==='logout'){
   const d=await readToken(body.refreshToken,'refresh');
   if(d)await tx(async db=>{const r=await db.query("UPDATE nebu_staff_sessions SET revoked_at=now(), revoked_reason='Abmeldung' WHERE id=$1 AND revoked_at IS NULL RETURNING staff_id",[d.sid]);if(r.rows[0])await audit(db,{staff:{id:r.rows[0].staff_id},action:'logout'})});
   return json({ok:true});
  }
  if(body.action!=='login'&&body.key!==undefined)return json({error:'Bitte mit Name und PIN anmelden.'},400);
  if(body.action!=='login')return json({error:'Ungültige Aktion'},400);
  const ip=clientIp(req);
  if(!ip)return json({error:'Anmeldung derzeit nicht verfügbar'},503);
  if(typeof body.name!=='string'||typeof body.pin!=='string'||body.name.length>60||body.pin.length>20)return generic();
  if(await rateLimited('login-ip:'+await sha256(ip),{limit:20,windowSeconds:900}))return json({error:'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.'},429);
  const device=String(body.device||'').replace(/[^\p{L}\p{N} .,()/-]/gu,'').slice(0,60)||null;
  const r=await pool().query('SELECT id,name,role,pin_hash,active,failed_attempts,locked_until FROM nebu_staff WHERE name_key=$1',[nameKey(body.name)]);
  const st=r.rows[0];
  if(!st||!st.active){await dummyCheck(body.pin);return generic()}
  if(st.locked_until&&new Date(st.locked_until)>new Date())return json({error:'Zu viele falsche PINs. Zugang für '+LOCK_MINUTES+' Minuten gesperrt.'},429);
  if(!await checkPin(body.pin,st.pin_hash)){
   await tx(async db=>{
    const u=await db.query("UPDATE nebu_staff SET failed_attempts=failed_attempts+1, locked_until=CASE WHEN failed_attempts+1>=$2 THEN now()+($3||' minutes')::interval ELSE locked_until END WHERE id=$1 RETURNING failed_attempts",[st.id,FAIL_LIMIT,String(LOCK_MINUTES)]);
    await audit(db,{staff:{id:st.id,name:st.name},action:'login_failed',detail:{attempts:u.rows[0].failed_attempts}});
    if(u.rows[0].failed_attempts>=FAIL_LIMIT)await db.query('UPDATE nebu_staff SET failed_attempts=0 WHERE id=$1',[st.id]);
   });
   return generic();
  }
  const session=await tx(async db=>{
   await db.query('UPDATE nebu_staff SET failed_attempts=0, locked_until=NULL WHERE id=$1',[st.id]);
   const s=await db.query("INSERT INTO nebu_staff_sessions (staff_id, expires_at, device, last_seen_at) VALUES ($1, now()+($2||' seconds')::interval, $3, now()) RETURNING id, expires_at",[st.id,String(SHIFT_SECONDS),device]);
   await audit(db,{staff:st,action:'login',detail:{device}});
   return s.rows[0];
  });
  return json(await issueTokens(session,st));
 }catch(e){logError('staff-login',e);return json({error:'Anmeldung vorübergehend nicht verfügbar'},503)}
};
