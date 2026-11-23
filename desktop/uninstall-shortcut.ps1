# Removes the "AlifGunadi Office" Desktop and Start Menu shortcuts created by install-shortcut.ps1.
$paths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "AlifGunadi Office.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "AlifGunadi Office.lnk")
)
foreach ($path in $paths) {
  if (Test-Path $path) { Remove-Item $path; Write-Output "Removed $path" }
}
