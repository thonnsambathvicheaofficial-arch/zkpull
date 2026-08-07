@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator access - click "Yes" in the prompt...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-agent.ps1"
