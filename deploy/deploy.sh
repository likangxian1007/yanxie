#!/usr/bin/env bash
# 部署 / 更新（可重复执行）：拉取代码 → 部署前备份 → 构建 → 启动（启动时自动迁移）→ 健康检查 → 刷新反向代理 → 清理本项目旧镜像。
# 用法（root，服务器上）：bash $APP_ROOT/tools/deploy/deploy.sh [分支或提交，默认 main]
#   第一次：REPO_URL=https://github.com/<your-org>/yanxie.git bash deploy/deploy.sh
set -euo pipefail

# 本脚本位于会被 git checkout 改写的目录里：先拷贝到临时文件再执行，避免运行中途被替换
if [ -z "${SRH_DEPLOY_REEXEC:-}" ]; then
  tmp_self=$(mktemp /tmp/srh-deploy.XXXXXX.sh)
  cp "$0" "$tmp_self"
  SRH_DEPLOY_REEXEC=1 exec bash "$tmp_self" "$@"
fi
trap 'rm -f "$0"' EXIT

APP_ROOT=${APP_ROOT:-/srv/srh}
APP_DIR="$APP_ROOT/app"
ENV_FILE="$APP_ROOT/.env"
REF=${1:-${DEPLOY_REF:-main}}
# 第一次克隆时使用的仓库地址（必填，例如 https://github.com/<your-org>/yanxie.git）；已有检出时可不填
REPO_URL=${REPO_URL:-}
PROJECT=${COMPOSE_PROJECT_NAME:-srh}

log() { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE，先运行 deploy/bootstrap-server.sh"
APP_PORT=$(sed -n 's/^APP_PORT=//p' "$ENV_FILE" | tail -1); APP_PORT=${APP_PORT:-8787}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:$APP_PORT/api/health}
grep -q '^LLM_API_KEY=.\+' "$ENV_FILE" || log "警告：$ENV_FILE 里 LLM_API_KEY 为空，AI 功能将不可用"

# 并发保护：同一时间只允许一个部署
exec 9>"$APP_ROOT/.deploy.lock"
flock -n 9 || die "已有部署在进行"

if [ ! -d "$APP_DIR/.git" ]; then
  [ -n "$REPO_URL" ] || die "$APP_DIR 还没有仓库检出：请设置 REPO_URL（例如 REPO_URL=https://github.com/<your-org>/yanxie.git）"
  log "克隆仓库"
  git clone -q "$REPO_URL" "$APP_DIR"
fi

# 部署工具（proxy.sh、backup.sh、代理模板）留一份副本：目标提交里没有 deploy/ 时（比如测试一个应用分支）用副本
TOOLS_COPY="$APP_ROOT/tools/deploy"
save_tools() { if [ -f "$APP_DIR/deploy/proxy.sh" ]; then rm -rf "$TOOLS_COPY"; mkdir -p "$(dirname "$TOOLS_COPY")"; cp -r "$APP_DIR/deploy" "$TOOLS_COPY"; fi; }
save_tools

log "拉取 $REF"
git -C "$APP_DIR" fetch -q --prune origin
git -C "$APP_DIR" checkout -q --detach "origin/$REF" 2>/dev/null || git -C "$APP_DIR" checkout -q --detach "$REF"
git -C "$APP_DIR" reset -q --hard
git -C "$APP_DIR" clean -qfd -e .env
COMMIT=$(git -C "$APP_DIR" rev-parse --short HEAD)
log "当前提交 $COMMIT"
if [ -f "$APP_DIR/deploy/proxy.sh" ]; then
  save_tools
  TOOLS_BASE="$APP_DIR"
else
  [ -f "$TOOLS_COPY/proxy.sh" ] || die "提交 $COMMIT 里没有 deploy/，服务器上也没有部署工具副本"
  log "提交 $COMMIT 里没有 deploy/，使用部署工具副本 $TOOLS_COPY"
  TOOLS_BASE="$APP_ROOT/tools"
fi

cd "$APP_DIR"
[ -f docker-compose.yml ] || die "仓库 $COMMIT 里还没有 docker-compose.yml"
# compose 里 app 用 env_file: .env，指向服务器上唯一的那份 .env（不进仓库）
ln -sfn "$ENV_FILE" "$APP_DIR/.env"
DC=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.yml)
[ -f deploy/docker-compose.prod.yml ] && DC+=(-f deploy/docker-compose.prod.yml)

# 已有数据库时先备份，再动结构
if "${DC[@]}" ps --status running --services 2>/dev/null | grep -qx db; then
  log "部署前备份"
  APP_ROOT="$APP_ROOT" bash "$TOOLS_BASE/deploy/backup.sh" || log "备份失败（继续部署）"
fi

# 部署子路径（可选）：环境变量 WEB_BASE_PATH 优先，其次 .env 里的 WEB_BASE_PATH，默认 /
if [ -z "${WEB_BASE_PATH:-}" ]; then
  WEB_BASE_PATH=$(sed -n 's/^WEB_BASE_PATH=//p' "$ENV_FILE" | tail -1)
fi
export WEB_BASE_PATH=${WEB_BASE_PATH:-/}

log "构建镜像（前端子路径 $WEB_BASE_PATH）"
"${DC[@]}" build --pull
# Notebook 内核镜像（app 按项目用它起隔离容器，不由 compose 直接运行）
if [ -f deploy/kernel/Dockerfile ]; then
  KERNEL_IMAGE=$(sed -n 's/^KERNEL_IMAGE=//p' "$ENV_FILE" | tail -1); KERNEL_IMAGE=${KERNEL_IMAGE:-srh-kernel:latest}
  log "构建内核镜像 $KERNEL_IMAGE"
  docker build --pull -q -t "$KERNEL_IMAGE" deploy/kernel >/dev/null
fi

log "启动服务（应用启动时自动执行数据库迁移）"
"${DC[@]}" up -d --remove-orphans

if [ -n "${MIGRATE_CMD:-}" ]; then
  log "执行迁移：$MIGRATE_CMD"
  "${DC[@]}" exec -T app sh -c "$MIGRATE_CMD"
fi

log "等待健康检查 $HEALTH_URL"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$HEALTH_URL"; then
    log "应用已就绪：$COMMIT"
    APP_ROOT="$APP_ROOT" APP_DIR="$TOOLS_BASE" bash "$TOOLS_BASE/deploy/proxy.sh"
    # Notebook 内核网络收紧（幂等）：内核不能主动连 app 和宿主机端口
    if [ -f "$TOOLS_BASE/deploy/kernel-firewall.sh" ]; then
      bash "$TOOLS_BASE/deploy/kernel-firewall.sh" >/dev/null || log "警告：内核防火墙规则没装上，见 deploy/kernel-firewall.sh --status"
    fi
    echo "$(date -Is) $COMMIT" >> "$APP_ROOT/deploy-history.log"
    # 只清理本项目的悬空镜像，不碰同机其他服务
    docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" >/dev/null || true
    log "上线成功：$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -1)"
    exit 0
  fi
  sleep 3
done

"${DC[@]}" ps
"${DC[@]}" logs --tail 80
die "健康检查失败（$COMMIT）"
