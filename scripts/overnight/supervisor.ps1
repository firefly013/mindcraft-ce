#requires -Version 7.0
<#
整夜双 Bot 实测装置 - 守护进程（supervisor）

职责：
  1) 用 SETTINGS_JSON 注入 init_message（见 scripts/overnight/overnight-settings.json），
     启动 main.ts（--profiles overnight-a/b，--mc-host 127.0.0.1 --mc-port 61359）。
  2) main 进程退出 / mindserver 端口长时间不可达 / watcher 写了 .restart-request 时，
     杀掉整棵进程树并自动拉起。
  3) 拉起 watcher（scripts/overnight/watch.mjs）做日志/反馈/告警采集。
  4) 心跳写入 tmp/overnight/supervisor-status.json；重启事件写入 tmp/overnight/restarts.jsonl。

停：新建 tmp/overnight/.stop 后等一个轮询周期（或运行 stop.ps1）。
#>
[CmdletBinding()]
param(
    [int]$PollSeconds = 15,
    [double]$MaxHours = 12,
    [int]$PortDownRestartSeconds = 300,
    [switch]$Vision
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$runDir      = Join-Path $root 'tmp\overnight'
$settingsIn  = Join-Path $root 'scripts\overnight\overnight-settings.json'
$stopFlag    = Join-Path $runDir '.stop'
$restartFlag = Join-Path $runDir '.restart-request'
$mainPidFile = Join-Path $runDir 'main.pid'
$watchPidFile= Join-Path $runDir 'watcher.pid'
$statusFile  = Join-Path $runDir 'supervisor-status.json'
$superLog    = Join-Path $runDir 'supervisor.jsonl'
$restartLog  = Join-Path $runDir 'restarts.jsonl'
$mindPort    = 8080
$mcPort      = 61359

New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source

function Write-RunLog([string]$evt, [hashtable]$data = @{}) {
    $rec = @{ ts = (Get-Date).ToString('o'); evt = $evt } + $data
    $line = ($rec | ConvertTo-Json -Compress -Depth 6)
    Add-Content -Path $superLog -Value $line -Encoding utf8
    Write-Host "[supervisor] $line"
}

function Test-PidAlive([int]$ProcessId) {
    if (-not $ProcessId) { return $false }
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return ($null -ne $p)
}

function Stop-ProcessTree([int]$ProcessId) {
    if (-not $ProcessId) { return }
    try { & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null } catch { }
}

function Test-TcpPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch { return $false } finally { $client.Close() }
}

function Rotate-Log([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    for ($i = 2; $i -ge 1; $i--) {
        $prev = "$Path.$i"
        if (Test-Path $prev) { Move-Item -Force $prev "$Path.$($i + 1)" }
    }
    Move-Item -Force $Path "$Path.1"
}

$script:mainProc = $null
$script:mainStartedAt = $null
$script:lastExit = $null
$script:restartCount = 0
$script:backoffSec = 5
$script:watcherProc = $null
$script:startedAt = Get-Date
$script:portDownSince = $null

# ---- 注入 SETTINGS_JSON ----
$settingsRaw = Get-Content -Raw -Encoding utf8 $settingsIn
$settingsRaw = $settingsRaw -replace "^\uFEFF", ''
if ($Vision) {
    $obj = $settingsRaw | ConvertFrom-Json
    $obj.allow_vision = $true
    $settingsRaw = ($obj | ConvertTo-Json -Depth 10 -Compress)
}
try { $null = $settingsRaw | ConvertFrom-Json } catch { Write-RunLog 'fatal-bad-settings' @{ err = $_.Exception.Message }; exit 2 }
$env:SETTINGS_JSON = $settingsRaw
$env:MINDSERVER_PORT = [string]$mindPort
$env:OPENCODE_SESSION_ID = 'overnight'
$env:NO_COLOR = '1'
$env:FORCE_COLOR = '0'

function Start-Main {
    Rotate-Log (Join-Path $runDir 'stdout.log')
    Rotate-Log (Join-Path $runDir 'stderr.log')
    $args = @(
        '--import', 'tsx', 'main.ts',
        '--profiles', 'profiles/overnight-a.json', 'profiles/overnight-b.json',
        '--mc-host', '127.0.0.1', '--mc-port', [string]$mcPort
    )
    $script:mainProc = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $runDir 'stdout.log') `
        -RedirectStandardError  (Join-Path $runDir 'stderr.log') `
        -WindowStyle Hidden -PassThru
    $script:mainStartedAt = Get-Date
    $script:portDownSince = $null
    Set-Content -Path $mainPidFile -Value $script:mainProc.Id -Encoding utf8
    Write-RunLog 'main-started' @{ pid = $script:mainProc.Id; at = $script:mainStartedAt.ToString('o') }
}

function Start-Watcher {
    $watcherArgs = @((Join-Path $root 'scripts\overnight\watch.mjs'), '--root', $root, '--port', [string]$mindPort)
    $script:watcherProc = Start-Process -FilePath $node -ArgumentList $watcherArgs -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $runDir 'watcher.out.log') `
        -RedirectStandardError  (Join-Path $runDir 'watcher.err.log') `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $watchPidFile -Value $script:watcherProc.Id -Encoding utf8
    Write-RunLog 'watcher-started' @{ pid = $script:watcherProc.Id }
}

