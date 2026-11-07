#!/usr/bin/env bash
# 研协混合 AI 本机部分安装（Linux，简化版；Windows 用 install.ps1）。
# Local half of SRH hybrid AI, Linux installer (simplified; Windows: install.ps1).
# 说明 / docs: docs/hybrid-local-setup.md
#
# 用法 / usage:
#   tools/hybrid-local/install.sh [--dry-run] [--skip-pdf] [--skip-local-model] [--device GPU|CPU]
#       [--install-dir DIR] [--env-file FILE]... [--ovms-port 8000] [--pdf-port 8090] [--hf-endpoint URL]
# 代理：沿用环境变量 HTTPS_PROXY / https_proxy。Proxy: honours HTTPS_PROXY.
set -euo pipefail

OVMS_VERSION=2026.4.1
MODEL_SOURCE=OpenVINO/Qwen3-4B-int4-ov
MODEL_NAME=qwen3-4b
ENV_HEADER='# ---- 混合 AI：本机部分（tools/hybrid-local/install.sh 写入，可手动改）----'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/srh-hybrid"
OVMS_PORT=8000
PDF_PORT=8090
DEVICE=""
DRY_RUN=0
SKIP_PDF=0
SKIP_LOCAL=0
ENV_FILES=()

say() { printf '%s %s\n' "$1" "$2"; }
info() { say '[i]' "$*"; }
ok() { say '[OK]' "$*"; }
warn() { say '[!]' "$*"; }
err() { say '[X]' "$*" >&2; }
step() { say '==>' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-pdf) SKIP_PDF=1 ;;
    --skip-local-model) SKIP_LOCAL=1 ;;
    --device) DEVICE="$2"; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --env-file) ENV_FILES+=("$2"); shift ;;
    --ovms-port) OVMS_PORT="$2"; shift ;;
    --pdf-port) PDF_PORT="$2"; shift ;;
    --hf-endpoint) export HF_ENDPOINT="$2"; shift ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) err "未知参数 unknown option: $1"; exit 1 ;;
  esac
  shift
done
if [ ${#ENV_FILES[@]} -eq 0 ]; then
  ENV_FILES=("$REPO_ROOT/apps/server/.env")
  [ -f "$REPO_ROOT/.env" ] && ENV_FILES+=("$REPO_ROOT/.env")
fi
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

step "研协混合 AI：本机部分安装 | SRH hybrid AI: local setup"
info "安装目录 install dir: $INSTALL_DIR"

# ---------- 1. 检测 / detect ----------
[ "$(uname -s)" = Linux ] || { err '这个脚本只支持 Linux；Windows 用 install.ps1 | Linux only'; exit 1; }
[ "$(uname -m)" = x86_64 ] || { err '需要 x86_64 | x86_64 required'; exit 1; }
CPU="$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
FREE_GB=$(df -Pk "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}')
INTEL_GPU=""
if command -v lspci >/dev/null 2>&1; then INTEL_GPU="$(lspci | grep -iE 'VGA|Display' | grep -i intel | head -n1 | cut -d: -f3- || true)"; fi
HAS_DRI=0; ls /dev/dri/renderD* >/dev/null 2>&1 && HAS_DRI=1
NPU=""; [ -e /dev/accel/accel0 ] && NPU="/dev/accel/accel0"
info "CPU: $CPU"
info "Intel GPU: ${INTEL_GPU:-无 none}（/dev/dri: $HAS_DRI）"
info "NPU: ${NPU:-无 none}"
info "内存 RAM: ${RAM_GB} GB；可用磁盘 free disk: ${FREE_GB} GB"

if [ -z "$DEVICE" ]; then
  if [ -n "$INTEL_GPU" ] && [ "$HAS_DRI" = 1 ]; then DEVICE=GPU; else DEVICE=CPU; fi
fi
case "$DEVICE" in GPU) LABEL="Intel GPU" ;; NPU) LABEL="Intel NPU" ;; *) LABEL="CPU" ;; esac
ok "推理设备 target device: $DEVICE"
[ "$DEVICE" = GPU ] && info 'GPU 需要 Intel compute runtime（Ubuntu: apt install intel-opencl-icd），且当前用户在 render 组里'
[ "$DEVICE" = CPU ] && [ $SKIP_LOCAL = 0 ] && warn '没有可用的 Intel 核显，本机模型用 CPU 跑会比较慢 | CPU inference is slow'

