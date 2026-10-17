#requires -Version 7.0
<# 启动整夜双 Bot 实测装置（后台守护进程）。用法：pwsh scripts/overnight/start.ps1 [-Vision] [-MaxHours 12] #>
param([switch]$Vision, [double]$MaxHours = 12)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runDir = Join-Path $root 'tmp\overnight'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
foreach ($f in @('.stop', '.restart-request')) { $p = Join-Path $runDir $f; if (Test-Path $p) { Remove-Item -Force $p } }
$supPidFile = Join-Path $runDir 'supervisor.pid'
if (Test-Path $supPidFile) {
    $old = Get-Process -Id ([int](Get-Content -Raw $supPidFile)) -ErrorAction SilentlyContinue
    if ($old) { Write-Host "overnight supervisor already running (pid $($old.Id)); 先 stop.ps1"; exit 0 }
}
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\overnight\supervisor.ps1'), '-MaxHours', [string]$MaxHours)
if ($Vision) { $args += '-Vision' }
$proc = Start-Process -FilePath $pwsh -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $supPidFile -Value $proc.Id -Encoding utf8
Write-Host "overnight supervisor started: pid $($proc.Id)"
Write-Host "  status: pwsh scripts/overnight/status.ps1"
Write-Host "  stop  : pwsh scripts/overnight/stop.ps1"
Write-Host "  logs  : tmp/overnight/{stdout,stderr}.log ; tmp/overnight/feedback/FEEDBACK.md ; tmp/overnight/ALERTS.md"
