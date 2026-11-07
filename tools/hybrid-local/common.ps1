# 研协 hybrid-local 公共函数，被 install.ps1 / start.ps1 / stop.ps1 / check.ps1 引用。
# Shared helpers for the hybrid-local scripts. Windows PowerShell 5.1+ compatible.
# 说明见 docs/hybrid-local-setup.md。

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---- 固定参数 / Pinned versions ----
$script:OvmsVersion = '2026.4.1'
$script:OvmsZipUrl = "https://github.com/openvinotoolkit/model_server/releases/download/v$($script:OvmsVersion)/ovms_windows_$($script:OvmsVersion)_python_off.zip"
$script:ModelSource = 'OpenVINO/Qwen3-4B-int4-ov'
$script:ModelName = 'qwen3-4b'
$script:EnvHeader = '# ---- 混合 AI：本机部分（tools/hybrid-local/install.ps1 写入，可手动改）----'

function Get-DefaultInstallDir { Join-Path $env:LOCALAPPDATA 'srh-hybrid' }
function Get-RepoRoot { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }

function Say {
  param([string]$Zh, [string]$En = '', [ValidateSet('info', 'ok', 'warn', 'err', 'step')][string]$Level = 'info')
  $tag = @{ info = '[i]'; ok = '[OK]'; warn = '[!]'; err = '[X]'; step = '==>' }[$Level]
  $color = @{ info = 'Gray'; ok = 'Green'; warn = 'Yellow'; err = 'Red'; step = 'Cyan' }[$Level]
  $msg = if ($En) { "$tag $Zh | $En" } else { "$tag $Zh" }
  Write-Host $msg -ForegroundColor $color
}

# 本机 HTTP GET，绕过系统代理（代理会把 127.0.0.1 也转发出去）。失败返回 $null。
# Local GET that bypasses any system proxy. Returns body text or $null.
function Invoke-LocalGet {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = $TimeoutSec * 1000
    $resp = $req.GetResponse()
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      return $sr.ReadToEnd()
    } finally { $resp.Close() }
  } catch { return $null }
}

# 运行原生程序：PowerShell 5 在 ErrorActionPreference=Stop 时会把 stderr 输出当成异常，这里临时放开。
# Run a native command without PowerShell 5 turning its stderr into terminating errors.
function Invoke-Native {
  param([scriptblock]$Block)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $old }
}

function Test-PortListening {
  param([int]$Port)
  try {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return [bool](netstat -ano | Select-String -Pattern ":$Port\s+\S+\s+LISTENING")
  }
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Seconds 2
  }
  Say "等待 $What 超时（${TimeoutSec}s）" "Timed out waiting for $What" 'warn'
  return $false
}

# 模型是否下完整：LFS 下载失败时 openvino_model.bin 只是 ~135 字节的指针文件，旁边留着 *lfs_part。
# A failed LFS pull leaves a tiny pointer file plus *lfs_part leftovers.
function Test-ModelComplete {
  param([string]$ModelDir)
  $bin = Join-Path $ModelDir 'openvino_model.bin'
  if (-not (Test-Path $bin)) { return $false }
  if ((Get-Item $bin).Length -lt 100MB) { return $false }
  return -not (Get-ChildItem $ModelDir -Filter '*lfs_part' -ErrorAction SilentlyContinue)
}

