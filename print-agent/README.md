# NEBU Druckdienst (Küchendruck, nur Testbetrieb)

Holt **angenommene** Bestellungen aus NEBU Control und druckt sie automatisch als Küchenbon auf dem Epson TM-T20III (80 mm, LAN).

- Pull-Modell: Der PC fragt alle 5 s bei NEBU Control nach (`/.netlify/functions/kitchen-print`). Keine offenen Ports am Restaurant-PC, kein Browserfenster.
- Jede Annahme erzeugt genau einen Druckauftrag (`kitchenPrint.jobId`). Doppeldruck-Schutz: Lease auf dem Server + lokales Journal (`C:\ProgramData\NEBU-Druckdienst\journal.json`), das vor dem Senden geschrieben wird.
- Drucker wird vor und nach dem Druck abgefragt (Papier leer, Deckel offen, offline). Fehlgeschlagene Drucke werden wiederholt (5 s → max. 60 s), solange die Bestellung in der Küche ist (angenommen / in Zubereitung).
- Internet weg: Aufträge bleiben auf dem Server, Bestätigungen werden nachgeholt.
- Der Button „Küchenbon drucken“ in NEBU Control bleibt als Backup.

## Installation
PowerShell **als Administrator**: `powershell -ExecutionPolicy Bypass -File .\install.ps1`

Das Skript erzeugt den Schlüssel `NEBU_PRINT_AGENT_TOKEN` auf dem PC; er wird im **Test**-Netlify-Projekt als Umgebungsvariable eingetragen. Der Token steht nur in `config.json` auf dem PC (nur SYSTEM/Administratoren lesbar), nie im Code.

## Bedienung
- Status: http://127.0.0.1:47123/
- Protokolle: `C:\ProgramData\NEBU-Druckdienst\logs`
- Testseite: `node "C:\Program Files\NEBU-Druckdienst\nebu-print-agent.mjs" --test` (als Admin)
- Neustart: Aufgabenplanung → „NEBU Druckdienst“ → Beenden / Ausführen
- Entfernen: `uninstall.ps1`

Drucker-IP fest vergeben (DHCP-Reservierung im Router), sonst `"mode":"windows"` mit Druckernamen verwenden.
