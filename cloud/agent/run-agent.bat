@echo off
REM Launched by the "ZK Attendance Agent" scheduled task. Always runs from this
REM folder (cd /d) so the agent finds node_modules/.env regardless of what
REM working directory Task Scheduler starts it in.
cd /d "%~dp0"
node agent.js >> agent.log 2>&1
