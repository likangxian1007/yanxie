#!/usr/bin/env bash
# 服务器初始化（可重复执行）：Docker + Compose、反向代理、防火墙、swap、目录、.env、备份定时任务。
# 对已有其他服务的机器是安全的：已装的组件跳过；已经在用的 nginx 只新增一个独立端口的站点；
# ufw 已启用时只追加放行规则，不改默认策略；已有 swap 不动；已存在的 .env 不覆盖。
# 用法（root）：bash bootstrap-server.sh
#   必填：REPO_URL=<仓库地址>（目录里已有检出时可省略）
#   可选环境变量：APP_ROOT=/opt/yanxie  PUBLIC_PORT=80  APP_PORT=8787  SWAP_SIZE=4G  PROXY=auto|nginx|caddy
set -euo pipefail

APP_ROOT=${APP_ROOT:-/opt/yanxie}
# 要部署的仓库（你的 fork 或镜像），例如 https://github.com/<your-org>/yanxie.git。
# 私有仓库请用 SSH 地址，并自行为 root 配好对该仓库有只读权限的 SSH key。
REPO_URL=${REPO_URL:-}
SWAP_SIZE=${SWAP_SIZE:-4G}

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "请用 root 运行" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# 已有 .env 时以其中的端口为准
if [ -f "$APP_ROOT/.env" ]; then
  set -a; . "$APP_ROOT/.env"; set +a
fi
PUBLIC_PORT=${PUBLIC_PORT:-80}
APP_PORT=${APP_PORT:-8787}

log "基础软件"
need=()
for p in ca-certificates curl gnupg git jq openssl; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then apt-get update -qq; apt-get install -y -qq "${need[@]}" >/dev/null; fi

if ! command -v docker >/dev/null 2>&1; then
  . /etc/os-release
  codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
  if curl -fsI "https://download.docker.com/linux/ubuntu/dists/$codename/Release" >/dev/null 2>&1; then
    log "安装 Docker Engine + Compose 插件（Docker 官方源，$codename）"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  else
    # 非 LTS 新版本 Docker 官方源往往还没有，用 Ubuntu 自带的包
    log "Docker 官方源暂不支持 $codename，安装 Ubuntu 仓库的 docker.io + docker-compose-v2"
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
    apt-get install -y -qq docker-buildx >/dev/null 2>&1 || true
  fi
  mkdir -p /etc/docker
  [ -f /etc/docker/daemon.json ] || echo '{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null 2>&1 || { apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || apt-get install -y -qq docker-compose-v2 >/dev/null; }

if ! swapon --show | grep -q .; then
  log "创建 ${SWAP_SIZE} swap"
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "防火墙"
command -v ufw >/dev/null 2>&1 || apt-get install -y -qq ufw >/dev/null
if ufw status | grep -q 'Status: active'; then
  ufw allow 22/tcp >/dev/null
  if [ "$PUBLIC_PORT" = 80 ]; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    log "ufw 已在用，追加放行 22/80/443"
  else
    ufw allow "${PUBLIC_PORT}/tcp" comment 'srh' >/dev/null
    log "ufw 已在用，只追加放行 22/${PUBLIC_PORT}"
  fi
else
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "${PUBLIC_PORT}/tcp" >/dev/null
  ufw --force enable >/dev/null
  log "ufw 已启用：22/80/443/${PUBLIC_PORT}"
fi

log "目录：$APP_ROOT/{app,backups}"
mkdir -p "$APP_ROOT/backups"
chmod 700 "$APP_ROOT/backups"
if [ ! -d "$APP_ROOT/app/.git" ]; then
  if [ -z "$REPO_URL" ]; then
    log "未设置 REPO_URL，跳过克隆；之后用 REPO_URL=<仓库地址> 重跑本脚本或 deploy.sh"
  else
    git clone -q "$REPO_URL" "$APP_ROOT/app" || log "仓库暂不可克隆（$REPO_URL）：检查地址与访问权限后重跑"
  fi
fi

if [ ! -f "$APP_ROOT/.env" ]; then
  log "生成 $APP_ROOT/.env（随机密钥；LLM_API_KEY 需手动填写）"
  pg_pw=$(openssl rand -hex 24)
  ip=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  if [ "$PUBLIC_PORT" = 80 ]; then url="http://$ip"; else url="http://$ip:$PUBLIC_PORT"; fi
  cat > "$APP_ROOT/.env" <<EOF
# 研协生产环境变量。只在服务器上，不进仓库。改完执行 deploy.sh 生效。
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
# 宿主机上应用监听的端口（只绑 127.0.0.1），以及反向代理对外的端口
APP_PORT=$APP_PORT
PUBLIC_PORT=$PUBLIC_PORT
PUBLIC_URL=$url
SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_USER=srh
POSTGRES_DB=srh
POSTGRES_PASSWORD=$pg_pw
DATABASE_URL=postgres://srh:$pg_pw@db:5432/srh
DB_AUTO_MIGRATE=true
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-chat
LLM_MODEL_REASONING=deepseek-reasoner
STORAGE_DIR=/data/storage
EOF
fi
chmod 600 "$APP_ROOT/.env"

if [ -f "$APP_ROOT/app/deploy/proxy.sh" ]; then
  # 部署工具副本（cron 备份和 deploy.sh 回退时使用）
  rm -rf "$APP_ROOT/tools/deploy"; mkdir -p "$APP_ROOT/tools"; cp -r "$APP_ROOT/app/deploy" "$APP_ROOT/tools/deploy"
  APP_ROOT="$APP_ROOT" bash "$APP_ROOT/app/deploy/proxy.sh"
else
  log "仓库还没有 deploy/proxy.sh，反向代理留到第一次 deploy.sh 时配置"
fi

log "每日备份（03:30）"
cat > /etc/cron.d/srh-backup <<EOF
30 3 * * * root bash $APP_ROOT/tools/deploy/backup.sh >> /var/log/srh-backup.log 2>&1
EOF

log "完成。$(docker --version)；compose $(docker compose version --short)"