function Write-Status {
    $alive = $false
    if ($script:mainProc) { try { $alive = -not $script:mainProc.HasExited } catch { $alive = $false } }
    $uptime = if ($script:mainStartedAt) { [math]::Round(((Get-Date) - $script:mainStartedAt).TotalSeconds, 0) } else { $null }
    $status = [ordered]@{
        supervisorPid   = $PID
        startedAt       = $script:startedAt.ToString('o')
        updatedAt       = (Get-Date).ToString('o')
        restartCount    = $script:restartCount
        mainPid         = if ($script:mainProc) { $script:mainProc.Id } else { $null }
        mainAlive       = $alive
        mainStartedAt   = if ($script:mainStartedAt) { $script:mainStartedAt.ToString('o') } else { $null }
        mainUptimeSec   = $uptime
        lastExit        = $script:lastExit
        mindserverPort  = $mindPort
        mindserverUp    = (Test-TcpPort $mindPort)
        mcServerUp      = (Test-TcpPort $mcPort)
        watcherPid      = if ($script:watcherProc) { $script:watcherProc.Id } else { $null }
        watcherAlive    = if ($script:watcherProc) { -not $script:watcherProc.HasExited } else { $false }
        backoffSec      = $script:backoffSec
    }
    ($status | ConvertTo-Json -Depth 5) | Set-Content -Path $statusFile -Encoding utf8
}

Write-RunLog 'supervisor-up' @{ root = $root; node = $node; until = $script:startedAt.AddHours($MaxHours).ToString('o') }
Start-Main
Start-Watcher

while (-not (Test-Path $stopFlag)) {
    if (((Get-Date) - $script:startedAt).TotalHours -gt $MaxHours) {
        Write-RunLog 'max-hours-reached'
        break
    }

    if ($script:watcherProc -and $script:watcherProc.HasExited) {
        Write-RunLog 'watcher-exited' @{ code = $script:watcherProc.ExitCode }
        Start-Watcher
    }

    if (Test-Path $restartFlag) {
        $reason = (Get-Content -Raw $restartFlag -ErrorAction SilentlyContinue)
        Remove-Item -Force $restartFlag -ErrorAction SilentlyContinue
        # 刚起来的 main 正在重新登录，watcher 可能还拿着"上一个进程期间"的陈旧
        # 离线/停滞基线来请求重启（实测把只活了 22 秒的新进程又杀了一次）。
        # 所以主动重启后的 3 分钟内忽略 watcher 的请求——真正的崩溃由下面的
        # "main 退出"分支兜底，不会漏。
        $sinceStart = if ($script:mainStartedAt) { ((Get-Date) - $script:mainStartedAt).TotalSeconds } else { 999 }
        if ($sinceStart -lt 180) {
            Write-RunLog 'restart-request-ignored' @{ reason = "$reason"; sinceStartSec = [math]::Round($sinceStart, 0) }
        } else {
            Write-RunLog 'restart-requested' @{ reason = "$reason" }
            Add-Content -Path $restartLog -Value ((@{ ts = (Get-Date).ToString('o'); by = 'watcher'; reason = "$reason" } | ConvertTo-Json -Compress)) -Encoding utf8
            Stop-ProcessTree ($script:mainProc.Id)
            Start-Sleep -Seconds 3
        }
    }

    $exited = $true
    if ($script:mainProc) { try { $exited = $script:mainProc.HasExited } catch { $exited = $true } }
    if ($exited) {
        $code = $null; try { $code = $script:mainProc.ExitCode } catch { }
        $livedSec = if ($script:mainStartedAt) { ((Get-Date) - $script:mainStartedAt).TotalSeconds } else { 0 }
        $script:lastExit = @{ code = $code; at = (Get-Date).ToString('o'); livedSec = [math]::Round($livedSec, 0) }
        $script:restartCount++
        if ($livedSec -lt 30) {
            $script:backoffSec = [math]::Min(300, [math]::Max(5, $script:backoffSec * 2))
        } else {
            $script:backoffSec = 5
        }
        Write-RunLog 'main-exited' @{ code = $code; livedSec = [math]::Round($livedSec, 0); restartCount = $script:restartCount; backoffSec = $script:backoffSec }
        Add-Content -Path $restartLog -Value ((@{ ts = (Get-Date).ToString('o'); by = 'supervisor'; code = $code; livedSec = [math]::Round($livedSec,0); backoffSec = $script:backoffSec } | ConvertTo-Json -Compress)) -Encoding utf8
        Start-Sleep -Seconds $script:backoffSec
        Start-Main
        Write-Status
        continue
    }

    if (Test-TcpPort $mindPort) {
        $script:portDownSince = $null
    } else {
        if (-not $script:portDownSince) { $script:portDownSince = Get-Date }
        $downFor = ((Get-Date) - $script:portDownSince).TotalSeconds
        if ($downFor -gt $PortDownRestartSeconds) {
            Write-RunLog 'mindserver-port-down-restart' @{ downSec = [math]::Round($downFor, 0) }
            Stop-ProcessTree ($script:mainProc.Id)
            Start-Sleep -Seconds 3
        }
    }

    Write-Status
    Start-Sleep -Seconds $PollSeconds
}

Write-RunLog 'supervisor-stopping'
Stop-ProcessTree ($script:mainProc.Id)
Stop-ProcessTree ($script:watcherProc.Id)
Remove-Item -Force $mainPidFile, $watchPidFile -ErrorAction SilentlyContinue
Write-Status
Write-RunLog 'supervisor-down'
