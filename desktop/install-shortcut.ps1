# Creates "AlifGunadi Office" shortcuts on the Desktop and in the Start Menu for desktop\app\AlifGunadiOffice.exe.
# Run after building (see desktop\README.md). Remove with uninstall-shortcut.ps1.
$ErrorActionPreference = "Stop"
$exe = Join-Path $PSScriptRoot "app\AlifGunadiOffice.exe"
if (-not (Test-Path $exe)) { throw "Build the app first: dotnet publish desktop\host-dotnet -c Release -o desktop\app" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "AlifGunadi Office.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "AlifGunadi Office.lnk")
)
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = Split-Path $exe
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = "AlifGunadi Office - live pixel office for Claude Code, Antigravity and OpenCode agents"
  $lnk.Save()
  Write-Output "Created $path"
}
