<#
.SYNOPSIS
  查看混合 AI 各部分是否在线。没开的部分 = 对应功能全部走云端（或不显示），不会报错。
  Report which hybrid parts are up. Anything missing simply means cloud-only.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  # 要读的 .env；默认 install.ps1 写过的第一个，或 apps/server/.env。Env file to read.
  [string]$EnvPath = '',
  [int]$OvmsPort = 0,
  [int]$PdfPort = 0
)

. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $InstallDir) { $InstallDir = Get-DefaultInstallDir }
$cfg = Read-HybridConfig -InstallDir $InstallDir
$repo = Get-ConfigValue $cfg 'repoRoot' (Get-RepoRoot)
if (-not $EnvPath) {
  $paths = @(Get-ConfigValue $cfg 'envPaths' @())
  $EnvPath = if ($paths.Count) { $paths[0] } else { (Get-DefaultEnvPaths -RepoRoot $repo)[0] }
}
$modelName = Get-ConfigValue $cfg 'modelName' $script:ModelName

$localUrl = Get-EnvValue -Path $EnvPath -Key 'LOCAL_LLM_BASE_URL'
$localModel = Get-EnvValue -Path $EnvPath -Key 'LOCAL_LLM_MODEL'
$pdfUrl = Get-EnvValue -Path $EnvPath -Key 'PDF_TRANSLATE_URL'
if ($OvmsPort) { $localUrl = "http://127.0.0.1:$OvmsPort/v3" }
if ($PdfPort) { $pdfUrl = "http://127.0.0.1:$PdfPort" }
if ($OvmsPort -and -not $localModel) { $localModel = $modelName }

Say '研协混合 AI 状态' 'Hybrid AI status' 'step'
Say ".env: $EnvPath$(if (-not (Test-Path $EnvPath)) { '（不存在 missing）' })"

$localOn = $false
if (-not $localUrl -or -not $localModel) {
  Say '本机模型：未配置（LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL 为空）→ 全部走云端' 'Local model: not configured -> cloud only' 'warn'
} else {
  $body = Invoke-LocalGet ($localUrl.TrimEnd('/') + '/models')
  if ($null -ne $body -and $body -match [regex]::Escape("`"$localModel`"")) {
    $localOn = $true
    Say "本机模型：在线 $localUrl（$localModel）" "Local model: up" 'ok'
  } elseif ($null -ne $body) {
    Say "本机模型：服务在线但还没加载 $localModel（可能在编译）→ 暂时走云端" 'Local server up, model not loaded yet' 'warn'
  } else {
    Say "本机模型：连不上 $localUrl → 自动走云端（start.ps1 可启动）" 'Local model unreachable -> cloud fallback' 'warn'
  }
}

$pdfOn = $false
if (-not $pdfUrl) {
  Say 'PDF 翻译服务：未配置（PDF_TRANSLATE_URL 为空）→ 界面不显示「翻译 PDF」' 'PDF service: not configured' 'warn'
} elseif (Test-PdfReady -Port ([uri]$pdfUrl).Port) {
  $pdfOn = $true
  Say "PDF 翻译服务：在线 $pdfUrl（翻译引擎：$(if ($localOn) { '本机模型优先' } else { '云端' })）" 'PDF service: up' 'ok'
} else {
  Say "PDF 翻译服务：连不上 $pdfUrl → 发起翻译会失败，请运行 start.ps1" 'PDF service unreachable' 'warn'
}

$health = Invoke-LocalGet 'http://127.0.0.1:8787/api/health'
if ($null -ne $health) { Say '研协 server：在线 :8787' 'server up' 'ok' } else { Say '研协 server：未运行 :8787' 'server not running' 'info' }

if ($localOn -and $pdfOn) { Say '结论：本机 + 云端混合模式' 'Summary: hybrid (local + cloud)' 'ok' }
elseif ($localOn) { Say '结论：本机模型在线；整篇 PDF 翻译未开启' 'Summary: local model on, PDF off' 'ok' }
else { Say '结论：本机模型不可用，所有 AI 调用走云端（功能不受影响，只是不省钱、不离线）' 'Summary: cloud only - everything still works' 'info' }
