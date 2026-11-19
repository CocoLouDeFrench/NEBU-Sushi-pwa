# NEBU Druckdienst · Systemprüfung (nur lesen, ändert nichts)
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
function W($t){ $out.Add($t); Write-Host $t }
W '=== NEBU Druckdienst · Systemprüfung ==='
W ("Datum: " + (Get-Date -Format 'dd.MM.yyyy HH:mm'))
try{ $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; W ("Windows: " + $cv.ProductName + " " + $cv.DisplayVersion + " · Build " + $cv.CurrentBuild) }catch{ W ("Windows: " + [Environment]::OSVersion.VersionString) }
W ("PC-Name: " + $env:COMPUTERNAME)
W ''
W '--- Drucker ---'
$printers = Get-Printer | Where-Object { $_.Name -match 'TM-?T20|EPSON|Epson' }
if(-not $printers){ W 'KEIN Epson-Drucker gefunden. Alle Drucker:'; Get-Printer | ForEach-Object { W ("  " + $_.Name + " · Port " + $_.PortName) } }
$ips = @()
foreach($p in $printers){
  $port = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue
  W ("Name: " + $p.Name + " · Treiber: " + $p.DriverName + " · Status: " + $p.PrinterStatus)
  W ("  Port: " + $p.PortName + " · Typ: " + $port.Description + " · Adresse: " + $port.PrinterHostAddress + " · Portnummer: " + $port.PortNumber)
  if($port.PrinterHostAddress){ $ips += $port.PrinterHostAddress }
  elseif($p.PortName -match '(\d{1,3}\.){3}\d{1,3}'){ $ips += $Matches[0] }
}
foreach($ip in ($ips | Select-Object -Unique)){
  $t = Test-NetConnection -ComputerName $ip -Port 9100 -WarningAction SilentlyContinue
  W ("  Verbindung zu " + $ip + ":9100 (RAW) -> " + $(if($t.TcpTestSucceeded){'OK'}else{'NICHT erreichbar'}))
}
W ''
W '--- Netzwerk ---'
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | ForEach-Object { W ("PC-IP: " + $_.IPAddress + "/" + $_.PrefixLength + " · " + $_.InterfaceAlias) }
try{ $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://nebu-iphone-push-test.netlify.app/' -TimeoutSec 10; W ("Test-Seite erreichbar: HTTP " + $r.StatusCode) }catch{ W ("Test-Seite NICHT erreichbar: " + $_.Exception.Message) }
W ''
W '--- Software ---'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
W ("Node.js: " + $(if($node){ (& node --version) + " · " + $node.Source } else { 'nicht installiert' }))
$wg = Get-Command winget.exe -ErrorAction SilentlyContinue
W ("winget: " + $(if($wg){ 'vorhanden' } else { 'nicht vorhanden' }))
W ("PowerShell: " + $PSVersionTable.PSVersion)
$task = Get-ScheduledTask -TaskName 'NEBU Druckdienst' -ErrorAction SilentlyContinue
W ("NEBU Druckdienst installiert: " + $(if($task){ 'ja · ' + $task.State } else { 'nein' }))
W ''
W '=== Ende ==='
try{ ($out -join "`r`n") | Set-Clipboard; Write-Host "`nErgebnis wurde in die Zwischenablage kopiert – bitte im Chat mit Strg+V einfügen." -ForegroundColor Green }catch{}
Read-Host "`nEnter drücken zum Schließen"
