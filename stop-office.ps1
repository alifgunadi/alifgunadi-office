# Stops AlifGunadi Office. It stays stopped until a new Claude Code session or start-office.ps1.
$port = if ($env:ALIFGUNADI_OFFICE_PORT) { [int]$env:ALIFGUNADI_OFFICE_PORT } else { 4317 }

# Preferred: ask the server to stop itself (also sets the "stopped" marker).
try {
  Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:$port/control/stop" -Headers @{ "X-AlifGunadi-Office" = "1" } -TimeoutSec 3 -UseBasicParsing | Out-Null
  Write-Host "AlifGunadi Office stopped." -ForegroundColor Green
  exit 0
} catch {
  # Fall through: server not reachable or an older version without /control/stop.
}

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Host "AlifGunadi Office is not running on port $port." -ForegroundColor Yellow
  exit 0
}
$proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -match '^(node|bun)$') {
  Stop-Process -Id $proc.Id -Force
  New-Item -ItemType File -Force (Join-Path $env:TEMP "alifgunadi-office.stopped") | Out-Null
  Write-Host "AlifGunadi Office stopped (PID $($proc.Id))." -ForegroundColor Green
} else {
  Write-Host "Port $port is used by '$($proc.ProcessName)', not AlifGunadi Office. Nothing stopped." -ForegroundColor Red
}
