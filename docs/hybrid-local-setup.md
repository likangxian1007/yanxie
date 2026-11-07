# 混合 AI 本机部分：一键安装与最低配置

研协的 AI 调用默认全部走云端（`.env` 里的 `LLM_API_KEY`）。在一台合适的 Windows 电脑上，可以再装两个**可选**的本机部分：

| 部分                                                    | 作用                                                                                                         | 不装会怎样                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 本机模型（OpenVINO Model Server + Qwen3-4B-int4）       | 摘要、翻译、改写等轻量任务在本机跑：不花 token、敏感内容不出电脑；`/hybrid` 页面显示本机/云端分流            | 全部走云端，功能不变       |
| 整篇 PDF 翻译服务（`tools/pdf-translate`，pdf2zh-next） | 文献页的「翻译 PDF」，保留版式输出中英对照 PDF（见 [tools/pdf-translate](../tools/pdf-translate/README.md)） | 界面不显示「翻译 PDF」按钮 |

两部分都是独立进程，研协通过 HTTP 访问；任何一部分没装、没启动或中途挂掉，研协都**自动改走云端，不报错**。

## 配置要求

| 项目       | 最低                                                                                                 | 推荐                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 系统       | 64 位 Windows 10/11（Linux 见下文）                                                                  | Windows 11                                               |
| CPU / 显卡 | 任意 x86-64 CPU（无 Intel 核显时用 CPU 推理，约 3–8 tokens/s，较慢）                                 | Intel Core Ultra（Arc 核显，Qwen3-4B 约 22–25 tokens/s） |
| 内存       | 8 GB（只装 PDF 服务可更低）                                                                          | 16 GB 及以上                                             |
| 磁盘       | 约 5 GB 可用（OVMS 0.5 GB + 模型 2.2 GB + PDF 服务 1.5 GB + 首次翻译下载的字体/版面模型 0.2 GB）     | 10 GB                                                    |
| 软件       | Python 3.12 或 [uv](https://docs.astral.sh/uv/)（仅 PDF 服务需要）；研协本身需要 Node ≥ 22.12 + pnpm | —                                                        |

- Intel Core Ultra 的核显在设备管理器里可能叫 `Intel(R) Arc(TM) Graphics`，也可能只叫 `Intel(R) Graphics`（新一代），脚本都能识别。
- 带 Iris Xe 核显的 11–14 代 Intel 也会用 GPU，速度介于 Arc 和 CPU 之间。
- AMD / NVIDIA 显卡不被 OpenVINO 使用，这类电脑会回落到 CPU。CPU 太慢时可以只装 PDF 服务（`-SkipLocalModel`），翻译走云端。
- NPU（Intel AI Boost）会被检测并显示，但默认不用：4B 模型在 NPU 上需要专门导出的版本。

## 安装（Windows）

在仓库根目录打开 PowerShell：

```powershell
# 1. 先看看会做什么（只检测，不下载不写文件）
powershell -ExecutionPolicy Bypass -File tools\hybrid-local\install.ps1 -DryRun

# 2. 安装（可重复运行，已完成的步骤会跳过）
powershell -ExecutionPolicy Bypass -File tools\hybrid-local\install.ps1

# 3. 启动 OVMS、PDF 服务、研协 server 和 web（已在运行的会跳过），完成后打开 http://localhost:5173
powershell -ExecutionPolicy Bypass -File tools\hybrid-local\start.ps1

# 随时查看状态 / 停止由 start.ps1 启动的进程
powershell -ExecutionPolicy Bypass -File tools\hybrid-local\check.ps1
powershell -ExecutionPolicy Bypass -File tools\hybrid-local\stop.ps1
```

`install.ps1` 依次做这些事：

1. **检测**：CPU 型号（是否 Core Ultra）、Intel 核显、NPU、内存、磁盘，选推理设备（有 Intel 核显用 `GPU`，否则 `CPU`）。不达最低配置时停止，`-Force` 可强制继续。
2. **OVMS**：从 GitHub 官方发布页下载 `ovms_windows_2026.4.1_python_off.zip`（约 115 MB），用官方 `.sha256` 校验后解压到安装目录。
3. **模型**：`ovms --pull` 拉取 `OpenVINO/Qwen3-4B-int4-ov`（约 2.2 GB），中断会自动续传，最多 3 次。
4. **PDF 服务**：建 Python 3.12 venv，按 `tools/pdf-translate/requirements.txt` 装 pdf2zh-next 2.9.0。
5. **研协依赖**：缺 `node_modules` 时运行 `pnpm install`（`-SkipApp` 跳过）。
6. **写 `.env`**：只追加/更新下面四个键，其他行（包括各种密钥）原样保留：

   ```dotenv
   LOCAL_LLM_BASE_URL=http://127.0.0.1:8000/v3
   LOCAL_LLM_MODEL=qwen3-4b
   LOCAL_LLM_DEVICE=Intel Arc GPU
   PDF_TRANSLATE_URL=http://127.0.0.1:8090
   ```

   默认写 `apps/server/.env`（`pnpm dev:server` 从这里读），根目录有 `.env`（docker compose 用）时也一并写。云端的 `LLM_API_KEY` 等仍需自己按 `.env.example` 填。

常用参数：

| 参数                                | 说明                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `-InstallDir <目录>`                | 安装目录，默认 `%LOCALAPPDATA%\srh-hybrid`（OVMS、模型、venv、日志都在这里） |
| `-EnvPath <文件>[,<文件>]`          | 指定要写的 `.env`                                                            |
| `-NoEnv`                            | 不写 `.env`                                                                  |
| `-Device GPU\|CPU\|NPU\|AUTO`       | 强制推理设备                                                                 |
| `-OvmsPort` / `-PdfPort`            | 端口，默认 8000 / 8090                                                       |
| `-SkipPdf` / `-SkipLocalModel`      | 只装其中一部分                                                               |
| `-Proxy http://127.0.0.1:7890`      | 下载用代理，默认沿用 `HTTPS_PROXY`                                           |
| `-HfEndpoint https://hf-mirror.com` | 模型下载用 Hugging Face 镜像                                                 |

日志在 `<安装目录>\logs\`，`start.ps1` 记录的进程号在 `<安装目录>\run\`。

## 安装（Linux，简化版）

```bash
tools/hybrid-local/install.sh --dry-run
tools/hybrid-local/install.sh            # 可加 --skip-pdf / --device CPU / --hf-endpoint https://hf-mirror.com
tools/hybrid-local/start.sh start        # 也支持 stop / check
```

支持 Ubuntu 22.04 / 24.04（及 Debian 12/13、RHEL 系），下载对应的官方 OVMS 包。Intel 核显需要先装 compute runtime（Ubuntu：`apt install intel-opencl-icd`）并把用户加入 `render` 组；其他发行版可用 Docker 镜像 `openvino/model_server`，脚本出错时会打印命令。

## 排错

- **开了系统代理后本机服务连不上 / PDF 翻译卡住**：代理软件会把 `127.0.0.1` 的请求也转出去。启动研协和 PDF 服务的终端里设置 `NO_PROXY=127.0.0.1,localhost`（`start.ps1` 已自动设置）。
- **PDF 服务启动报 `bitstring` 相关错误**：bitstring 4.4 与 pdf2zh-next 2.9.0 不兼容。`requirements.txt` 已固定 `bitstring>=4.2,<4.4`；如果手动装过，运行 `uv pip install --python <安装目录>\pdf-venv\Scripts\python.exe "bitstring<4.4"`。
- **端口被占用**：`start.ps1` 发现端口已在监听就跳过该部分（可能是之前启动的实例）。用 `Get-NetTCPConnection -LocalPort 8000 -State Listen` 查是谁占用；换端口用 `install.ps1 -OvmsPort 18000 -PdfPort 18090` 重跑一次（会同步改 `.env`）。研协 web 的开发代理固定指向 8787，server/web 的端口不在脚本里改。
- **模型拉取失败**：看 `<安装目录>\logs\ovms-pull.log`。国内网络加 `-HfEndpoint https://hf-mirror.com` 或 `-Proxy`，再运行一次会断点续传。
- **`ovms.exe` 无法运行**：安装 [VC++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)。
- **本机模型首次启动很慢**：第一次在 GPU 上编译模型需要 1–3 分钟，期间研协自动走云端；`check.ps1` 显示「在线」后就会分流到本机。

## 许可说明

整篇 PDF 翻译使用 [pdf2zh-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（AGPL-3.0）。它**不随研协分发、不并入研协代码**：安装脚本在用户自己的电脑上从 PyPI 单独安装，研协只通过 HTTP 调用这个独立进程（`tools/pdf-translate/app.py` 是一层薄包装）。OpenVINO Model Server 为 Apache-2.0；Qwen3-4B 模型为 Apache-2.0。

## English

研协 (SRH) sends every AI call to the cloud by default. Two **optional** local parts can be added on a capable Windows PC:

- **Local model**: OpenVINO Model Server + Qwen3-4B-int4. Light tasks such as summaries, translation and rewrites run locally, so they cost no tokens and stay on the machine.
- **Full-PDF translation service**: `tools/pdf-translate`, built on pdf2zh-next.

If either part is missing or down, SRH silently falls back to the cloud. Nothing errors.

**Requirements**

- Recommended: Intel Core Ultra with Arc iGPU, at about 22–25 tok/s.
- Other Intel or AMD CPUs fall back to CPU inference, which is slow (about 3–8 tok/s).
- RAM: 16 GB recommended, 8 GB minimum.
- About 5 GB of free disk.
- Python 3.12 or uv for the PDF service.

**Install (Windows)**

- Run `tools\hybrid-local\install.ps1`. Use `-DryRun` first to preview.
- What it does:
  - Detects the hardware.
  - Downloads and checksum-verifies the official OVMS 2026.4.1 zip.
  - Pulls the model.
  - Creates the pdf2zh-next venv.
  - Updates only `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_DEVICE` and `PDF_TRANSLATE_URL` in `apps/server/.env`, plus the root `.env` if it exists. Secrets are left untouched.
- Then:
  - `start.ps1` starts OVMS, the PDF service, the server and the web app. It skips anything already listening.
  - `check.ps1` reports status.
  - `stop.ps1` stops only what `start.ps1` started.
- The script is idempotent and safe to re-run.

**Linux**: `install.sh` / `start.sh` (start, stop, check) cover Ubuntu 22.04/24.04. For other distros, use Docker.

**Troubleshooting**

- Set `NO_PROXY=127.0.0.1,localhost` when a system proxy is on.
- bitstring must stay below 4.4; `requirements.txt` already pins it.
- On port conflicts, re-run the installer with `-OvmsPort` / `-PdfPort`.
- If the model pull fails, use `-HfEndpoint https://hf-mirror.com` and re-run; the download resumes.

**License**: pdf2zh-next is AGPL-3.0. It is installed separately from PyPI on the user's machine and called over HTTP. It is not vendored into or distributed with SRH.
