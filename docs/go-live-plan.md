# NEBU Bestellsystem – Weg in den Echtbetrieb

Stand: 2026-11-19. Ziel: Kunden bestellen auf shop.nebusushi.com, das Team nimmt in NEBU Control (iPhone/iPad/PC) an, der Epson TM-T20III druckt automatisch.

## Erledigt (TEST-Branch, getestet)
- Sicherheits- und Datenschutzpunkte: siehe `docs/security-blockers.md` (alle Code-Befunde behoben).
- Persönliche Zugänge, Team-Verwaltung, Geräte sperren, Änderungsprotokoll, Ersteinrichtung.
- Datenbankmodell für Echtbetrieb (eine Zeile pro Bestellung), Übernahme der Testdaten.
- Bestellweg-Schalter „Online / WhatsApp“ in NEBU Control: live standardmäßig **WhatsApp** → sofortiger Rückweg ohne Deployment.
- Küchendruck, Doppeldruck-Schutz, Nachdruck bei Druckerausfall, Autostart (Druckdienst 1.2.0) – unverändert übernommen, auf neues Datenmodell portiert.
- Push-Benachrichtigungen (Team + Kunde), Erinnerung nach 5 Min., automatische Anmeldung pro Schicht.

## Noch zu bauen (nach Entscheidungen unten)
1. Shop-Seite (Kopie des aktuellen Live-Shops): Bestellen über NEBU statt WhatsApp, **automatischer Rückfall auf WhatsApp**, wenn der Schalter auf WhatsApp steht oder der Server nicht erreichbar ist. Bestell-Button „Zahlungspflichtig bestellen“ (gesetzliche Pflicht bei Online-Bestellungen).
2. Bestellstatus-Seite für Kunden (aus `customer.html`).
3. Gewünschte Abholzeit / Vorbestellung in Bestellung, NEBU Control und Küchenbon; Öffnungszeiten serverseitig prüfen.
4. Build-Skript: Test- und Live-Seiten aus demselben Code, Testseiten nicht live veröffentlichen.
5. Werkzeug zum Erzeugen der Live-Schlüssel direkt im Browser (Schlüssel verlassen deinen PC nicht).
6. Release-Branch auf Basis von `main` (nur getestete Teile, aktuelle Shop-Inhalte/SEO bleiben).

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
1. Sofort: NEBU Control → 👥 → „Auf WhatsApp zurückschalten“ (Shop bestellt wieder per WhatsApp, kein Deploy nötig).
2. Vollständig: in Netlify das vorherige Live-Deploy wieder veröffentlichen („Publish deploy“) – Rollback-Punkt = aktuelles Live-Deploy vor der Umstellung.
3. Der Live-Druckdienst kann installiert bleiben; ohne Online-Bestellungen druckt er nichts.

## Entscheidungen des Inhabers
Siehe Chat / werden hier ergänzt.
