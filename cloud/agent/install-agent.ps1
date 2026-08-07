# Installs the ZK Attendance Agent as a Windows Scheduled Task that starts at
# boot, runs as SYSTEM (so it works even with nobody logged in), and restarts
# itself on failure. Safe to re-run — replaces any existing registration.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "ZK Attendance Agent"

Write-Host "============================================"
Write-Host "  ZK Attendance Agent - Installer"
Write-Host "============================================"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js was not found on this PC."
  Write-Host "Install it from https://nodejs.org (the LTS version), then run this installer again."
  Read-Host "Press Enter to exit"
  exit 1
}

$envFile = Join-Path $here ".env"
if (-not (Test-Path $envFile)) {
  Write-Host "No .env file found in this folder ($here)."
  Write-Host "Copy .env.example to .env and fill in SUPABASE_URL and SUPABASE_SERVICE_KEY"
  Write-Host "(from Supabase -> Project Settings -> API), then run this installer again."
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "Installing dependencies..."
Push-Location $here
& npm install
$npmOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $npmOk) {
  Write-Host "npm install failed - see the error above."
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host ""
Write-Host "Registering the scheduled task..."

# Idempotent: drop any prior registration so re-running this installer is safe.
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false

$runScript = Join-Path $here "run-agent.bat"
$action    = New-ScheduledTaskAction -Execute $runScript -WorkingDirectory $here
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Pulls ZKTeco attendance devices on the local network and pushes punches to Supabase. Read-only toward devices." | Out-Null

Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "============================================"
Write-Host "  Done."
Write-Host "============================================"
Write-Host "The agent now starts automatically every time this PC boots - even before"
Write-Host "anyone logs in - and keeps pulling the configured devices on a timer"
Write-Host "(set PULL_INTERVAL_MIN in .env, default 15 minutes) for as long as the PC stays on."
Write-Host ""
Write-Host "  Check it's running:    Get-ScheduledTask '$taskName' | Get-ScheduledTaskInfo"
Write-Host "  See recent activity:   type agent.log"
Write-Host "  Stop and remove it:    uninstall-agent.bat"
Write-Host ""
Read-Host "Press Enter to close"
