@echo off
title Song Fa Water Tanks - Attendance
cd /d "%~dp0"
echo(
echo   ==========================================
echo      Song Fa Water Tanks - Attendance System
echo   ==========================================
echo(

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed on this PC.
  echo   Ask IT to run this once, then try again:
  echo(
  echo       winget install OpenJS.NodeJS.LTS
  echo(
  echo   Opening the download page...
  start "" https://nodejs.org/en/download
  echo(
  pause
  exit /b
)

if not exist node_modules (
  echo   First-time setup - installing components. Please wait...
  echo(
  call npm install --omit=dev
  echo(
)

echo   Starting up. Your browser will open in a moment.
echo(
echo   ^>^>  KEEP THIS WINDOW OPEN while you use it.
echo   ^>^>  To STOP, just close this window.
echo(

rem open the browser a few seconds after the server has started
start "" /min cmd /c "timeout /t 3 >nul & explorer http://localhost:8080"

node server.js

echo(
echo   Stopped. You can close this window.
pause >nul
