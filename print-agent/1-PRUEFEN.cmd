@echo off
rem NEBU Druckdienst - Systempruefung (aendert nichts)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' | Unblock-File; & '%~dp0check.ps1'"
