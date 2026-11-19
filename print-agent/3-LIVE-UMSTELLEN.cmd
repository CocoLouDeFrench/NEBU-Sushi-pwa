@echo off
rem NEBU Druckdienst - auf LIVE (shop.nebusushi.com) umstellen. Erst nach Freigabe der Live-Schaltung ausfuehren!
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' | Unblock-File; Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -NoExit -ExecutionPolicy Bypass -File \"%~dp0install.ps1\" -Live'"
