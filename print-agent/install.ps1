# NEBU Druckdienst · Installation unter Windows 10/11
# Ausführen in PowerShell als Administrator:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Was passiert:
#   1. Node.js LTS wird installiert, falls nicht vorhanden (winget).
#   2. Programmdateien  -> C:\Program Files\NEBU-Druckdienst
#   3. Konfiguration    -> C:\ProgramData\NEBU-Druckdienst\config.json (nur SYSTEM + Administratoren lesbar)
#   4. Geplante Aufgabe "NEBU Druckdienst": startet beim Hochfahren als SYSTEM, ohne Anmeldung
#      und ohne Browserfenster, Neustart bei Absturz.
# Bestehende Konfiguration und das Druckjournal bleiben bei erneuter Installation erhalten.
param(
  [string]$ApiUrl = 'https://nebu-iphone-push-test.netlify.app',
  [string]$PrinterHost = '',
  [string]$PrinterName = '',
  [ValidateSet('tcp','windows')][string]$Mode = 'tcp',
  [string]$TokenFile = ''
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NEBU Druckdienst'
$AppDir   = Join-Path $env:ProgramFiles 'NEBU-Druckdienst'
$DataDir  = Join-Path $env:ProgramData 'NEBU-Druckdienst'
$Config   = Join-Path $DataDir 'config.json'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($t){ Write-Host "`n==> $t" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){ throw 'Bitte PowerShell "Als Administrator ausführen" und das Skript erneut starten.' }
if($ApiUrl -match 'shop\.nebusushi\.com'){ throw 'Testinstallation: Der Live-Shop ist hier nicht erlaubt.' }

Step 'Node.js prüfen'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if(-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")){ $node = "$env:ProgramFiles\nodejs\node.exe" }
if(-not $node){
  Write-Host 'Node.js nicht gefunden – installiere Node.js LTS über winget ...'
  winget install --id OpenJS.NodeJS.LTS -e --scope machine --accept-source-agreements --accept-package-agreements --silent
  $node = "$env:ProgramFiles\nodejs\node.exe"
  if(-not (Test-Path $node)){ throw 'Node.js-Installation fehlgeschlagen.' }
}
$ver = & $node --version
if([int]($ver.TrimStart('v').Split('.')[0]) -lt 18){ throw "Node.js $ver ist zu alt (mind. 18)." }
Write-Host "Node.js $ver · $node"

Step 'Programmdateien kopieren'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2  # laufenden Dienst beenden lassen (Stop-ScheduledTask beendet auch node.exe)
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Force (Join-Path $Here 'nebu-print-agent.mjs'),(Join-Path $Here 'escpos.mjs') $AppDir
Copy-Item -Force (Join-Path $Here 'package.json') $AppDir

Step 'Konfiguration'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Nur SYSTEM und Administratoren dürfen Konfiguration (Token), Journal und Protokolle lesen.
icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if(Test-Path $Config){
  $raw = [IO.File]::ReadAllBytes($Config)
  if($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF){
    [IO.File]::WriteAllBytes($Config, [byte[]]$raw[3..($raw.Length-1)]); Write-Host 'Konfiguration repariert (BOM entfernt).'
  }
  Write-Host "Vorhandene Konfiguration bleibt erhalten: $Config"
}else{
  if($Mode -eq 'tcp' -and -not $PrinterHost){
    $p = Get-Printer | Where-Object { $_.Name -match 'TM-T20' } | Select-Object -First 1
    if($p){ $port = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue; if($port.PrinterHostAddress){ $PrinterHost = $port.PrinterHostAddress } }
    if(-not $PrinterHost){ $PrinterHost = Read-Host 'IP-Adresse des Epson-Druckers' }
  }
  if($Mode -eq 'windows' -and -not $PrinterName){ $PrinterName = (Get-Printer | Where-Object { $_.Name -match 'TM-T20' } | Select-Object -First 1).Name }
  if($TokenFile -and (Test-Path $TokenFile)){ $token = (Get-Content -Raw $TokenFile).Trim() }
  else{
    # Neuen zufälligen Schlüssel auf diesem PC erzeugen (verlässt den PC nur über die Zwischenablage nach Netlify).
    $bytes = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    Set-Clipboard -Value $token
    Write-Host ''
    Write-Host 'Neuer Druckdienst-Schlüssel wurde erzeugt und in die Zwischenablage kopiert.' -ForegroundColor Green
    Write-Host 'Jetzt in Netlify eintragen (nur TESTprojekt nebu-iphone-push-test):'
    Write-Host '  Project configuration > Environment variables > Add a variable'
    Write-Host '  Key:   NEBU_PRINT_AGENT_TOKEN'
    Write-Host '  Value: Strg+V  (Option "Contains secret values" anhaken, falls angeboten)'
    Write-Host 'Danach in Netlify: Deploys > Trigger deploy > Deploy project.'
    Read-Host 'Wenn Variable gespeichert und Deploy fertig ist, Enter drücken'
  }
  if($token.Length -lt 32){ throw 'Token zu kurz.' }
  $printer = if($Mode -eq 'tcp'){ @{ mode='tcp'; host=$PrinterHost; port=9100 } } else { @{ mode='windows'; name=$PrinterName } }
  $json = @{ apiUrl=$ApiUrl; token=$token; pollSeconds=5; agentId=$env:COMPUTERNAME; printer=$printer } | ConvertTo-Json -Depth 4
  # UTF-8 OHNE BOM schreiben (Node.js kann BOM nicht lesen).
  [IO.File]::WriteAllText($Config, $json, (New-Object Text.UTF8Encoding $false))
  Write-Host "Konfiguration geschrieben: $Config (Drucker: $($printer.host)$($printer.name))"
}
# Einmal-Tokendatei nicht liegen lassen.
if($TokenFile -and (Test-Path $TokenFile)){ Remove-Item -Force $TokenFile; Write-Host 'Einmal-Tokendatei gelöscht.' }

Step 'Prüfung (Drucker + NEBU Control)'
& $node (Join-Path $AppDir 'nebu-print-agent.mjs') --check
if($LASTEXITCODE -ne 0){ Write-Host 'Prüfung fehlgeschlagen – Details siehe oben.' -ForegroundColor Red }

Step 'Autostart einrichten (geplante Aufgabe)'
$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$AppDir\nebu-print-agent.mjs`"" -WorkingDirectory $AppDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'NEBU Control: druckt angenommene Bestellungen automatisch als Küchenbon (Epson TM-T20III).' -Force | Out-Null
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Step 'Abschlussprüfung'
# 1) TCP-Verbindung zum Drucker (Port 9100), ohne WMI
try{
  $cfg = [IO.File]::ReadAllText($Config) | ConvertFrom-Json
  if($cfg.printer.mode -eq 'tcp'){
    $tcp = New-Object Net.Sockets.TcpClient
    $ok = $tcp.ConnectAsync($cfg.printer.host, [int]$cfg.printer.port).Wait(3000) -and $tcp.Connected
    $tcp.Close()
    if($ok){ Write-Host ("Drucker " + $cfg.printer.host + ":" + $cfg.printer.port + " erreichbar") -ForegroundColor Green }
    else{ Write-Host ("Drucker " + $cfg.printer.host + ":" + $cfg.printer.port + " NICHT erreichbar") -ForegroundColor Red }
  }
}catch{ Write-Host ('Druckertest: ' + $_.Exception.Message) -ForegroundColor Red }
# 2) Geplante Aufgabe (Autostart)
try{
  $t = Get-ScheduledTask -TaskName $TaskName
  $trig = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
  Write-Host ("Autostart: Aufgabe '" + $TaskName + "' · Status " + $t.State + " · Auslöser " + $trig + " · Konto " + $t.Principal.UserId) -ForegroundColor Green
}catch{ Write-Host ('Autostart-Prüfung: ' + $_.Exception.Message) -ForegroundColor Red }
# 3) Statusseite auf Port 47123 (bis zu 20 s warten)
$h = $null
for($i=0; $i -lt 10 -and -not $h; $i++){ Start-Sleep -Seconds 2; try{ $h = Invoke-RestMethod -Uri 'http://127.0.0.1:47123/' -TimeoutSec 3 }catch{} }
if($h){
  Write-Host ("Statusseite OK · Version " + $h.version + " · Drucker: " + $h.printer.detail) -ForegroundColor Green
  if($h.lastError){ Write-Host ("Letzter Fehler: " + $h.lastError) -ForegroundColor Red }
  elseif($h.lastOkAt){ Write-Host ("Verbindung zu NEBU Control OK · " + $h.lastOkAt) -ForegroundColor Green }
}else{
  Write-Host "Dienst antwortet nicht. Letzte Protokollzeilen:" -ForegroundColor Red
  $log = Get-ChildItem (Join-Path $DataDir 'logs') -Filter *.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if($log){ Get-Content $log.FullName -Tail 15 }
}
Write-Host "`nFertig. Status: http://127.0.0.1:47123/  ·  Protokolle: $DataDir\logs"
