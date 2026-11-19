# NEBU Bestellsystem – Weg in den Echtbetrieb

Stand: 2026-11-19. Ziel: Kunden bestellen auf shop.nebusushi.com, das Team nimmt in NEBU Control (iPhone/iPad/PC) an, der Epson TM-T20III druckt automatisch.

## Erledigt (TEST-Branch, getestet)
- Sicherheits- und Datenschutzpunkte: siehe `docs/security-blockers.md` (alle Code-Befunde behoben).
- Persönliche Zugänge, Team-Verwaltung, Geräte sperren, Änderungsprotokoll, Ersteinrichtung.
- Datenbankmodell für Echtbetrieb (eine Zeile pro Bestellung), Übernahme der Testdaten.
- Bestellweg-Schalter „Online / WhatsApp“ in NEBU Control: live standardmäßig **WhatsApp** → sofortiger Rückweg ohne Deployment.
- Küchendruck, Doppeldruck-Schutz, Nachdruck bei Druckerausfall, Autostart (Druckdienst 1.2.0) – unverändert übernommen, auf neues Datenmodell portiert.
- Push-Benachrichtigungen (Team + Kunde), Erinnerung nach 5 Min., automatische Anmeldung pro Schicht.

## Entscheidungen des Inhabers (19.11.2026)
- **Abholzeit:** Das Personal legt sie bei der Annahme fest (30/45/60/75 Min.). Keine Vorbestellung über den Online-Weg.
- **Lieferung:** Abholung **und** Lieferung ab Start (bis 3 km Fahrstrecke, nicht Altstadt; 2,00 €/Mindestwert 30 € bis 1,5 km, 3,50 €/40 € bis 3 km).
- **Verwaltung:** Öffnungsstatus, Zubereitungszeit und Ausverkauft bleiben im bisherigen Shop-Admin; NEBU übernimmt sie automatisch. Öffnungszeiten live: 16:00–20:50 Uhr (Status „Automatisch“).
- **Umstellung:** Bestehendes Live-Projekt wird erweitert, Online-Bestellung startet **aus**.

## Ebenfalls fertig (seit den Entscheidungen)
- Shop-Erweiterung `shop-addon/nebu-online.js`: ersetzt im Warenkorb den WhatsApp-Teil durch das Online-Formular (Abholung/Lieferung, „Zahlungspflichtig bestellen“), nur wenn der Schalter auf Online steht; bei Serverausfall bleibt WhatsApp.
- Bestellstatus-Seite `/bestellung.html` (aktualisiert sich automatisch, keine Kontaktdaten).
- Build-Skript `scripts/build.mjs` + `netlify.toml`: live Shop unter `/`, NEBU Control unter `/control/`, Testseiten nicht veröffentlicht, Sicherheits-Header.
- Werkzeug `tools/nebu-live-schluessel.html`: erzeugt die Live-Schlüssel im Browser.
- Druckdienst 1.3.0: `3-LIVE-UMSTELLEN.cmd`.
- Automatischer Abgleich: alle 76 Shop-Artikel und Preise stimmen mit dem Server-Katalog überein (Test schlägt fehl, falls im Shop ein Preis geändert wird, ohne den Katalog anzupassen).

## Pflichtpunkte vor der Freischaltung (deine Entscheidung / Zuarbeit)
1. **Impressum und Datenschutzerklärung** auf shop.nebusushi.com (fehlen derzeit komplett). Datenschutz muss Online-Bestellung, Hosting (Netlify), Push-Benachrichtigungen und bei Lieferung die Adressprüfung über OpenStreetMap/OSRM nennen. Texte von dir bzw. Rechtsberatung; ich baue sie ein.
2. **Löschfrist** festlegen (ggf. Steuerberater) und in NEBU Control einschalten.
3. **AVV mit Netlify** prüfen/abschließen.
4. **Adressprüfung für Lieferung:** nutzt die öffentlichen Dienste OpenStreetMap-Nominatim und OSRM-Demo-Server. Für geringe Mengen geeignet, aber ohne Verfügbarkeitszusage. Alternative später: eigener Kartendienst-Schlüssel.
5. Live-Werte in Netlify eintragen, Datenbank im Live-Projekt aktivieren (Anleitung unten).

## Live-Konfiguration (getrennt von Test)
Im Live-Netlify-Projekt (shop.nebusushi.com) eigene Werte – **nie** die Testwerte wiederverwenden:

| Variable | Zweck |
|---|---|
| `NEBU_ENV=live` | schaltet Live-Verhalten (keine Test-Schlüssel, Bestellnummern „N…“) |
| `NEBU_SESSION_SECRET` | signiert Mitarbeiter-Sitzungen (≥ 32 Zeichen, zufällig) |
| `NEBU_OWNER_SETUP_CODE` | einmalige Ersteinrichtung des Inhaber-Zugangs; danach löschen |
| `NEBU_PRINT_AGENT_TOKEN` | eigener Token für den Live-Druckdienst |
| `NEBU_VAPID_PUBLIC` / `NEBU_VAPID_PRIVATE` | eigenes Schlüsselpaar für Push |
| `NEBU_VAPID_CONTACT` | z. B. `mailto:info@nebusushi.com` |
Datenbank: Netlify Database im Live-Projekt aktivieren (eigene Datenbank, Migrationen laufen beim Deploy).

**Testprojekt:** zusätzlich `NEBU_OWNER_SETUP_CODE` setzen, damit nach dem nächsten Test-Deploy der Inhaber-Zugang angelegt werden kann (alter gemeinsamer Code gilt nicht mehr).

## Rückweg (Rollback)
**Rückgabepunkt Live:** Netlify-Deploy `6af9b256cad436e00f8141c8` (Stand `main` cd94f2b, geprüft am 19.11.2026 – noch das aktuelle Live-Deploy). Release-Kandidat: Branch `release/nebu-bestellsystem`.

1. Sofort: NEBU Control → 👥 → „Auf WhatsApp zurückschalten“ (Shop bestellt wieder per WhatsApp, kein Deploy nötig).
2. Vollständig: in Netlify das vorherige Live-Deploy wieder veröffentlichen („Publish deploy“) – Rollback-Punkt = aktuelles Live-Deploy vor der Umstellung.
3. Der Live-Druckdienst kann installiert bleiben; ohne Online-Bestellungen druckt er nichts.

