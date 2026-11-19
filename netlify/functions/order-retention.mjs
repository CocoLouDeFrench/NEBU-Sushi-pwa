// Tägliche Datenpflege.
// Immer (rein technisch, keine Bestelldaten): abgelaufene Kunden-Tokens, Push-Abos abgeschlossener Bestellungen,
// alte Drosselungszähler und abgelaufene Sitzungen entfernen.
// Nur wenn der Inhaber es in NEBU Control einschaltet: personenbezogene Daten abgeschlossener Bestellungen
// nach der eingestellten Frist anonymisieren (Name, Telefon, E-Mail, Adresse, Klingel, Etage, Sonderwünsche).
// Artikel, Beträge, Zeiten, Status und Zahlungsprotokoll bleiben für Buchhaltung/Nachweise erhalten.
import {tx,logError,getSetting,audit} from '../lib/core.mjs';
export const config={schedule:'17 3 * * *'};
export const PERSONAL_FIELDS=['customer','email','phone','address','bell','floor','notes','riskFlag'];
export async function runRetention(db){
 const out={};
 out.tokens=(await db.query("UPDATE nebu_orders SET token_hash=NULL WHERE token_hash IS NOT NULL AND token_expires_at < now()")).rowCount;
 out.pushSubscriptions=(await db.query("DELETE FROM nebu_push_subscriptions p USING nebu_orders o WHERE p.kind='customer' AND p.order_id=o.id AND (o.closed_at < now() - interval '1 day' OR o.created_at < now() - interval '3 days')")).rowCount;
 out.rateLimits=(await db.query("DELETE FROM nebu_rate_limits WHERE window_start < now() - interval '2 days'")).rowCount;
 out.sessions=(await db.query("DELETE FROM nebu_staff_sessions WHERE expires_at < now() - interval '30 days'")).rowCount;
 const ret=await getSetting('retention',db);
 if(ret?.enabled===true&&Number.isInteger(ret.personalDataDays)&&ret.personalDataDays>=7){
  const r=await db.query(`UPDATE nebu_orders SET data=(data - $2::text[]) || jsonb_build_object('customer','(anonymisiert)'), phone_key=NULL, address_key=NULL, token_hash=NULL, anonymized_at=now()
   WHERE closed_at IS NOT NULL AND anonymized_at IS NULL AND closed_at < now() - ($1||' days')::interval`,[String(ret.personalDataDays),PERSONAL_FIELDS]);
  out.anonymized=r.rowCount;
 }else out.anonymized=null;
 await audit(db,{staff:{name:'System'},action:'retention_run',detail:out});
 return out;
}
export default async()=>{try{await tx(runRetention)}catch(e){logError('order-retention',e)}};
