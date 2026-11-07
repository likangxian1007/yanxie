<#
.SYNOPSIS
  停止 start.ps1 启动的进程（只停它记录过 PID 的，不碰别的）。
  Stop only the processes start.ps1 started (tracked by PID files).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  # 只停这些部分：ovms / pdf-translate / server / web。Only stop these parts.
  [string[]]$Only = @()
)

. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $InstallDir) { $InstallDir = Get-DefaultInstallDir }
$run = Join-Path $InstallDir 'run'
if (-not (Test-Path $run)) { Say '没有由 start.ps1 启动的进程' 'Nothing to stop' 'info'; exit 0 }

foreach ($f in Get-ChildItem $run -Filter '*.pid') {
  $name = $f.BaseName
  if ($Only.Count -and $Only -notcontains $name) { continue }
  $id = [int]([IO.File]::ReadAllText($f.FullName).Trim())
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  # PID 被别的进程复用时（启动时间晚于 PID 文件）不动它 / skip a reused PID
  if ($proc -and $proc.StartTime -gt $f.LastWriteTime.AddSeconds(5)) { $proc = $null }
  if ($proc) {
    # /T 连同子进程（cmd → pnpm → node）一起停
    Invoke-Native { & taskkill.exe /PID $id /T /F 2>&1 | Out-Null }
    Say "$name：已停止 PID $id" "$name stopped" 'ok'
  } else {
    Say "$name：PID $id 已不在运行" "$name not running" 'info'
  }
  Remove-Item -Force $f.FullName
}
