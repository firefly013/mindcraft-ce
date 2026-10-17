#requires -Version 7.0
<# 看整夜双 Bot 实测装置状态。用法：pwsh scripts/overnight/status.ps1 #>
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runDir = Join-Path $root 'tmp\overnight'
foreach ($name in @('supervisor-status.json', 'watch-status.json')) {
    $f = Join-Path $runDir $name
    Write-Host "==== $name ===="
    if (Test-Path $f) { Get-Content -Raw $f } else { Write-Host '(missing)' }
}
$af = Join-Path $runDir 'ALERTS.md'
Write-Host "==== ALERTS.md (tail) ===="
if (Test-Path $af) { Get-Content $af -Tail 15 } else { Write-Host '(no alerts yet)' }
$ff = Join-Path $runDir 'feedback\FEEDBACK.md'
Write-Host "==== FEEDBACK.md (tail) ===="
if (Test-Path $ff) { Get-Content $ff -Tail 40 } else { Write-Host '(no feedback yet)' }
