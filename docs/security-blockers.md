# NEBU Bestellsystem – Sicherheits- und Datenschutzpunkte

Stand: 2026-11-19 (TEST-Branch `test/iphone-push-bestellcenter`). Code-Review-Liste, **kein** Penetrationstest-Zertifikat.

## Befunde vom 2026-11-18 – Status

| # | Befund | Status | Umsetzung |
|---|---|---|---|
| 1 | Öffentliche Abfragen und Mitarbeiter-API vermischt | **behoben** | Getrennte Funktionen: `shop-api` (öffentlich: Bestellweg, Ausverkauft-Liste, Bestellung aufgeben, eigene Bestellung per Token) und `nebu-orders` (nur angemeldete Mitarbeiter). `demo-orders` leitet nur noch weiter. |
| 2 | Kunden-Status-Token | **behoben** | 256-Bit-Zufallstoken, in der Datenbank nur als SHA-256-Hash, gültig 48 Std., nie in URLs; Kundensicht ohne Kontaktdaten, Zahlungs- und Prüfprotokolle. |
| 3 | Gemeinsamer Mitarbeiter-Code | **behoben** | Persönliche Zugänge (Name + PIN, PBKDF2-SHA256 mit 210.000 Runden), Rollen Inhaber/Mitarbeiter, Sperre nach 5 falschen PINs (15 Min.), serverseitige Sitzungen: jede Anfrage prüft die Sitzung in der Datenbank → Gerät abmelden, PIN ändern oder Zugang deaktivieren wirkt **sofort**. Schicht max. 12 Std. Änderungsprotokoll mit Mitarbeitername für alle Bestell-, Zahlungs-, Team- und Einstellungsänderungen. |
| 4 | Keine Löschfristen, 100-Bestellungen-Grenze | **behoben (Technik)**, Frist = **Inhaber-Entscheidung** | Eine Datenbankzeile pro Bestellung, kein Verlust alter Bestellungen. Anonymisierung abgeschlossener Bestellungen nach einstellbarer Frist (7–365 Tage) – **standardmäßig aus**, Einschalten nur durch den Inhaber in NEBU Control. Beträge, Artikel, Zeiten und Zahlungsprotokoll bleiben erhalten. Technische Bereinigung (abgelaufene Tokens, Push-Abos, Drosselzähler, alte Sitzungen) läuft automatisch. |
| 5 | Nicht-atomare Drosselung | **behoben** | Zähler in PostgreSQL (`INSERT … ON CONFLICT … RETURNING`), getestet mit parallelen Anfragen. Grenzen live: 6 Bestellungen / 15 Min. und 30 / Tag pro IP; Anmeldung 20 / 15 Min. pro IP. |
| 6 | Mitarbeiter-API liefert alle Bestellungen | **behoben** | Nur offene Bestellungen + abgeschlossene der letzten 24 Std. (max. 500). |
| 7 | Fehlerprotokolle | **behoben** | Zentrale Protokollierung ohne Anfrageinhalte; E-Mail-Adressen und Telefonnummern werden vor dem Schreiben maskiert. |
| 8 | CORS/CSRF/Header | **erledigt, mit Rest** | Kein CORS freigegeben (nur gleiche Herkunft). Anmeldung über `Authorization`-Header statt Cookies → kein CSRF-Angriffsweg. CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy gesetzt. **Rest:** Seiten nutzen Inline-Skripte, daher `script-src 'unsafe-inline'`; Schutz vor eingeschleustem Code beruht auf konsequenter `textContent`-Ausgabe. |

## Weitere Maßnahmen
- Druckdienst: eigener Token je Umgebung; der Druckdienst sieht nur Bestellnummer, Name, Artikel, Sonderwünsche und Zeiten (keine Telefonnummer/Adresse). Steuerzeichen aus Kundentexten werden vor dem Druck entfernt.
- Live-Umgebung ignoriert alle Test-Schlüssel (`NEBU_TEST_*`); Online-Bestellung ist live **aus**, bis der Inhaber sie einschaltet.
- Doppelte Bestellnummern bei gleichzeitigen Bestellungen ausgeschlossen (gefunden und behoben beim Lasttest).

## Offen / nicht durch Code lösbar
- [ ] Unabhängige Sicherheitsprüfung und rechtliche Datenschutzprüfung vor Echtbetrieb (empfohlen).
- [ ] Auftragsverarbeitungsvertrag (AVV) mit Netlify (Hosting, Datenbank) prüfen/abschließen; Datenschutzerklärung ergänzen (Bestelldaten, Push-Benachrichtigungen, ggf. OpenStreetMap-Adressprüfung bei Lieferung).
- [ ] Löschfrist festlegen (ggf. mit Steuerberater) und in NEBU Control einschalten.
- [ ] Backups/Wiederherstellung der Live-Datenbank testen; Notfallablauf „zurück zu WhatsApp“ einmal üben.

## Tests
`npm i --no-save embedded-postgres pg jsdom@24` und dann `node --test --experimental-test-module-mocks tests/`. Die Server-Tests laufen gegen eine echte PostgreSQL-Datenbank (Parallelität, Sperren, Drosselung).
