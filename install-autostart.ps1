# Optional: start AlifGunadi Office automatically when you log in to Windows.
# Registers a per-user scheduled task "AlifGunadiOffice" that runs ensure-server.js at logon.
# Remove it with uninstall-autostart.ps1.
$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot "ensure-server.js"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "AlifGunadiOffice" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Starts the AlifGunadi Office server (http://127.0.0.1:4317) at logon." -Force | Out-Null

Write-Host "Scheduled task 'AlifGunadiOffice' registered. It runs at your next logon." -ForegroundColor Green
Write-Host "Test it now with: Start-ScheduledTask -TaskName AlifGunadiOffice" -ForegroundColor Yellow
