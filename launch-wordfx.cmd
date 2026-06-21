@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ://
cd /d "%~dp0"
set "TFX_LAUNCHER=1"

:restart
where node.exe >nul 2>nul
if not errorlevel 1 (
  node.exe wordfx.js
  set "TFX_EXIT=!errorlevel!"
  if "!TFX_EXIT!"=="42" goto restart
  exit /b !TFX_EXIT!
)

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" wordfx.js
  set "TFX_EXIT=!errorlevel!"
  if "!TFX_EXIT!"=="42" goto restart
  exit /b !TFX_EXIT!
)

echo :// requires Node.js, but node.exe was not found.
echo Install Node.js or add it to PATH, then run this launcher again.
pause
exit /b 1
