// Inhaber-Verwaltung: Erst-Einrichtung, Team (Name/PIN/Rolle/aktiv), Geräte-Sitzungen sperren,
// Änderungsprotokoll, Einstellungen (Bestellweg online/WhatsApp, Löschfristen).
import {json,readJson,clientIp,sha256,tx,pool,rateLimited,audit,logError,config,getSetting,setSetting} from '../lib/core.mjs';
import {requireStaff,hashPin,validatePin,validateName,nameKey} from '../lib/auth.mjs';

const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0};
const UUID=/^[0-9a-f-]{36}$/i;
const ACTIONS=['bootstrap','list','create','update','revoke','audit','settings','retention-preview'];

export default async req=>{
 if(req.method!=='POST')return json({error:'Methode nicht erlaubt'},405);
 const {body,error}=await readJson(req,8192);if(error)return error;
 if(!ACTIONS.includes(body.action))return json({error:'Ungültige Aktion'},400);
 try{
  if(body.action==='bootstrap')return await bootstrap(req,body);
  const auth=await requireStaff(req,{role:'owner'});if(auth.error)return auth.error;
  const me=auth.staff;
  switch(body.action){
   case 'list':{
    const staff=(await pool().query("SELECT id,name,role,active,(locked_until>now()) AS locked,created_at FROM nebu_staff ORDER BY active DESC, role, name")).rows;
    const sessions=(await pool().query("SELECT s.id,s.staff_id,st.name,s.device,s.created_at,s.last_seen_at,s.expires_at FROM nebu_staff_sessions s JOIN nebu_staff st ON st.id=s.staff_id WHERE s.revoked_at IS NULL AND s.expires_at>now() ORDER BY s.last_seen_at DESC NULLS LAST")).rows;
    return json({staff,sessions,currentSession:auth.session.id});
   }
   case 'create':{
    const nameError=validateName(body.name);if(nameError)return json({error:nameError},422);
    const pinError=validatePin(body.pin);if(pinError)return json({error:pinError},422);
    if(!['owner','staff'].includes(body.role))return json({error:'Ungültige Rolle'},422);
    const pin=await hashPin(body.pin);
    const created=await tx(async db=>{
     const r=await db.query('INSERT INTO nebu_staff (name,name_key,role,pin_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (name_key) DO NOTHING RETURNING id,name,role',[body.name.trim(),nameKey(body.name),body.role,pin]);
     if(r.rows[0])await audit(db,{staff:me,action:'staff_create',detail:{name:r.rows[0].name,role:body.role}});
     return r.rows[0];
    });
    return created?json({staff:created},201):json({error:'Dieser Name ist bereits vergeben.'},409);
   }
   case 'update':{
    if(!UUID.test(String(body.id||'')))return json({error:'Ungültiger Mitarbeiter'},422);
    let pinHash=null;if(body.pin!==undefined){const e=validatePin(body.pin);if(e)return json({error:e},422);pinHash=await hashPin(body.pin)}
    if(body.role!==undefined&&!['owner','staff'].includes(body.role))return json({error:'Ungültige Rolle'},422);
    if(body.active!==undefined&&typeof body.active!=='boolean')return json({error:'Ungültiger Status'},422);
    return await tx(async db=>{
     const cur=(await db.query('SELECT id,name,role,active FROM nebu_staff WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
     if(!cur)return json({error:'Mitarbeiter nicht gefunden'},404);
     const role=body.role??cur.role,active=body.active??cur.active;
     if(cur.role==='owner'&&cur.active&&(role!=='owner'||!active)){
      const owners=(await db.query("SELECT count(*)::int AS n FROM nebu_staff WHERE role='owner' AND active AND id<>$1",[cur.id])).rows[0].n;
      if(!owners)return json({error:'Es muss mindestens ein aktiver Inhaber-Zugang bestehen bleiben.'},409);
     }
     await db.query('UPDATE nebu_staff SET role=$2, active=$3, pin_hash=COALESCE($4,pin_hash), failed_attempts=CASE WHEN $4::text IS NULL THEN failed_attempts ELSE 0 END, locked_until=CASE WHEN $4::text IS NULL THEN locked_until ELSE NULL END, updated_at=now() WHERE id=$1',[cur.id,role,active,pinHash]);
     // Neue PIN, Deaktivierung oder Rollenwechsel: alle Geräte dieses Mitarbeiters abmelden.
     if(pinHash||!active||role!==cur.role)await db.query("UPDATE nebu_staff_sessions SET revoked_at=now(), revoked_reason='Zugang geändert' WHERE staff_id=$1 AND revoked_at IS NULL",[cur.id]);
     await audit(db,{staff:me,action:'staff_update',detail:{name:cur.name,role,active,pinChanged:!!pinHash}});
     return json({ok:true});
    });
   }
   case 'revoke':{
    return await tx(async db=>{
     let r;
     if(body.all===true)r=await db.query("UPDATE nebu_staff_sessions SET revoked_at=now(), revoked_reason='Alle Geräte abgemeldet' WHERE revoked_at IS NULL AND id<>$1",[auth.session.id]);
     else if(UUID.test(String(body.sessionId||'')))r=await db.query("UPDATE nebu_staff_sessions SET revoked_at=now(), revoked_reason='Gerät gesperrt' WHERE id=$1 AND revoked_at IS NULL",[body.sessionId]);
     else if(UUID.test(String(body.staffId||'')))r=await db.query("UPDATE nebu_staff_sessions SET revoked_at=now(), revoked_reason='Mitarbeiter abgemeldet' WHERE staff_id=$1 AND revoked_at IS NULL",[body.staffId]);
     else return json({error:'Ungültige Angabe'},422);
     await audit(db,{staff:me,action:'session_revoke',detail:{all:body.all===true,sessionId:body.sessionId||null,staffId:body.staffId||null,count:r.rowCount}});
     return json({revoked:r.rowCount});
    });
   }
   case 'audit':{
    const limit=Math.min(500,Math.max(1,Number(body.limit)||100));
    const rows=(await pool().query('SELECT at,staff_name,action,order_id,detail FROM nebu_audit ORDER BY at DESC LIMIT $1',[limit])).rows;
    return json({entries:rows});
   }
   case 'settings':{
    if(body.set){
     const s=body.set;
     if(s.orderingMode!==undefined&&!['online','whatsapp'].includes(s.orderingMode))return json({error:'Ungültiger Bestellweg'},422);
     if(s.retention!==undefined&&(typeof s.retention!=='object'||typeof s.retention.enabled!=='boolean'||!Number.isInteger(s.retention.personalDataDays)||s.retention.personalDataDays<7||s.retention.personalDataDays>365))return json({error:'Löschfrist: 7 bis 365 Tage'},422);
     await tx(async db=>{
      for(const key of ['orderingMode','retention'])if(s[key]!==undefined){await setSetting(db,key,s[key],me.name);await audit(db,{staff:me,action:'setting_'+key,detail:{value:s[key]}})}
     });
    }
    return json({orderingMode:await getSetting('orderingMode'),retention:await getSetting('retention'),environment:config.environment});
   }
   case 'retention-preview':{
    const ret=await getSetting('retention');
    const r=await pool().query("SELECT count(*)::int AS n FROM nebu_orders WHERE closed_at IS NOT NULL AND anonymized_at IS NULL AND closed_at < now() - ($1||' days')::interval",[String(ret.personalDataDays)]);
    return json({due:r.rows[0].n,retention:ret});
   }
  }
 }catch(e){logError('staff-admin '+body.action,e);return json({error:'Serverfehler'},500)}
};

// Erst-Einrichtung: nur solange es keinen Inhaber gibt, nur mit dem einmaligen Einrichtungscode
// (Umgebungsvariable NEBU_OWNER_SETUP_CODE, mind. 16 Zeichen).
async function bootstrap(req,body){
 const code=config.ownerSetupCode;
 if(!code||code.length<16)return json({error:'Erst-Einrichtung nicht freigeschaltet'},403);
 const ip=clientIp(req);if(!ip)return json({error:'Nicht verfügbar'},503);
 if(await rateLimited('bootstrap:'+await sha256(ip),{limit:5,windowSeconds:3600}))return json({error:'Zu viele Versuche'},429);
 if(!equal(String(body.setupCode||''),code))return json({error:'Einrichtungscode falsch'},403);
 const nameError=validateName(body.name);if(nameError)return json({error:nameError},422);
 const pinError=validatePin(body.pin);if(pinError)return json({error:pinError},422);
 const pin=await hashPin(body.pin);
 return await tx(async db=>{
  await db.query('LOCK TABLE nebu_staff IN EXCLUSIVE MODE');
  const owners=(await db.query("SELECT count(*)::int AS n FROM nebu_staff WHERE role='owner'")).rows[0].n;
  if(owners)return json({error:'Bereits eingerichtet. Weitere Zugänge legt der Inhaber in NEBU Control an.'},409);
  const r=await db.query("INSERT INTO nebu_staff (name,name_key,role,pin_hash) VALUES ($1,$2,'owner',$3) RETURNING id,name,role",[body.name.trim(),nameKey(body.name),pin]);
  await audit(db,{staff:r.rows[0],action:'owner_bootstrap'});
  return json({staff:r.rows[0]},201);
 });
}
