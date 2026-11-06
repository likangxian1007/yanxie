#!/usr/bin/env bash
# 安装 / 刷新反向代理配置（可重复执行，配置无变化时不重载）。
# PROXY=auto：机器上 nginx 在运行就用 nginx（新增独立站点 srh.conf），否则用 Caddy。
set -euo pipefail

APP_ROOT=${APP_ROOT:-/opt/yanxie}
APP_DIR=${APP_DIR:-$APP_ROOT/app}
set -a; . "$APP_ROOT/.env"; set +a
PUBLIC_PORT=${PUBLIC_PORT:-80}
APP_PORT=${APP_PORT:-8787}
PROXY=${PROXY:-auto}

log() { printf '\033[1;35m[proxy]\033[0m %s\n' "$*"; }

if [ "$PROXY" = auto ]; then
  if systemctl is-active --quiet nginx; then PROXY=nginx; else PROXY=caddy; fi
fi

if [ "$PROXY" = nginx ]; then
  tmp=$(mktemp)
  sed -e "s/__PUBLIC_PORT__/$PUBLIC_PORT/g" -e "s/__APP_PORT__/$APP_PORT/g" -e "s/server_name _;/server_name ${DOMAIN:-_};/" "$APP_DIR/deploy/nginx/srh.conf.template" > "$tmp"
  [ -n "${DOMAIN:-}" ] && log "nginx 模式不会自动签 HTTPS 证书：请用 certbot 或在前面挂 Cloudflare"
  dst=/etc/nginx/sites-available/srh.conf
  if cmp -s "$tmp" "$dst" && [ -L /etc/nginx/sites-enabled/srh.conf ]; then
    log "nginx 配置无变化"; rm -f "$tmp"; exit 0
  fi
  [ -f "$dst" ] && cp "$dst" "$dst.bak"
  install -m 644 "$tmp" "$dst"; rm -f "$tmp"
  ln -sfn "$dst" /etc/nginx/sites-enabled/srh.conf
  if nginx -t 2>/tmp/srh-nginx-test.log; then
    systemctl reload nginx
    log "nginx 已加载：:$PUBLIC_PORT → 127.0.0.1:$APP_PORT"
  else
    cat /tmp/srh-nginx-test.log >&2
    # 回滚，绝不让坏配置影响同机其他站点
    if [ -f "$dst.bak" ]; then mv "$dst.bak" "$dst"; else rm -f "$dst" /etc/nginx/sites-enabled/srh.conf; fi
    log "nginx 配置测试失败，已回滚"; exit 1
  fi
else
  if ! command -v caddy >/dev/null 2>&1; then
    log "安装 Caddy"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  tmp=$(mktemp)
  # 设了 DOMAIN 就以域名为站点地址，Caddy 自动申请并续期 HTTPS 证书；否则只按端口提供 HTTP
  if [ -n "${DOMAIN:-}" ]; then SITE=$DOMAIN; else SITE=":$PUBLIC_PORT"; fi
  sed -e "s/__SITE__/$SITE/g" -e "s/__PUBLIC_PORT__/$PUBLIC_PORT/g" -e "s/__APP_PORT__/$APP_PORT/g" "$APP_DIR/deploy/Caddyfile" > "$tmp"
  install -d -o caddy -g caddy /var/log/caddy
  install -d /etc/caddy/conf.d
  if ! cmp -s "$tmp" /etc/caddy/Caddyfile; then
    [ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
    install -m 644 "$tmp" /etc/caddy/Caddyfile
    # 以 caddy 用户校验，避免校验时以 root 身份创建日志文件导致服务无权写入
    if ! runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile >/tmp/srh-caddy-validate.log 2>&1; then
      cat /tmp/srh-caddy-validate.log >&2
      [ -f /etc/caddy/Caddyfile.bak ] && mv /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile
      log "Caddy 配置校验失败，已回滚"; rm -f "$tmp"; exit 1
    fi
    changed=1
  else
    changed=0
  fi
  rm -f "$tmp"
  chown -R caddy:caddy /var/log/caddy
  systemctl enable caddy >/dev/null 2>&1
  if ! systemctl is-active --quiet caddy; then
    systemctl restart caddy
  elif [ "$changed" = 1 ]; then
    systemctl reload caddy || systemctl restart caddy
  fi
  sleep 2
  systemctl is-active --quiet caddy || { journalctl -u caddy --no-pager -n 20 >&2; log "Caddy 启动失败"; exit 1; }
  log "Caddy 运行中：:$PUBLIC_PORT → 127.0.0.1:$APP_PORT"
fi
