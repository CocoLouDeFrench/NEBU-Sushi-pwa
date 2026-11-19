# NEBU Druckdienst entfernen (als Administrator). Konfiguration/Journal bleiben, außer mit -RemoveData.
param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'NEBU Druckdienst' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'NEBU Druckdienst' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles 'NEBU-Druckdienst') -ErrorAction SilentlyContinue
if($RemoveData){ Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'NEBU-Druckdienst') }
Write-Host 'NEBU Druckdienst entfernt.'
