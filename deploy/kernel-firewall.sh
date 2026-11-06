#!/usr/bin/env bash
# Notebook 内核的网络防火墙（宿主机 root 执行；幂等，可重复跑；deploy.sh 每次部署后会自动执行）。
#
# 每个项目的内核在自己的 internal 网络 srh-kn-<projectId>，网卡名 srhkn<哈希>（见
# apps/server/src/modules/notebooks/kernel/host.ts）。internal 已经切断了外网，但同一网络里还有 app 容器，
# 网关 IP 又是宿主机本身，所以内核原本能连到 app:8787 和宿主机的 22/80 端口。这里收紧为：
#   - 转发（同一网桥内）：只放行新连接到 :8888（app → 内核的 Kernel Gateway），其余新连接丢弃，
#     所以内核不能主动连 app 或别的容器；回包照常放行。
#     另放行 :3128（内核 → pypi-proxy，白名单代理只放行 PyPI，见 deploy/pypi-proxy）。
#   - 发往宿主机本身（网关 IP）：只放行回包，内核连不到宿主机任何端口（SSH、Caddy、Postgres 等）。
# 用 iptables 的 srhkn+ 通配，新建项目的网络不用再跑本脚本。
# 旧版本建的网络网卡名是 br-<id>，本脚本会把当前存在的这类网络逐个加进来（升级后新建的都是 srhkn 前缀）。
#
# 用法：
#   sudo deploy/kernel-firewall.sh            # 安装 / 更新规则
#   sudo deploy/kernel-firewall.sh --remove   # 删除规则
#   sudo deploy/kernel-firewall.sh --status   # 查看
set -euo pipefail

CHAIN="SRH-KERNEL"
PREFIX="srhkn+"

if [[ $EUID -ne 0 ]]; then
  echo "需要 root 权限" >&2
  exit 1
fi

ifaces() {
  echo "$PREFIX"
  # 旧网络：srh-kn-* 但网卡不是 srhkn 前缀
  for id in $(docker network ls -q --filter name=srh-kn- 2>/dev/null); do
    name=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$id" 2>/dev/null || true)
    if [[ -z "$name" || "$name" == "<no value>" ]]; then
      echo "br-${id:0:12}"
    fi
  done
}

remove() {
  for chain_in in "DOCKER-USER:$CHAIN" "INPUT:$CHAIN-IN"; do
    parent=${chain_in%%:*}; chain=${chain_in#*:}
    while read -r rule; do
      [[ -n "$rule" ]] && iptables ${rule/-A /-D } 2>/dev/null || true
    done < <(iptables -S "$parent" 2>/dev/null | grep -- "-j $chain\$" || true)
  done
  for c in "$CHAIN" "$CHAIN-IN"; do
    iptables -F "$c" 2>/dev/null || true
    iptables -X "$c" 2>/dev/null || true
  done
  if command -v ip6tables >/dev/null; then
    ip6tables -D FORWARD -i "$PREFIX" -j DROP 2>/dev/null || true
    ip6tables -D INPUT -i "$PREFIX" -j DROP 2>/dev/null || true
  fi
}

case "${1:-}" in
  --remove)
    remove
    echo "已删除内核防火墙规则"
    exit 0
    ;;
  --status)
    iptables -S "$CHAIN" 2>/dev/null || echo "（没有 $CHAIN 链）"
    iptables -S "$CHAIN-IN" 2>/dev/null || true
    iptables -S DOCKER-USER | grep -- "$CHAIN" || true
    iptables -S INPUT | grep -- "$CHAIN" || true
    exit 0
    ;;
esac

remove
iptables -N DOCKER-USER 2>/dev/null || true

# ---- 网桥内转发：只允许新连接打到内核网关端口
iptables -N "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CHAIN" -p tcp --dport 8888 -j RETURN
iptables -A "$CHAIN" -p tcp --dport 3128 -j RETURN
iptables -A "$CHAIN" -j DROP

# ---- 发给宿主机本身：只允许回包
iptables -N "$CHAIN-IN"
iptables -A "$CHAIN-IN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CHAIN-IN" -j DROP

for i in $(ifaces); do
  iptables -I DOCKER-USER 1 -i "$i" -j "$CHAIN"
  iptables -I INPUT 1 -i "$i" -j "$CHAIN-IN"
done

if command -v ip6tables >/dev/null; then
  ip6tables -I FORWARD 1 -i "$PREFIX" -j DROP 2>/dev/null || true
  ip6tables -I INPUT 1 -i "$PREFIX" -j DROP 2>/dev/null || true
fi

echo "内核防火墙已生效（网卡：$(ifaces | tr '\n' ' ')）"
