#requires -Version 7.0
<# 停整夜双 Bot 实测装置。用法：pwsh scripts/overnight/stop.ps1 #>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runDir = Join-Path $root 'tmp\overnight'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
Set-Content -Path (Join-Path $runDir '.stop') -Value (Get-Date).ToString('o') -Encoding utf8
$supPidFile = Join-Path $runDir 'supervisor.pid'
if (Test-Path $supPidFile) {
    $supId = [int](Get-Content -Raw $supPidFile)
    for ($i = 0; $i -lt 40; $i++) {
        if (-not (Get-Process -Id $supId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $supId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $supId /T /F 2>$null | Out-Null }
}
foreach ($f in @('main.pid', 'watcher.pid')) {
    $p = Join-Path $runDir $f
    if (Test-Path $p) {
        $id = [int](Get-Content -Raw $p)
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
    }
}
Write-Host 'overnight stopped.'
