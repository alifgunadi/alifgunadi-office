<#
.SYNOPSIS
  Sums Private Working Set (Task Manager "Memory" column) for a process and all of its descendants.

.EXAMPLE
  # AlifGunadi Office desktop app (host + all msedgewebview2.exe children)
  .\measure-ram.ps1 -Name AlifGunadiOffice

.EXAMPLE
  # Any process tree, 10 samples 2 s apart, JSON output for scripts
  .\measure-ram.ps1 -RootPid 1234 -Samples 10 -IntervalSec 2 -Json
#>
param(
  [int]$RootPid = 0,
  [string]$Name = '',
  [int]$Samples = 1,
  [double]$IntervalSec = 1,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'

if (-not $RootPid) {
  if (-not $Name) { throw 'Pass -RootPid or -Name' }
  $p = Get-Process -Name $Name -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
  if (-not $p) { throw "Process '$Name' is not running" }
  $RootPid = $p.Id
}

function Get-TreeIds([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $children = @{}
  foreach ($proc in $all) {
    $ppid = [int]$proc.ParentProcessId
    if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }
    $children[$ppid].Add([int]$proc.ProcessId)
  }
  $ids = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($root)
  while ($queue.Count) {
    $id = $queue.Dequeue()
    if ($ids.Contains($id)) { continue }
    $ids.Add($id)
    if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $queue.Enqueue($c) } }
  }
  return $ids
}

$results = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $ids = Get-TreeIds $RootPid
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess, Name, WorkingSetPrivate |
    Where-Object { $ids.Contains([int]$_.IDProcess) }
  $total = ($perf | Measure-Object -Property WorkingSetPrivate -Sum).Sum
  $results += [pscustomobject]@{
    sample        = $i + 1
    processes     = @($perf).Count
    privateWsMB   = [math]::Round($total / 1MB, 1)
    breakdown     = ($perf | Sort-Object WorkingSetPrivate -Descending | ForEach-Object { '{0}={1:N1}MB' -f $_.Name, ($_.WorkingSetPrivate / 1MB) }) -join ', '
  }
  if ($i -lt $Samples - 1) { Start-Sleep -Milliseconds ([int]($IntervalSec * 1000)) }
}

$values = $results | ForEach-Object { $_.privateWsMB } | Sort-Object
$median = $values[[int][math]::Floor(($values.Count - 1) / 2)]
$summary = [pscustomobject]@{
  rootPid      = $RootPid
  samples      = $results.Count
  medianMB     = $median
  maxMB        = ($values | Measure-Object -Maximum).Maximum
  processes    = $results[-1].processes
  lastBreakdown = $results[-1].breakdown
}
if ($Json) { $summary | ConvertTo-Json -Compress } else { $results | Format-Table -AutoSize; $summary | Format-List }
