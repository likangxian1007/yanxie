<#
.SYNOPSIS
  研协混合 AI 本机部分一键安装（Windows）。One-click installer for the local half of 研协 hybrid AI.

.DESCRIPTION
  1. 检测 CPU / 核显 / NPU / 内存 / 磁盘；
  2. 下载官方 OpenVINO Model Server（OVMS）Windows 版并拉取 Qwen3-4B-int4 模型；
  3. 为整篇 PDF 翻译服务（pdf2zh-next，AGPL-3.0，独立进程）建 Python venv（-SkipPdf 跳过）；
  4. 只在 .env 里写入/更新 LOCAL_LLM_BASE_URL、LOCAL_LLM_MODEL、LOCAL_LLM_DEVICE、PDF_TRANSLATE_URL，其余行不动。
  可重复运行：已完成的步骤会跳过。没装本机部分时研协全部走云端，不报错。
  Idempotent. Without the local parts every AI call simply goes to the cloud.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\hybrid-local\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\hybrid-local\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  # 安装目录（OVMS、模型、PDF 服务的 venv、日志）。Install dir for OVMS, model, venv, logs.
  [string]$InstallDir = '',
  # 要写的 .env，可多个；默认 apps/server/.env 和（存在时）根目录 .env。Env files to update.
  [string[]]$EnvPath = @(),
  # 研协仓库根目录，默认本脚本所在仓库。Repo root.
  [string]$RepoRoot = '',
  # 强制推理设备：GPU / CPU / NPU / AUTO。默认自动选。Force target device.
  [ValidateSet('', 'GPU', 'CPU', 'NPU', 'AUTO')][string]$Device = '',
  [int]$OvmsPort = 8000,
  [int]$PdfPort = 8090,
  # 下载用的代理，默认取 HTTPS_PROXY。Proxy for downloads.
  [string]$Proxy = '',
  # Hugging Face 镜像，例如 https://hf-mirror.com。HF mirror for the model pull.
  [string]$HfEndpoint = '',
  # 不装 PDF 翻译服务。Skip the pdf2zh-next service.
  [switch]$SkipPdf,
  # 不装本机模型（只装 PDF 服务，翻译走云端）。Skip OVMS + model.
  [switch]$SkipLocalModel,
  # 不检查 / 不安装研协本身的 node 依赖。Skip pnpm install for the app.
  [switch]$SkipApp,
  # 不写 .env。Do not touch any .env.
  [switch]$NoEnv,
  # 只检测和打印计划，不下载、不写文件。Detect and print the plan only.
  [switch]$DryRun,
  # 配置不达标也继续。Continue even if below minimum requirements.
  [switch]$Force
)

. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $InstallDir) { $InstallDir = Get-DefaultInstallDir }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
if (-not $Proxy) { if ($env:HTTPS_PROXY) { $Proxy = $env:HTTPS_PROXY } elseif ($env:HTTP_PROXY) { $Proxy = $env:HTTP_PROXY } }
# powershell -File 传数组时会变成一个逗号分隔的字符串 / -File passes arrays as one comma-joined string
$EnvPath = @($EnvPath | ForEach-Object { $_ -split '[;,]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($EnvPath.Count -eq 0) { $EnvPath = Get-DefaultEnvPaths -RepoRoot $RepoRoot }

Say '研协混合 AI：本机部分安装' 'SRH hybrid AI: local setup' 'step'
Say "安装目录 $InstallDir" "install dir"
Say "仓库 $RepoRoot" "repo"

# ---------- 1. 检测 / Detect ----------
Say '检测硬件' 'Detecting hardware' 'step'
$hw = Get-HardwareInfo -InstallDir $InstallDir
Say "CPU: $($hw.Cpu)$(if ($hw.IsCoreUltra) { '（Intel Core Ultra）' })"
Say "显卡 GPU: $([string]::Join('; ', $hw.Gpus))"
Say "Intel 核显 iGPU: $(if ($hw.ArcGpu) { $hw.ArcGpu } elseif ($hw.IrisGpu) { $hw.IrisGpu } else { '无 none' })"
Say "NPU: $(if ($hw.Npu) { $hw.Npu } else { '无 none' })"
Say "内存 RAM: $($hw.RamGB) GB；磁盘 $($hw.Drive): 可用 $($hw.FreeGB) GB"

$pick = Select-Device -Hw $hw
if ($Device) { $pick = @{ Device = $Device; Label = "Intel $Device" }; if ($Device -eq 'CPU') { $pick.Label = 'CPU' } }
Say "推理设备 target device: $($pick.Device)（$($pick.Label)）" '' 'ok'

$blocking = @()
if (-not $hw.Is64Bit) { $blocking += '需要 64 位 Windows | 64-bit Windows required' }
if (-not $SkipLocalModel) {
  if ($hw.RamGB -lt 8) { $blocking += "内存 $($hw.RamGB) GB < 8 GB，本机模型跑不动；可加 -SkipLocalModel 只用云端 | RAM < 8 GB" }
  elseif ($hw.RamGB -lt 16) { Say "内存 $($hw.RamGB) GB 低于推荐的 16 GB，本机模型会和浏览器抢内存" 'RAM below the recommended 16 GB' 'warn' }
  if ($pick.Device -eq 'CPU' -and -not $Device) { Say '没有可用的 Intel 核显，本机模型用 CPU 跑，会比较慢（约 3–8 tokens/s）；不想用可加 -SkipLocalModel' 'No Intel iGPU: CPU inference is slow' 'warn' }
  if (-not $hw.IsIntel) { Say '非 Intel CPU：OpenVINO 可以在 CPU 上运行，但未针对优化' 'Non-Intel CPU: works on CPU but not optimised' 'warn' }
}
$needGB = 1
if (-not $SkipLocalModel) { $needGB += 3.5 }
if (-not $SkipPdf) { $needGB += 1.5 }
if ($hw.FreeGB -lt $needGB) { $blocking += "磁盘可用 $($hw.FreeGB) GB < 需要的约 $needGB GB | not enough disk space" }
if ($blocking.Count) {
  foreach ($b in $blocking) { Say $b '' 'err' }
  if (-not $Force -and -not $DryRun) { Say '配置不达标，已停止。加 -Force 强制继续。研协不装本机部分也能用（全部走云端）。' 'Below minimum; re-run with -Force to continue.' 'err'; exit 2 }
}

$ovmsExe = Join-Path $InstallDir 'ovms\ovms.exe'
$modelDir = Join-Path $InstallDir ('models\' + ($script:ModelSource -replace '/', '\'))
$venv = Join-Path $InstallDir 'pdf-venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$pdfDir = Join-Path $RepoRoot 'tools\pdf-translate'

$envValues = New-Object System.Collections.Specialized.OrderedDictionary
if (-not $SkipLocalModel) {
  $envValues['LOCAL_LLM_BASE_URL'] = "http://127.0.0.1:$OvmsPort/v3"
  $envValues['LOCAL_LLM_MODEL'] = $script:ModelName
  $envValues['LOCAL_LLM_DEVICE'] = $pick.Label
}
if (-not $SkipPdf) { $envValues['PDF_TRANSLATE_URL'] = "http://127.0.0.1:$PdfPort" }

if ($DryRun) {
  Say '计划（-DryRun，不做任何改动）' 'Plan (dry run, nothing changed)' 'step'
  if (-not $SkipLocalModel) {
    Say "OVMS $($script:OvmsVersion): $(if (Test-Path $ovmsExe) { '已安装，跳过' } else { "下载 $($script:OvmsZipUrl)" })"
    Say "模型 $($script:ModelSource): $(if (Test-ModelComplete $modelDir) { '已存在，跳过' } else { '拉取约 2.2 GB' })"
  }
  if (-not $SkipPdf) { Say "PDF 服务 venv: $(if (Test-Path $venvPy) { '已存在，检查依赖' } else { "新建 $venv" })" }
  if (-not $NoEnv) {
    foreach ($p in $EnvPath) {
      $c = Set-EnvKeys -Path $p -Values $envValues -DryRun
      Say "$p 将更新 would update: $(if ($c.Count) { [string]::Join(', ', $c) } else { '无（已是最新）' })"
    }
  }
  exit 0
}

New-Item -ItemType Directory -Force $InstallDir, (Join-Path $InstallDir 'logs') | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-File {
  param([string]$Url, [string]$OutFile)
  $part = "$OutFile.part"
  $iwr = @{ Uri = $Url; OutFile = $part; UseBasicParsing = $true }
  if ($Proxy) { $iwr.Proxy = $Proxy }
  Invoke-WebRequest @iwr
  Move-Item -Force $part $OutFile
}

# 子进程（ovms --pull、uv/pip）用的代理与镜像环境变量
if ($Proxy) { $env:HTTPS_PROXY = $Proxy; $env:HTTP_PROXY = $Proxy }
if ($HfEndpoint) { $env:HF_ENDPOINT = $HfEndpoint }
$env:NO_PROXY = '127.0.0.1,localhost'

# ---------- 2. OVMS + 模型 / OVMS + model ----------
if (-not $SkipLocalModel) {
  Say "安装 OpenVINO Model Server $($script:OvmsVersion)" 'Installing OVMS' 'step'
  if (Test-Path $ovmsExe) {
    Say '已安装，跳过下载' 'already installed' 'ok'
  } else {
    $zip = Join-Path $InstallDir "ovms_windows_$($script:OvmsVersion).zip"
    if (-not (Test-Path $zip)) {
      Say "下载 $($script:OvmsZipUrl)（约 115 MB）" 'downloading'
      Get-File -Url $script:OvmsZipUrl -OutFile $zip
    }
    try {
      $shaFile = "$zip.sha256"
      Get-File -Url "$($script:OvmsZipUrl).sha256" -OutFile $shaFile
      $expected = ([IO.File]::ReadAllText($shaFile).Trim() -split '\s+')[0].ToLower()
      $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
      if ($expected -ne $actual) { Remove-Item -Force $zip; throw "SHA256 不匹配（已删除下载文件，请重试） | checksum mismatch" }
      Say 'SHA256 校验通过' 'checksum ok' 'ok'
    } catch {
      if ($_.Exception.Message -match 'SHA256') { throw }
      Say "取不到官方校验值，跳过校验：$($_.Exception.Message)" 'could not fetch checksum' 'warn'
    }
    Say '解压' 'extracting'
    Expand-Archive -Force -Path $zip -DestinationPath $InstallDir
    if (-not (Test-Path $ovmsExe)) { throw "解压后没找到 $ovmsExe | ovms.exe not found after extraction" }
    Remove-Item -Force $zip
  }
  $verOut = @(Invoke-Native { & $ovmsExe --version 2>&1 })
  $ver = if ($verOut.Count) { $verOut[0].ToString() } else { '' }
  if ($LASTEXITCODE -ne 0 -or -not $ver) {
    Say 'ovms.exe 无法运行。通常是缺少 VC++ 运行库：https://aka.ms/vs/17/release/vc_redist.x64.exe' 'ovms.exe failed to run; install the VC++ redistributable' 'err'
    exit 3
  }
  Say "OVMS: $ver" '' 'ok'

  Say "拉取模型 $($script:ModelSource)（约 2.2 GB，国内可加 -HfEndpoint https://hf-mirror.com）" 'Pulling model' 'step'
  if (Test-ModelComplete $modelDir) {
    Say '模型已存在，跳过' 'model present' 'ok'
  } else {
    $pullLog = Join-Path $InstallDir 'logs\ovms-pull.log'
    Say "日志 log: $pullLog"
    Push-Location $InstallDir
    try {
      # 大文件走 LFS，网络抖动会中断；OVMS 支持断点续传，所以失败后原命令重跑最多 3 次。
      # LFS downloads can drop; OVMS resumes on re-run, so retry up to 3 times.
      for ($try = 1; $try -le 3 -and -not (Test-ModelComplete $modelDir); $try++) {
        if ($try -gt 1) { Say "下载中断，第 $try 次续传" "download interrupted, resume attempt $try" 'warn' }
        Invoke-Native { & $ovmsExe --pull --source_model $script:ModelSource --model_repository_path models --model_name $script:ModelName --task text_generation --target_device $pick.Device *>&1 | ForEach-Object { $_.ToString() } | Add-Content -Encoding UTF8 $pullLog }
      }
    } finally { Pop-Location }
    if (-not (Test-ModelComplete $modelDir)) {
      Get-Content $pullLog -Tail 40 | Where-Object { $_ -match 'error' } | Select-Object -Last 2 | ForEach-Object { Say $_ '' 'err' }
      Say '模型拉取失败。检查网络/代理（-Proxy），或用镜像 -HfEndpoint https://hf-mirror.com 再运行一次。' 'Model pull failed; check proxy or use -HfEndpoint' 'err'
      exit 4
    }
    Say '模型就绪' 'model ready' 'ok'
  }
}

# ---------- 3. PDF 翻译服务 / pdf2zh-next venv ----------
if (-not $SkipPdf) {
  Say '安装整篇 PDF 翻译服务（pdf2zh-next，AGPL-3.0，独立进程，不并入研协代码）' 'Installing pdf-translate (AGPL, separate process)' 'step'
  if (-not (Test-Path (Join-Path $pdfDir 'requirements.txt'))) { throw "找不到 $pdfDir\requirements.txt | tools/pdf-translate missing (main older than PR #84?)" }
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if (-not (Test-Path $venvPy)) {
    if ($uv) {
      Invoke-Native { & $uv.Source venv --python 3.12 $venv 2>&1 | Select-Object -Last 1 | ForEach-Object { Say $_.ToString() } }
    } else {
      $py = Get-Command py -ErrorAction SilentlyContinue
      Invoke-Native { if ($py) { & $py.Source -3.12 -m venv $venv } else { & python -m venv $venv } }
    }
    if (-not (Test-Path $venvPy)) { Say '建 venv 失败：请安装 Python 3.12 或 uv（https://docs.astral.sh/uv/）' 'venv creation failed: install Python 3.12 or uv' 'err'; exit 5 }
  }
  Invoke-Native { & $venvPy -c 'import pdf2zh_next, bitstring, fastapi' 2>$null }
  if ($LASTEXITCODE -eq 0) {
    Say '依赖已装，跳过' 'deps present' 'ok'
  } else {
    Say '安装依赖（pdf2zh-next 2.9.0，bitstring<4.4 已在 requirements.txt 里固定）' 'pip install'
    if ($uv) {
      Invoke-Native { & $uv.Source pip install --python $venvPy -r (Join-Path $pdfDir 'requirements.txt') 2>&1 | Select-Object -Last 2 | ForEach-Object { Say $_.ToString() } }
    } else {
      Invoke-Native { & $venvPy -m pip install -q -r (Join-Path $pdfDir 'requirements.txt') 2>&1 | Select-Object -Last 2 | ForEach-Object { Say $_.ToString() } }
    }
    Invoke-Native { & $venvPy -c 'import pdf2zh_next, bitstring, fastapi' 2>$null }
    if ($LASTEXITCODE -ne 0) { Say '依赖安装失败，见上面的输出；常见原因是代理（-Proxy）' 'pip install failed' 'err'; exit 5 }
    Say '依赖就绪' 'deps ready' 'ok'
  }
}

# ---------- 4. 研协本身 / the app ----------
if (-not $SkipApp) {
  Say '检查研协运行环境（Node ≥ 22.12、pnpm）' 'Checking Node / pnpm' 'step'
  $node = Get-Command node -ErrorAction SilentlyContinue
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $node -or -not $pnpm) {
    Say '缺 Node 或 pnpm：装 Node 22 LTS 后运行 corepack enable。start.ps1 将只启动模型和 PDF 服务。' 'Node/pnpm missing' 'warn'
  } elseif (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Say '运行 pnpm install' 'running pnpm install'
    Push-Location $RepoRoot
    try { & cmd /c 'pnpm install 2>&1' | Select-Object -Last 2 | ForEach-Object { Say $_.ToString() } } finally { Pop-Location }
  } else {
    Say "Node $(& node --version)，依赖已装" 'deps present' 'ok'
  }
}

# ---------- 5. .env + 配置 / env + config ----------
if (-not $NoEnv -and $envValues.Count) {
  Say '写入 .env（只改本机相关的键，不碰密钥）' 'Updating .env (local keys only)' 'step'
  foreach ($p in $EnvPath) {
    $c = Set-EnvKeys -Path $p -Values $envValues
    Say "$p：$(if ($c.Count) { '已更新 ' + [string]::Join(', ', $c) } else { '已是最新' })" '' 'ok'
  }
}

Save-HybridConfig -InstallDir $InstallDir -Config @{
  repoRoot    = $RepoRoot
  device      = $pick.Device
  deviceLabel = $pick.Label
  modelSource = $script:ModelSource
  modelName   = $script:ModelName
  ovmsVersion = $script:OvmsVersion
  ovmsPort    = $OvmsPort
  pdfPort     = $PdfPort
  localModel  = (-not $SkipLocalModel)
  pdf         = (-not $SkipPdf)
  envPaths    = $EnvPath
}

Say '安装完成' 'Done' 'step'
$startCmd = 'powershell -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start.ps1') + '"'
if ($InstallDir -ne (Get-DefaultInstallDir)) { $startCmd += ' -InstallDir "' + $InstallDir + '"' }
Say "启动：$startCmd" 'Start with start.ps1' 'ok'
Say '没启动的部分会自动走云端（需要 .env 里的 LLM_API_KEY），不会报错。' 'Anything not running falls back to the cloud.'
