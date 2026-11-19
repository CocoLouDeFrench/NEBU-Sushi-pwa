# NEBU Control ↔ Shop: gemeinsame Verwaltung (Entwurf, nur Testbranch)

## Ziel
Der bestehende Kunden-Shop bleibt die Bestelloberfläche. NEBU Control wird die Mitarbeiteroberfläche. Eine einzige autoritative Quelle verwaltet Artikelverfügbarkeit, Öffnungszeiten und Zubereitungszeit. Kein zweiter, unabhängiger Bestand im Livebetrieb.

## Stand und Grenzen
- Das NEBU-Control-Testsystem verwaltet Testbestellungen in PostgreSQL und Test-Verfügbarkeit separat in Netlify Blobs.
- Der produktive Shop bietet bereits eine Oberfläche für Geschäftsstatus, Zubereitungszeit und ausverkaufte Artikel.
- Die Implementierung und Speicherung der produktiven Shop-Einstellungen sind **noch nicht verifiziert**.
- Änderungen in diesem Dokument führen **keine** Live-Synchronisation aus und ändern **keine** Produktivdaten.

## Sichere Reihenfolge
1. Produktiven Shop-Code und bestehende Einstellungs-Endpunkte nur lesend prüfen. Authentifizierung, Speicherung, Artikel-IDs, Caching und Shop-Abfrage identifizieren.
2. In der Testumgebung einen gemeinsamen, serverseitigen Adapter entwerfen, der bestehende Shop-Daten in ein einheitliches Modell überführt. Artikel-ID-Mapping und Konfliktregeln festlegen.
3. Testmodus mit isolierten Daten: Artikel ausverkauft / wieder verfügbar, Öffnungszeiten ändern, Zubereitungszeit ändern, Kundenansicht prüfen.
4. Schreibzugriffe nur authentifiziert; kein Administrator-Schlüssel im Kunden-JavaScript; serverseitige Validierung und Audit-Log.
5. Vor Produktivfreigabe Rollback, Ausfallverhalten und Synchronisation zwischen zwei Geräten prüfen.
6. Erst nach ausdrücklicher Freigabe an den produktiven Shop anbinden.

## Vorschlag für gemeinsame Daten
- availability: Artikel-ID, verfügbar/ausverkauft, Zeitstempel, bearbeitet von (falls bekannt)
- businessStatus: automatisch/geöffnet/geschlossen
- preparationMinutes: positive ganze Zahl innerhalb konfigurierter Grenzen
- revision: monotone Version zur Konfliktprüfung

## Deployment
Automatische Netlify-Builds für das Testprojekt sind gestoppt. Änderungen bündeln; ein kontrolliertes Deployment nach Prüfung. Produktiv-Shop und Vareethip unverändert lassen.
