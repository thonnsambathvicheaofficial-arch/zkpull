@echo off
REM Double-click this. Installing a SYSTEM-run scheduled task needs admin
REM rights, so if you're not already elevated this re-launches itself with a
REM UAC prompt — click Yes there, then this window can be closed.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator access - click "Yes" in the prompt...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-agent.ps1"
