# Starts AlifGunadi Office in the background (if not already running) and opens it in the browser.
# The page is opened with this user's token in the address fragment (#token=...). The page trades it for a session cookie at once and
# removes it from the address bar; the fragment is never sent to the server. The token lives in a file only this user can read
# (%LOCALAPPDATA%\AlifGunadiOffice\token, or ALIFGUNADI_OFFICE_TOKEN_FILE) and is what allows starting agents from the page.
$ErrorActionPreference = "Stop"
$port = if ($env:ALIFGUNADI_OFFICE_PORT) { [int]$env:ALIFGUNADI_OFFICE_PORT } else { 4317 }
node (Join-Path $PSScriptRoot "ensure-server.js")
Start-Sleep -Milliseconds 800

$tokenFile = if ($env:ALIFGUNADI_OFFICE_TOKEN_FILE) { $env:ALIFGUNADI_OFFICE_TOKEN_FILE } else { Join-Path $env:LOCALAPPDATA "AlifGunadiOffice\token" }
$token = ""
for ($i = 0; $i -lt 10 -and -not $token; $i++) {
  if (Test-Path -LiteralPath $tokenFile) {
    $candidate = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    if ($candidate -match '^[0-9a-f]{64}$') { $token = $candidate }
  }
  if (-not $token) { Start-Sleep -Milliseconds 300 }
}
$url = "http://127.0.0.1:$port/"
if ($token) { $url += "#token=$token" } else { Write-Warning "No token file yet: the page opens as a viewer (tasks cannot be started from it)." }
Start-Process $url
