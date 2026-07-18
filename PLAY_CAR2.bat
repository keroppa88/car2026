@echo off
setlocal
cd /d "%~dp0"
start "CAR2 local server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server.ps1" -Port 8765
endlocal
