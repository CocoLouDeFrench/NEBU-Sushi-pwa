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
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Force (Join-Path $Here 'nebu-print-agent.mjs'),(Join-Path $Here 'escpos.mjs') $AppDir
Copy-Item -Force (Join-Path $Here 'package.json') $AppDir

Step 'Konfiguration'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Nur SYSTEM und Administratoren dürfen Konfiguration (Token), Journal und Protokolle lesen.
icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if(Test-Path $Config){
  Write-Host "Vorhandene Konfiguration bleibt erhalten: $Config"
}else{
  if($Mode -eq 'tcp' -and -not $PrinterHost){
    $p = Get-Printer | Where-Object { $_.Name -match 'TM-T20' } | Select-Object -First 1
    if($p){ $port = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue; if($port.PrinterHostAddress){ $PrinterHost = $port.PrinterHostAddress } }
    if(-not $PrinterHost){ $PrinterHost = Read-Host 'IP-Adresse des Epson-Druckers' }
  }
  if($Mode -eq 'windows' -and -not $PrinterName){ $PrinterName = (Get-Printer | Where-Object { $_.Name -match 'TM-T20' } | Select-Object -First 1).Name }
  if($TokenFile -and (Test-Path $TokenFile)){ $token = (Get-Content -Raw $TokenFile).Trim() }
  else{ $sec = Read-Host 'Druckdienst-Token (NEBU_PRINT_AGENT_TOKEN)' -AsSecureString; $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
  if($token.Length -lt 32){ throw 'Token zu kurz.' }
  $printer = if($Mode -eq 'tcp'){ @{ mode='tcp'; host=$PrinterHost; port=9100 } } else { @{ mode='windows'; name=$PrinterName } }
  @{ apiUrl=$ApiUrl; token=$token; pollSeconds=5; agentId=$env:COMPUTERNAME; printer=$printer } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $Config
  Write-Host "Konfiguration geschrieben: $Config (Drucker: $($printer.host)$($printer.name))"
}
# Einmal-Tokendatei nicht liegen lassen.
if($TokenFile -and (Test-Path $TokenFile)){ Remove-Item -Force $TokenFile; Write-Host 'Einmal-Tokendatei gelöscht.' }

Step 'Prüfung (Drucker + NEBU Control)'
& $node (Join-Path $AppDir 'nebu-print-agent.mjs') --check

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
Start-Sleep -Seconds 4
try{ $h = Invoke-RestMethod -Uri 'http://127.0.0.1:47123/' -TimeoutSec 5; Write-Host ("Dienst läuft · Drucker: " + $h.printer.detail) -ForegroundColor Green }
catch{ Write-Host "Dienst antwortet noch nicht – Protokoll: $DataDir\logs" -ForegroundColor Red }
Write-Host "`nFertig. Status: http://127.0.0.1:47123/  ·  Protokolle: $DataDir\logs"
