# Removes the "AlifGunadiOffice" logon task created by install-autostart.ps1.
$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName "AlifGunadiOffice" -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName "AlifGunadiOffice" -Confirm:$false
  Write-Host "Scheduled task 'AlifGunadiOffice' removed." -ForegroundColor Green
} else {
  Write-Host "Scheduled task 'AlifGunadiOffice' not found." -ForegroundColor Yellow
}