function Test-OvmsReady {
  param([int]$Port, [string]$Model = $script:ModelName)
  $body = Invoke-LocalGet "http://127.0.0.1:$Port/v3/models"
  return ($null -ne $body -and $body -match [regex]::Escape("`"$Model`""))
}

function Test-PdfReady {
  param([int]$Port)
  $body = Invoke-LocalGet "http://127.0.0.1:$Port/health"
  return ($null -ne $body -and $body -match '"ok"\s*:\s*true')
}

# ---- 配置文件 / Install config (InstallDir\config.json) ----
function Read-HybridConfig {
  param([string]$InstallDir)
  $path = Join-Path $InstallDir 'config.json'
  if (-not (Test-Path $path)) { return $null }
  return ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}

function Save-HybridConfig {
  param([string]$InstallDir, [hashtable]$Config)
  $path = Join-Path $InstallDir 'config.json'
  [IO.File]::WriteAllText($path, ($Config | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
}

function Get-ConfigValue {
  param($Config, [string]$Name, $Default)
  if ($null -ne $Config -and ($Config.PSObject.Properties.Name -contains $Name) -and $null -ne $Config.$Name) { return $Config.$Name }
  return $Default
}

# ---- .env 读写：只改指定的键，其他行（包括密钥）原样保留 ----
# .env editing: update/append only the given keys; every other line (incl. secrets) is kept verbatim.
function Get-EnvValue {
  param([string]$Path, [string]$Key)
  if (-not (Test-Path $Path)) { return $null }
  $value = $null
  foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
    if ($line -match "^\s*(export\s+)?$([regex]::Escape($Key))\s*=(.*)$") { $value = $Matches[2].Trim().Trim('"').Trim("'") }
  }
  return $value
}

function Set-EnvKeys {
  param([string]$Path, [System.Collections.Specialized.OrderedDictionary]$Values, [switch]$DryRun)
  $text = ''
  if (Test-Path $Path) { $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
  $nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
  $lines = New-Object System.Collections.Generic.List[string]
  if ($text.Length -gt 0) { foreach ($l in ($text.TrimEnd("`r", "`n") -split "`r?`n")) { $lines.Add($l) } }
  $changed = @()
  $headerAdded = $lines.Contains($script:EnvHeader)
  foreach ($key in $Values.Keys) {
    $new = "$key=$($Values[$key])"
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      # dotenv 里同名键以最后一个为准，所以每一处都改。
      if ($lines[$i] -match "^\s*(export\s+)?$([regex]::Escape($key))\s*=") {
        $found = $true
        if ($lines[$i] -ne $new) { $lines[$i] = $new; if ($changed -notcontains $key) { $changed += $key } }
      }
    }
    if (-not $found) {
      if (-not $headerAdded) { $lines.Add(''); $lines.Add($script:EnvHeader); $headerAdded = $true }
      $lines.Add($new)
      $changed += $key
    }
  }
  if ($changed.Count -gt 0 -and -not $DryRun) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    [IO.File]::WriteAllText($Path, ([string]::Join($nl, $lines) + $nl), (New-Object Text.UTF8Encoding $false))
  }
  return , $changed
}

# 默认要写的 .env：pnpm dev:server 读 apps/server/.env（dotenv 按工作目录），docker compose 读根目录 .env。
# Default env targets: apps/server/.env (read by `pnpm dev:server`) and the root .env if present (docker compose).
function Get-DefaultEnvPaths {
  param([string]$RepoRoot)
  $server = Join-Path $RepoRoot 'apps\server\.env'
  $root = Join-Path $RepoRoot '.env'
  $paths = @($server)
  if (Test-Path $root) { $paths += $root }
  return $paths
}

# ---- 硬件检测 / Hardware detection ----
function Get-HardwareInfo {
  param([string]$InstallDir)
  $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
  $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name } | Where-Object { $_ })
  $intelGpus = @($gpus | Where-Object { $_ -match 'Intel' })
  $npu = @()
  try {
    $npu = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match 'Intel\(R\) (AI Boost|NPU)' } | ForEach-Object { $_.FriendlyName })
  } catch { $npu = @() }
  $ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  $probe = $InstallDir
  while ($probe -and -not (Test-Path $probe)) { $probe = Split-Path -Parent $probe }
  if (-not $probe) { $probe = $env:SystemDrive + '\' }
  $drive = (Get-Item $probe).PSDrive
  $freeGB = [math]::Round($drive.Free / 1GB, 1)
  $isIntel = $cpu -match 'Intel'
  $isCoreUltra = $cpu -match 'Core\(TM\) Ultra|Core Ultra'
  # Core Ultra 的核显叫 "Intel(R) Arc(TM) Graphics"（Meteor/Arrow Lake）、"Arc 140V"（Lunar Lake）或 "Intel(R) Graphics"（Panther Lake）。
  $arc = @($intelGpus | Where-Object { $_ -match 'Arc' -or ($isCoreUltra -and $_ -match 'Intel\(R\) Graphics') })
  $iris = @($intelGpus | Where-Object { $_ -match 'Iris' })
  return [pscustomobject]@{
    Cpu         = $cpu
    IsIntel     = $isIntel
    IsCoreUltra = $isCoreUltra
    Gpus        = $gpus
    ArcGpu      = if ($arc.Count) { $arc[0] } else { $null }
    IrisGpu     = if ($iris.Count) { $iris[0] } else { $null }
    Npu         = if ($npu.Count) { $npu[0] } else { $null }
    RamGB       = $ramGB
    Drive       = $drive.Name
    FreeGB      = $freeGB
    Is64Bit     = [Environment]::Is64BitOperatingSystem
  }
}

# 设备选择：有 Arc 核显（或 Iris Xe）用 GPU，否则 CPU。NPU 只报告不默认使用（4B 模型在 NPU 上需要专门导出）。
function Select-Device {
  param($Hw)
  if ($Hw.ArcGpu) { return @{ Device = 'GPU'; Label = 'Intel Arc GPU' } }
  if ($Hw.IrisGpu) { return @{ Device = 'GPU'; Label = 'Intel Iris Xe GPU' } }
  return @{ Device = 'CPU'; Label = 'CPU' }
}
