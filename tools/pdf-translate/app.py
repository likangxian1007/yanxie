"""研协 PDF 保版式翻译服务：在 pdf2zh-next（AGPL-3.0）外面包一层小 HTTP API。

独立进程运行，研协服务端（Apache-2.0）只通过 HTTP 调它，不链接、不分发 pdf2zh-next 的代码。

    POST /jobs              multipart: file=PDF, opts=JSON → {id}
    GET  /jobs/{id}         {id, status, progress, stage, error, mono, dual}
    GET  /jobs/{id}/mono    译文 PDF
    GET  /jobs/{id}/dual    双语对照 PDF
    GET  /health            {ok, version}

opts: {"pages": "1-4", "mode": "both|mono|dual", "lang_in": "en", "lang_out": "zh",
       "engine": {"base_url": "...", "model": "...", "api_key": "...", "qps": 4,
                  "no_think": true}}
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

VERSION = "0.1.0"
WORK_DIR = Path(os.environ.get("PDF_TRANSLATE_WORK_DIR") or tempfile.gettempdir()) / "srh-pdf-translate"
KEEP_SECONDS = int(os.environ.get("PDF_TRANSLATE_KEEP_SECONDS", "3600"))
MAX_BYTES = 100 * 1024 * 1024
PROMPT = "You are a professional academic translator. Translate into Simplified Chinese."


class Engine(BaseModel):
    base_url: str
    model: str
    api_key: str = "none"
    qps: int = Field(4, ge=1, le=32)
    timeout: int = Field(300, ge=10, le=3600)
    # Qwen3 等推理模型：提示词前加 /no_think 关掉思考，速度差很多
    no_think: bool = False


class Opts(BaseModel):
    pages: str | None = Field(None, pattern=r"^[0-9,\- ]{1,200}$")
    mode: str = Field("both", pattern=r"^(both|mono|dual)$")
    lang_in: str = "en"
    lang_out: str = "zh"
    engine: Engine


jobs: dict[str, dict[str, Any]] = {}
app = FastAPI(title="srh-pdf-translate", version=VERSION)


def build_settings(opts: Opts, out_dir: Path):
    from pdf2zh_next.config.cli_env_model import CLIEnvSettingsModel

    s = CLIEnvSettingsModel()
    s.openaicompatible = True
    d = s.openaicompatible_detail
    d.openai_compatible_model = opts.engine.model
    d.openai_compatible_base_url = opts.engine.base_url
    d.openai_compatible_api_key = opts.engine.api_key or "none"
    d.openai_compatible_timeout = str(opts.engine.timeout)
    t = s.translation
    t.lang_in, t.lang_out = opts.lang_in, opts.lang_out
    t.output = str(out_dir)
    t.qps = opts.engine.qps
    t.pool_max_workers = opts.engine.qps
    t.no_auto_extract_glossary = True
    # pdf2zh 自带的段落缓存在实测中会缓存「原文照抄」的失败结果，导致整篇不翻译；
    # 研协服务端已按 PDF sha256 缓存整份结果，这里不再用它
    t.ignore_cache = True
    t.custom_system_prompt = ("/no_think " if opts.engine.no_think else "") + PROMPT
    p = s.pdf
    p.pages = opts.pages.replace(" ", "") if opts.pages else None
    p.no_mono = opts.mode == "dual"
    p.no_dual = opts.mode == "mono"
    p.watermark_output_mode = "no_watermark"
    return s.to_settings_model()


def scrub(msg: str, opts: Opts) -> str:
    """错误信息里不能带出 api key。"""
    key = opts.engine.api_key
    if key and len(key) > 4:
        msg = msg.replace(key, "***")
    return re.sub(r"sk-[A-Za-z0-9]{8,}", "sk-***", msg)[:2000]


async def run_job(job_id: str, src: Path, opts: Opts) -> None:
    from pdf2zh_next.high_level import do_translate_async_stream

    job = jobs[job_id]
    job["status"] = "running"
    out_dir = src.parent / "out"
    out_dir.mkdir(exist_ok=True)
    try:
        settings = build_settings(opts, out_dir)
        async for ev in do_translate_async_stream(settings, src):
            kind = ev.get("type")
            if kind in ("progress_start", "progress_update", "progress_end"):
                job["progress"] = round(float(ev.get("overall_progress", 0)), 1)
                job["stage"] = ev.get("stage", "")
            elif kind == "finish":
                r = ev["translate_result"]
                job["mono"] = str(r.mono_pdf_path) if r.mono_pdf_path else None
                job["dual"] = str(r.dual_pdf_path) if r.dual_pdf_path else None
                job["progress"] = 100.0
                job["status"] = "done"
                break
            elif kind == "error":
                raise RuntimeError(str(ev.get("error") or "translation failed"))
        if job["status"] != "done":
            raise RuntimeError("translation ended without a result")
    except Exception as e:  # noqa: BLE001 - 任何失败都要落到 job 状态里
        job["status"] = "failed"
        job["error"] = scrub(f"{type(e).__name__}: {e}", opts)
    finally:
        job["finished_at"] = time.time()


def gc_jobs() -> None:
    now = time.time()
    for jid, job in list(jobs.items()):
        if job.get("finished_at") and now - job["finished_at"] > KEEP_SECONDS:
            shutil.rmtree(job["dir"], ignore_errors=True)
            jobs.pop(jid, None)


def public(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "stage": job["stage"],
        "error": job["error"],
        "mono": bool(job.get("mono")),
        "dual": bool(job.get("dual")),
        "elapsed": round((job.get("finished_at") or time.time()) - job["created_at"], 1),
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    try:
        from importlib.metadata import version

        engine = version("pdf2zh-next")
    except Exception:  # noqa: BLE001
        engine = "unknown"
    running = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
    return {"ok": True, "version": VERSION, "engine": engine, "running": running}


@app.post("/jobs", status_code=201)
async def create_job(file: UploadFile = File(...), opts: str = Form(...)) -> dict[str, Any]:
    gc_jobs()
    try:
        parsed = Opts.model_validate(json.loads(opts))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"invalid opts: {e}") from e
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or not data.startswith(b"%PDF"):
        raise HTTPException(400, "file must be a PDF up to 100 MB")
    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True)
    src = job_dir / "input.pdf"
    src.write_bytes(data)
    jobs[job_id] = {
        "id": job_id,
        "dir": str(job_dir),
        "status": "queued",
        "progress": 0.0,
        "stage": "",
        "error": None,
        "created_at": time.time(),
    }
    jobs[job_id]["task"] = asyncio.create_task(run_job(job_id, src, parsed))
    return public(jobs[job_id])


def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.get("/jobs/{job_id}")
async def job_status(job_id: str) -> dict[str, Any]:
    return public(get_job(job_id))


@app.get("/jobs/{job_id}/{kind}")
async def job_file(job_id: str, kind: str) -> FileResponse:
    if kind not in ("mono", "dual"):
        raise HTTPException(404, "unknown file kind")
    job = get_job(job_id)
    path = job.get(kind)
    if job["status"] != "done" or not path or not Path(path).exists():
        raise HTTPException(404, f"{kind} PDF not available")
    return FileResponse(path, media_type="application/pdf", filename=f"{kind}.pdf")


if __name__ == "__main__":
    # pdf2zh-next 在子进程里翻译；Windows 下 multiprocessing 需要这个入口保护
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("PDF_TRANSLATE_HOST", "127.0.0.1"),
        port=int(os.environ.get("PDF_TRANSLATE_PORT", "8090")),
        log_level="info",
    )
