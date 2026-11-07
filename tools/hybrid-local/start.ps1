<#
.SYNOPSIS
  启动研协混合 AI 栈：本机模型（OVMS）、PDF 翻译服务、研协 server、web。已在运行的部分跳过。
  Start the hybrid stack (OVMS, pdf-translate, server, web); anything already running is left alone.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\hybrid-local\start.ps1
.EXAMPLE
  # 只起本机模型和 PDF 服务（研协已经另外启动）
  powershell -ExecutionPolicy Bypass -File tools\hybrid-local\start.ps1 -SkipApp
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$RepoRoot = '',
  # 覆盖 install.ps1 记下的端口。Override the ports recorded by install.ps1.
  [int]$OvmsPort = 0,
  [int]$PdfPort = 0,
  # 覆盖推理设备 GPU / CPU / NPU / AUTO。Override target device.
  [ValidateSet('', 'GPU', 'CPU', 'NPU', 'AUTO')][string]$Device = '',
  # 不启动研协 server / web。Do not start the app itself.
  [switch]$SkipApp,
  # 启动后不等待就绪。Do not wait for readiness.
  [switch]$NoWait,
  # 只打印会做什么。Print what would be started.
  [switch]$DryRun
)

. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $InstallDir) { $InstallDir = Get-DefaultInstallDir }
$cfg = Read-HybridConfig -InstallDir $InstallDir
if (-not $RepoRoot) { $RepoRoot = Get-ConfigValue $cfg 'repoRoot' (Get-RepoRoot) }
if (-not $OvmsPort) { $OvmsPort = [int](Get-ConfigValue $cfg 'ovmsPort' 8000) }
if (-not $PdfPort) { $PdfPort = [int](Get-ConfigValue $cfg 'pdfPort' 8090) }
if (-not $Device) { $Device = Get-ConfigValue $cfg 'device' 'CPU' }
$modelName = Get-ConfigValue $cfg 'modelName' $script:ModelName
$modelSource = Get-ConfigValue $cfg 'modelSource' $script:ModelSource
$serverPort = 8787 # apps/web/vite.config.ts 的代理写死 8787 / the web dev proxy targets 8787
$webPort = 5173

$logs = Join-Path $InstallDir 'logs'
$run = Join-Path $InstallDir 'run'
if (-not $DryRun) { New-Item -ItemType Directory -Force $logs, $run | Out-Null }
# 本机服务之间互相调用 127.0.0.1，不能走代理。Loopback calls must bypass any proxy.
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = '127.0.0.1,localhost'

if ($null -eq $cfg) { Say "没找到 $InstallDir\config.json：还没运行 install.ps1，本机模型和 PDF 服务会跳过（全部走云端）" 'Not installed; local parts skipped' 'warn' }

function Start-Part {
  param([string]$Name, [int]$Port, [string]$File, [string]$Arguments, [string]$WorkDir, [hashtable]$Env = @{})
  if (Test-PortListening $Port) { Say "$Name：端口 $Port 已在监听，跳过" "$Name already running on :$Port" 'ok'; return $false }
  if ($DryRun) { Say "$Name：将启动 $File $Arguments（工作目录 $WorkDir）" "would start $Name" ; return $false }
  $saved = @{}
  foreach ($k in $Env.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $Env[$k], 'Process') }
  try {
    $p = Start-Process -PassThru -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logs "$Name.out.log") -RedirectStandardError (Join-Path $logs "$Name.err.log")
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  [IO.File]::WriteAllText((Join-Path $run "$Name.pid"), [string]$p.Id)
  Say "$Name：已启动 PID $($p.Id)，日志 $logs\$Name.*.log" "$Name started" 'ok'
  return $true
}

Say '启动研协混合 AI 栈' 'Starting hybrid stack' 'step'

# 1. 本机模型 / local model
$ovmsDir = $InstallDir
$ovmsExe = Join-Path $ovmsDir 'ovms\ovms.exe'
$ovmsStarted = $false
if ((Get-ConfigValue $cfg 'localModel' $false) -and (Test-Path $ovmsExe)) {
  $ovmsStarted = Start-Part -Name 'ovms' -Port $OvmsPort -File $ovmsExe -WorkDir $ovmsDir `
    -Arguments "--rest_port $OvmsPort --model_repository_path models --source_model $modelSource --model_name $modelName --task text_generation --target_device $Device"
} else {
  Say '本机模型未安装，跳过（AI 调用全部走云端）' 'Local model not installed; cloud only' 'warn'
}

# 2. PDF 翻译服务 / pdf-translate
$venvPy = Join-Path $InstallDir 'pdf-venv\Scripts\python.exe'
$pdfStarted = $false
if ((Get-ConfigValue $cfg 'pdf' $false) -and (Test-Path $venvPy)) {
  $pdfStarted = Start-Part -Name 'pdf-translate' -Port $PdfPort -File $venvPy -Arguments 'app.py' -WorkDir (Join-Path $RepoRoot 'tools\pdf-translate') `
    -Env @{ PDF_TRANSLATE_PORT = [string]$PdfPort; PDF_TRANSLATE_HOST = '127.0.0.1'; PYTHONIOENCODING = 'utf-8' }
} else {
  Say 'PDF 翻译服务未安装，跳过（界面不显示「翻译 PDF」）' 'pdf-translate not installed; skipped' 'warn'
}

# 3. 研协 server + web
$appStarted = $false
if (-not $SkipApp) {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Say '找不到 pnpm，跳过研协 server/web（装 Node 22 后运行 corepack enable）' 'pnpm not found; app skipped' 'warn'
  } else {
    $a = Start-Part -Name 'server' -Port $serverPort -File 'cmd.exe' -Arguments '/c pnpm dev:server' -WorkDir $RepoRoot
    $b = Start-Part -Name 'web' -Port $webPort -File 'cmd.exe' -Arguments '/c pnpm dev:web' -WorkDir $RepoRoot
    $appStarted = $a -or $b
  }
}

if ($DryRun -or $NoWait) { Say '没有等待就绪；用 check.ps1 查看状态' 'Not waiting; run check.ps1' ; exit 0 }

if ($ovmsStarted) {
  Say "等待本机模型加载（首次在 $Device 上编译可能要 1–3 分钟）" 'Waiting for the local model' 'step'
  if (Wait-Until { Test-OvmsReady -Port $OvmsPort -Model $modelName } 300 'OVMS') { Say '本机模型就绪' 'local model ready' 'ok' }
  else { Say "本机模型没起来，看 $logs\ovms.err.log；研协会自动改走云端" 'see ovms.err.log; cloud fallback stays active' 'warn' }
}
if ($pdfStarted) {
  if (Wait-Until { Test-PdfReady -Port $PdfPort } 90 'pdf-translate') { Say 'PDF 翻译服务就绪' 'pdf-translate ready' 'ok' }
  else { Say "PDF 翻译服务没起来，看 $logs\pdf-translate.err.log" 'see pdf-translate.err.log' 'warn' }
}
if ($appStarted) {
  if (Wait-Until { $null -ne (Invoke-LocalGet "http://127.0.0.1:$serverPort/api/health") } 180 'server') { Say '研协 server 就绪' 'server ready' 'ok' }
}

& (Join-Path $PSScriptRoot 'check.ps1') -InstallDir $InstallDir -OvmsPort $OvmsPort -PdfPort $PdfPort
if (-not $SkipApp) { Say "打开 http://localhost:$webPort" "Open http://localhost:$webPort" 'step' }
