#!/usr/bin/env bash
# 备份 PostgreSQL（pg_dump 自定义格式）和上传文件卷，保留最近 ${KEEP_DAYS:-14} 天。
# 恢复：docker compose ... exec -T db pg_restore -U srh -d srh --clean --if-exists < 文件.dump
set -euo pipefail

APP_ROOT=${APP_ROOT:-/opt/yanxie}
ENV_FILE="$APP_ROOT/.env"
OUT="$APP_ROOT/backups"
KEEP_DAYS=${KEEP_DAYS:-14}
PROJECT=${COMPOSE_PROJECT_NAME:-srh}
TS=$(date +%Y%m%d-%H%M%S)

set -a; . "$ENV_FILE"; set +a
mkdir -p "$OUT"; chmod 700 "$OUT"
umask 077
trap 'rm -f "$OUT"/*.partial' EXIT
cd "$APP_ROOT/app"
DC=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.yml)
[ -f deploy/docker-compose.prod.yml ] && DC+=(-f deploy/docker-compose.prod.yml)

"${DC[@]}" exec -T db pg_dump -U "${POSTGRES_USER:-srh}" -d "${POSTGRES_DB:-srh}" -Fc > "$OUT/db-$TS.dump.partial"
mv "$OUT/db-$TS.dump.partial" "$OUT/db-$TS.dump"
echo "db -> $OUT/db-$TS.dump ($(du -h "$OUT/db-$TS.dump" | cut -f1))"

# 上传文件：备份 app 容器的 /data 目录（存在时）
if "${DC[@]}" exec -T app test -d /data 2>/dev/null; then
  "${DC[@]}" exec -T app tar -C /data -czf - . > "$OUT/files-$TS.tar.gz.partial"
  mv "$OUT/files-$TS.tar.gz.partial" "$OUT/files-$TS.tar.gz"
  echo "files -> $OUT/files-$TS.tar.gz"
fi

find "$OUT" -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
