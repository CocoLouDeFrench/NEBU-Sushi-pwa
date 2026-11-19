# NEBU Control – Freigabecheckliste

Stand: 2026-11-18. Testprojekt: nebu-iphone-push-test.netlify.app. Produktion: shop.nebusushi.com.

## Vor dem nächsten Test-Deployment
- [ ] Offline-Regression ausführen: `node --test tests/shop-product-map.test.mjs`.
- [ ] Syntax der geänderten Netlify Functions mit `node --check` prüfen.
- [ ] Testzugangsschlüssel und Datenbank-Konfiguration im Testprojekt prüfen, ohne Geheimnisse zu protokollieren.
- [ ] Keine automatischen Builds aktivieren, bevor der gebündelte Test bereit ist.

## Testbetrieb (keine echten Bestellungen)
- [ ] 76 Artikel und deren IDs abgleichen; simulierte Ausverkauft-Zuordnung ausführen.
- [ ] Live-Einstellungen schreibgeschützt abrufen; Shopstatus und Vorbereitungszeit mit Shop vergleichen.
- [ ] Testbestand: einen Artikel ausverkaufen und wieder freigeben; Kundenseite und serverseitige Bestellvalidierung prüfen.
- [ ] Testbestellung von Kundenseite anlegen; Push + Ton auf iPhone und iPad prüfen.
- [ ] Gleichzeitiges Annehmen derselben Bestellung auf beiden Geräten: genau ein Gerät gewinnt.
- [ ] Annehmen, ablehnen (mit Grund), zubereiten, bereit, abgeholt/geliefert, Zahlung, Storno prüfen.
- [ ] Küchenbon drucken; Bestelldaten und Sonderwünsche prüfen.
- [ ] Verspätungswarnung und Tagesübersicht mit bekannten Testdaten prüfen.
- [ ] Lieferadresse innerhalb/außerhalb 3 km Fahrstrecke und Ausschlusszonen testen.
- [ ] Verbindungsabbruch und Neuladen: keine doppelte Annahme und keine verlorene Bestellung.

## Vor Livebetrieb
- [ ] Produktionsanbindung explizit freigeben; niemals Testbestellungen in die Produktion übernehmen.
- [ ] Mitarbeiterzugriff authentifizieren; keine Admin-Schlüssel im öffentlichen Kundencode.
- [ ] Gemeinsame Artikelverfügbarkeit mit Servervalidierung und Rollback testen.
- [ ] Datenschutz, Kundendatenaufbewahrung und Zahlungsablauf prüfen.
- [ ] Notfallplan: Livebestellungen weiterhin über bisherige Shopverwaltung bearbeiten können.
- [ ] Erst nach bestätigtem Ende-zu-Ende-Test kontrolliert freischalten.

**Nicht als erledigt markieren, bevor tatsächlich getestet.**
