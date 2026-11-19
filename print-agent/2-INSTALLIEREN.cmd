@echo off
rem NEBU Druckdienst - Installation (fragt nach Administratorrechten)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' | Unblock-File; Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -NoExit -ExecutionPolicy Bypass -File \"%~dp0install.ps1\"'"
