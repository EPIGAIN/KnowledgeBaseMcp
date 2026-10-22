@echo off
powershell.exe -NoProfile -File "%~dp0scripts\Install-OneClick.ps1" %*
exit /b %errorlevel%
