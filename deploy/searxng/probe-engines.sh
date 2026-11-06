#!/usr/bin/env bash
# 逐个测 SearXNG 引擎在这台服务器上能不能用（上游常按机房 IP 拦截）。
# 用法：bash deploy/searxng/probe-engines.sh [searxng 地址] [检索词]
#   默认地址通过 app 容器（srh-app-1，可用 APP_CONTAINER 覆盖）访问 Compose 内网里的 searxng：
#     bash deploy/searxng/probe-engines.sh
#   也可以直接给地址（例如临时起在 127.0.0.1:8889 的测试实例）：
#     bash deploy/searxng/probe-engines.sh http://127.0.0.1:8889
# 输出每个引擎的结果条数和报错，据此调整 settings.yml 的 engines 段。
set -euo pipefail

BASE="${1:-}"
QUERY="${2:-transformer attention mechanism}"
ENGINES=(bing brave yahoo mojeek startpage mwmbl "bing news" arxiv google duckduckgo qwant wikipedia wikidata "google scholar")

fetch() {
  if [[ -n "$BASE" ]]; then
    curl -fsS --max-time 25 "$1"
  else
    # 不用 docker compose exec：服务器上的项目名是 srh（deploy.sh 用 -p srh --env-file /opt/yanxie/.env），
    # 在仓库目录里直接 compose exec 找不到项目、也缺 env-file，所以按容器名直接 exec。
    docker exec "${APP_CONTAINER:-srh-app-1}" wget -qO- -T 25 "$1"
  fi
}

host="${BASE:-http://searxng:8080}"
q=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$QUERY")
for e in "${ENGINES[@]}"; do
  en=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$e")
  body=$(fetch "$host/search?q=$q&format=json&engines=$en" 2>/dev/null || true)
  printf '%-16s ' "$e"
  printf '%s' "$body" | python3 -c '
import json, sys
name = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("请求失败"); sys.exit()
own = [r for r in d.get("results", []) if name in r.get("engines", [])]
errs = [u for u in d.get("unresponsive_engines", []) if u[0] == name]
print(f"{len(own):>3} 条" + (f"  {errs[0][1]}" if errs else ("" if own else "  （未启用或无结果）")))
' "$e"
done
