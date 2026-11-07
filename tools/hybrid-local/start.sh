#!/usr/bin/env bash
# 启动 / 停止 / 检查研协混合 AI 栈（Linux）。Start / stop / check the hybrid stack (Linux).
# 用法 usage: tools/hybrid-local/start.sh [start|stop|check] [--skip-app] [--install-dir DIR]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/srh-hybrid"
CMD=start
SKIP_APP=0
while [ $# -gt 0 ]; do
  case "$1" in
    start | stop | check) CMD="$1" ;;
    --skip-app) SKIP_APP=1 ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEVICE=CPU MODEL_SOURCE=OpenVINO/Qwen3-4B-int4-ov MODEL_NAME=qwen3-4b OVMS_PORT=8000 PDF_PORT=8090 LOCAL_MODEL=0 PDF=0
ENV_FILE="$REPO_ROOT/apps/server/.env"
# shellcheck disable=SC1091
[ -f "$INSTALL_DIR/config.env" ] && . "$INSTALL_DIR/config.env"
LOGS="$INSTALL_DIR/logs" RUN="$INSTALL_DIR/run"
mkdir -p "$LOGS" "$RUN"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

get() { curl -fsS --noproxy '*' -m 3 "$1" 2>/dev/null; }
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
env_val() { grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'"'" | xargs; }

start_part() { # name port workdir cmd...
  local name="$1" port="$2" dir="$3"; shift 3
  if listening "$port"; then echo "[OK] $name：端口 $port 已在监听，跳过 | already running"; return 1; fi
  (cd "$dir" && nohup "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$RUN/$name.pid")
  echo "[OK] $name：已启动，日志 $LOGS/$name.log | started"
}

wait_for() { # seconds desc test-cmd...
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 $((n / 2))); do "$@" && return 0; sleep 2; done
  echo "[!] 等待 $what 超时 | timed out"; return 1
}

do_check() {
  echo "==> 研协混合 AI 状态 | status（.env: $ENV_FILE）"
  local url model pdf local_on=0
  url="$(env_val LOCAL_LLM_BASE_URL)"; model="$(env_val LOCAL_LLM_MODEL)"; pdf="$(env_val PDF_TRANSLATE_URL)"
  if [ -z "$url" ] || [ -z "$model" ]; then echo '[!] 本机模型：未配置 → 全部走云端 | not configured, cloud only'
  elif get "${url%/}/models" | grep -q "\"$model\""; then local_on=1; echo "[OK] 本机模型：在线 $url（$model）"
  else echo "[!] 本机模型：连不上 $url → 自动走云端 | unreachable, cloud fallback"; fi
  if [ -z "$pdf" ]; then echo '[!] PDF 翻译服务：未配置 → 不显示「翻译 PDF」'
  elif get "${pdf%/}/health" | grep -q '"ok": *true'; then echo "[OK] PDF 翻译服务：在线 $pdf"
  else echo "[!] PDF 翻译服务：连不上 $pdf"; fi
  get http://127.0.0.1:8787/api/health >/dev/null && echo '[OK] 研协 server：在线 :8787' || echo '[i] 研协 server：未运行 :8787'
  [ $local_on = 1 ] && echo '[OK] 结论：本机 + 云端混合' || echo '[i] 结论：所有 AI 调用走云端（功能不受影响）| cloud only'
}

case "$CMD" in
  check) do_check ;;
  stop)
    for f in "$RUN"/*.pid; do
      [ -f "$f" ] || continue
      pid="$(cat "$f")"; kill "$pid" 2>/dev/null && echo "[OK] $(basename "$f" .pid) stopped"; rm -f "$f"
    done ;;
  start)
    if [ "$LOCAL_MODEL" = 1 ] && [ -x "$INSTALL_DIR/ovms/bin/ovms" ]; then
      export LD_LIBRARY_PATH="$INSTALL_DIR/ovms/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      start_part ovms "$OVMS_PORT" "$INSTALL_DIR" "$INSTALL_DIR/ovms/bin/ovms" --rest_port "$OVMS_PORT" --model_repository_path models \
        --source_model "$MODEL_SOURCE" --model_name "$MODEL_NAME" --task text_generation --target_device "$DEVICE" &&
        wait_for 300 OVMS sh -c "curl -fsS --noproxy '*' -m 3 http://127.0.0.1:$OVMS_PORT/v3/models | grep -q '\"$MODEL_NAME\"'"
    else echo '[!] 本机模型未安装，跳过（全部走云端）'; fi
    if [ "$PDF" = 1 ] && [ -x "$INSTALL_DIR/pdf-venv/bin/python" ]; then
      PDF_TRANSLATE_PORT="$PDF_PORT" start_part pdf-translate "$PDF_PORT" "$REPO_ROOT/tools/pdf-translate" "$INSTALL_DIR/pdf-venv/bin/python" app.py &&
        wait_for 90 pdf-translate sh -c "curl -fsS --noproxy '*' -m 3 http://127.0.0.1:$PDF_PORT/health >/dev/null"
    else echo '[!] PDF 翻译服务未安装，跳过'; fi
    if [ $SKIP_APP = 0 ] && command -v pnpm >/dev/null 2>&1; then
      start_part server 8787 "$REPO_ROOT" pnpm dev:server
      start_part web 5173 "$REPO_ROOT" pnpm dev:web
      wait_for 180 server sh -c "curl -fsS --noproxy '*' -m 3 http://127.0.0.1:8787/api/health >/dev/null"
    fi
    do_check
    [ $SKIP_APP = 0 ] && echo '==> 打开 http://localhost:5173'
    ;;
esac
