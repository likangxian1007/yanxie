# PDF 保版式翻译服务（可选）

研协「翻译 PDF」功能的后端。它把整篇论文翻译成中文，保留原排版、公式和图表，输出两种 PDF：仅译文（mono）和双语对照（dual）。

## 许可证

本服务调用 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（`pdf2zh-next`）。它和它依赖的 BabelDOC 都是 **AGPL-3.0**。详见 [NOTICE](NOTICE)。

- 研协仓库（Apache-2.0）不包含、不链接、也不分发它们的代码。
- 研协服务端只通过 HTTP 调用这个独立进程。
- 如果你把这个服务开放给网络上的其他用户，需要遵守 AGPL-3.0，向这些用户提供对应的源代码。

## 安装与运行（uv）

```powershell
cd tools/pdf-translate
uv venv --python 3.12
uv pip install -r requirements.txt
# 只监听本机；端口默认 8090
$env:NO_PROXY = "127.0.0.1,localhost"
uv run python app.py
```

第一次翻译时，pdf2zh-next 会下载版面分析模型和字体（约 200 MB），之后就可以离线使用。

然后在研协服务端的 `.env` 里设置：

```
PDF_TRANSLATE_URL=http://127.0.0.1:8090
```

留空就关闭这个功能，界面上也不会显示「翻译 PDF」按钮。

## 环境变量

| 变量                         | 默认值       | 说明                           |
| ---------------------------- | ------------ | ------------------------------ |
| `PDF_TRANSLATE_HOST`         | `127.0.0.1`  | 监听地址；不要绑到公网         |
| `PDF_TRANSLATE_PORT`         | `8090`       | 端口                           |
| `PDF_TRANSLATE_WORK_DIR`     | 系统临时目录 | 存放任务文件                   |
| `PDF_TRANSLATE_KEEP_SECONDS` | `3600`       | 已完成任务的文件保留多久（秒） |

## API

- `POST /jobs`：用 multipart 上传 `file`（PDF）和 `opts`（JSON），返回 `{id, status, progress, ...}`。
  - `opts` 的格式：`{"pages":"1-4","mode":"both|mono|dual","engine":{"base_url","model","api_key","qps","no_think"}}`
- `GET /jobs/{id}`：返回 `{status: queued|running|done|failed, progress, stage, error, elapsed}`。
- `GET /jobs/{id}/mono`：下载仅译文 PDF。
- `GET /jobs/{id}/dual`：下载双语对照 PDF。
- `GET /health`：健康检查。

翻译引擎可以用任意 OpenAI 兼容接口：

- 本机 OVMS / Ollama：研协会自动设 `no_think`，关掉 Qwen3 的思考模式。
- 云端 DeepSeek。

研协服务端会决定用哪个引擎，并负责在本地失败时回退到云端。

---

## English

# Layout-preserving PDF translation service (optional)

Backend for Yanxie's "Translate PDF" feature. It translates a whole paper while keeping the original layout, formulas and figures, and produces two PDFs: translation only (mono) and bilingual side-by-side (dual).

### License

This service uses [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next) (`pdf2zh-next`). It and its dependency BabelDOC are **AGPL-3.0**. See [NOTICE](NOTICE).

- The Yanxie repository (Apache-2.0) does not contain, vendor or distribute their code; `pdf2zh-next` is installed as a dependency from PyPI (`requirements.txt`).
- The Yanxie server only calls this independent process over HTTP.
- If you expose this service to other users over a network, you must comply with AGPL-3.0 and offer them the corresponding source code.

### Install and run (uv)

```powershell
cd tools/pdf-translate
uv venv --python 3.12
uv pip install -r requirements.txt
$env:NO_PROXY = "127.0.0.1,localhost"
uv run python app.py   # listens on 127.0.0.1:8090 by default
```

On the first translation pdf2zh-next downloads layout models and fonts (~200 MB); after that it works offline. Then set `PDF_TRANSLATE_URL=http://127.0.0.1:8090` in the Yanxie server `.env`. Leave it empty to disable the feature (the "Translate PDF" button is hidden).

Environment variables: `PDF_TRANSLATE_HOST` (default `127.0.0.1`, do not bind to a public address), `PDF_TRANSLATE_PORT` (`8090`), `PDF_TRANSLATE_WORK_DIR` (system temp dir), `PDF_TRANSLATE_KEEP_SECONDS` (`3600`). The API is described above (`POST /jobs`, `GET /jobs/{id}`, `/mono`, `/dual`, `/health`). The translation engine can be any OpenAI-compatible endpoint (local OVMS / Ollama, or cloud DeepSeek); the Yanxie server picks the engine and falls back to the cloud if the local model fails.