NEED=1; [ $SKIP_LOCAL = 0 ] && NEED=$((NEED + 4)); [ $SKIP_PDF = 0 ] && NEED=$((NEED + 2))
if [ $SKIP_LOCAL = 0 ] && [ "$RAM_GB" -lt 8 ]; then err "内存 < 8 GB，本机模型跑不动；用 --skip-local-model | RAM < 8 GB"; [ $DRY_RUN = 1 ] || exit 2; fi
if [ "${FREE_GB:-0}" -lt "$NEED" ]; then err "磁盘可用 ${FREE_GB} GB < 约 ${NEED} GB | not enough disk"; [ $DRY_RUN = 1 ] || exit 2; fi

# 选 OVMS 发行包 / pick the release tarball
. /etc/os-release 2>/dev/null || true
case "${ID:-}-${VERSION_ID:-}" in
  ubuntu-22.*) FLAVOR=ubuntu22 ;;
  ubuntu-24.* | ubuntu-25.* | debian-13*) FLAVOR=ubuntu24 ;;
  debian-12*) FLAVOR=ubuntu22 ;;
  rhel-* | rocky-* | almalinux-* | centos-*) FLAVOR=redhat ;;
  *) FLAVOR="" ;;
esac
OVMS_URL="https://github.com/openvinotoolkit/model_server/releases/download/v${OVMS_VERSION}/ovms_${FLAVOR}_${OVMS_VERSION}_python_off.tar.gz"
OVMS_BIN="$INSTALL_DIR/ovms/bin/ovms"
MODEL_BIN="$INSTALL_DIR/models/$MODEL_SOURCE/openvino_model.bin"
VENV="$INSTALL_DIR/pdf-venv"
# 下载失败时 openvino_model.bin 只是 LFS 指针小文件 / a failed pull leaves a tiny LFS pointer
model_ok() { [ -f "$MODEL_BIN" ] && [ "$(stat -c %s "$MODEL_BIN")" -gt 104857600 ] && ! ls "$(dirname "$MODEL_BIN")"/*lfs_part >/dev/null 2>&1; }

set_env_key() { # file key value：只改这一个键 / update only this key
  local file="$1" key="$2" value="$3"
  mkdir -p "$(dirname "$file")"; touch "$file"
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" '{ if ($0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=") print k "=" v; else print }' "$file" >"$tmp"
    cat "$tmp" >"$file"; rm -f "$tmp"
  else
    grep -qxF "$ENV_HEADER" "$file" || printf '\n%s\n' "$ENV_HEADER" >>"$file"
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

ENV_KEYS=()
if [ $SKIP_LOCAL = 0 ]; then ENV_KEYS+=("LOCAL_LLM_BASE_URL=http://127.0.0.1:$OVMS_PORT/v3" "LOCAL_LLM_MODEL=$MODEL_NAME" "LOCAL_LLM_DEVICE=$LABEL"); fi
if [ $SKIP_PDF = 0 ]; then ENV_KEYS+=("PDF_TRANSLATE_URL=http://127.0.0.1:$PDF_PORT"); fi

if [ $DRY_RUN = 1 ]; then
  step '计划（--dry-run，不做任何改动）| plan only'
  if [ $SKIP_LOCAL = 0 ]; then
    if [ -x "$OVMS_BIN" ]; then info 'OVMS 已安装'; elif [ -n "$FLAVOR" ]; then info "下载 $OVMS_URL"; else warn "发行版 ${ID:-?} 没有官方 OVMS 包，请用 Docker（见文档）"; fi
    model_ok && info '模型已存在' || info "拉取模型 $MODEL_SOURCE（约 2.2 GB）"
  fi
  [ $SKIP_PDF = 0 ] && info "PDF 服务 venv: $VENV"
  for f in "${ENV_FILES[@]}"; do info "$f 将写入: ${ENV_KEYS[*]:-无}"; done
  exit 0
fi

mkdir -p "$INSTALL_DIR/logs"

# ---------- 2. OVMS + 模型 ----------
if [ $SKIP_LOCAL = 0 ]; then
  step "安装 OpenVINO Model Server $OVMS_VERSION"
  if [ -x "$OVMS_BIN" ]; then
    ok '已安装，跳过'
  else
    [ -n "$FLAVOR" ] || { err "发行版 ${ID:-?} 没有官方 OVMS 包。请用 Docker：docker run -d -p $OVMS_PORT:8000 -v \$PWD/models:/models openvino/model_server:latest --rest_port 8000 --model_repository_path /models --source_model $MODEL_SOURCE --model_name $MODEL_NAME --task text_generation --target_device CPU"; exit 3; }
    TGZ="$INSTALL_DIR/ovms.tar.gz"
    curl -fL --retry 3 -o "$TGZ.part" "$OVMS_URL" && mv "$TGZ.part" "$TGZ"
    if curl -fsSL -o "$TGZ.sha256" "$OVMS_URL.sha256"; then
      [ "$(cut -d' ' -f1 "$TGZ.sha256")" = "$(sha256sum "$TGZ" | cut -d' ' -f1)" ] || { rm -f "$TGZ"; err 'SHA256 不匹配 | checksum mismatch'; exit 3; }
      ok 'SHA256 校验通过'
    fi
    tar -xzf "$TGZ" -C "$INSTALL_DIR" && rm -f "$TGZ" "$TGZ.sha256"
  fi
  export LD_LIBRARY_PATH="$INSTALL_DIR/ovms/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  "$OVMS_BIN" --version | head -n1
  step "拉取模型 $MODEL_SOURCE（国内可加 --hf-endpoint https://hf-mirror.com）"
  if model_ok; then
    ok '模型已存在，跳过'
  else
    for _ in 1 2 3; do model_ok && break; (cd "$INSTALL_DIR" && "$OVMS_BIN" --pull --source_model "$MODEL_SOURCE" --model_repository_path models \
      --model_name "$MODEL_NAME" --task text_generation --target_device "$DEVICE" >>"logs/ovms-pull.log" 2>&1) || true; done
    model_ok || { err "模型拉取失败，见 $INSTALL_DIR/logs/ovms-pull.log | model pull failed"; exit 4; }
    ok '模型就绪'
  fi
fi

# ---------- 3. PDF 翻译服务（pdf2zh-next，AGPL-3.0，独立进程）----------
if [ $SKIP_PDF = 0 ]; then
  step '安装整篇 PDF 翻译服务（pdf2zh-next，AGPL-3.0，独立进程）'
  REQ="$REPO_ROOT/tools/pdf-translate/requirements.txt"
  [ -f "$REQ" ] || { err "找不到 $REQ"; exit 5; }
  if [ ! -x "$VENV/bin/python" ]; then
    if command -v uv >/dev/null 2>&1; then uv venv --python 3.12 "$VENV"; else python3 -m venv "$VENV"; fi
  fi
  if "$VENV/bin/python" -c 'import pdf2zh_next, bitstring, fastapi' 2>/dev/null; then
    ok '依赖已装，跳过'
  else
    if command -v uv >/dev/null 2>&1; then uv pip install --python "$VENV/bin/python" -r "$REQ"; else "$VENV/bin/python" -m pip install -q -r "$REQ"; fi
    "$VENV/bin/python" -c 'import pdf2zh_next, bitstring, fastapi' || { err '依赖安装失败 | pip install failed'; exit 5; }
    ok '依赖就绪'
  fi
fi

# ---------- 4. .env + 配置 ----------
step '写入 .env（只改本机相关的键）| updating .env'
for f in "${ENV_FILES[@]}"; do
  for kv in "${ENV_KEYS[@]}"; do set_env_key "$f" "${kv%%=*}" "${kv#*=}"; done
  ok "$f"
done
cat >"$INSTALL_DIR/config.env" <<EOF
REPO_ROOT='$REPO_ROOT'
DEVICE=$DEVICE
MODEL_SOURCE=$MODEL_SOURCE
MODEL_NAME=$MODEL_NAME
OVMS_PORT=$OVMS_PORT
PDF_PORT=$PDF_PORT
LOCAL_MODEL=$((1 - SKIP_LOCAL))
PDF=$((1 - SKIP_PDF))
ENV_FILE='${ENV_FILES[0]}'
EOF
step "完成。启动：tools/hybrid-local/start.sh start（没启动的部分自动走云端）"
