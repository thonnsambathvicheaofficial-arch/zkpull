$ErrorActionPreference = 'Stop'
$taskName = "ZK Attendance Agent"

Write-Host "Removing the scheduled task '$taskName'..."
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed. The agent will no longer start automatically on boot."
} else {
  Write-Host "No such task was found - nothing to remove."
}
Write-Host "(.env and node_modules are untouched - run install-agent.bat again to re-enable.)"
Read-Host "Press Enter to close"
