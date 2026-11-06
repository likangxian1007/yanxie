#!/bin/sh
# 内核容器入口：把研协的 IPython 启动脚本放进当前 IPYTHONDIR 的 profile_default/startup，再启动网关。
# 运行时根文件系统只读，IPYTHONDIR 在 /tmp（tmpfs，每次容器启动都是空的），所以每次启动都要复制。
set -e
dir="${IPYTHONDIR:-$HOME/.ipython}/profile_default/startup"
if mkdir -p "$dir" 2>/dev/null; then
  cp /usr/local/share/srh/ipython-startup/*.py "$dir"/ 2>/dev/null || true
fi
# pip 装到 ~/.local（项目数据卷）。目录在 Python 启动前就要存在，否则第一次 pip install 后要重启内核才 import 得到
mkdir -p "$(python -m site --user-site)" 2>/dev/null || true
exec "$@"
