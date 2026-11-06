# 部署（自托管，单台 Linux 服务器）

脚本按 Ubuntu / Debian（apt、ufw、systemd）编写；其他发行版可手动安装 Docker 与反向代理后直接用 `docker compose`。`APP_ROOT` 默认 `/opt/yanxie`，可通过环境变量改成任意目录（下文路径相应替换）。

链路：反向代理（对外 `PUBLIC_PORT`）→ `127.0.0.1:APP_PORT` 上的 `app` 容器（Node 后端，同时托管前端构建产物；WebSocket 路径 `/ws`、`/collab`）→ `db` 容器（PostgreSQL 16，命名卷 `pgdata`）。上传文件在命名卷 `storage`（容器内 `/data/storage`）。

反向代理由 `proxy.sh` 自动选择：机器上 nginx 在运行就新增一个独立站点 `/etc/nginx/sites-available/srh.conf`（只监听 `PUBLIC_PORT`，变量名带 `srh_` 前缀，`nginx -t` 失败自动回滚），否则安装 Caddy。所以这套脚本可以放在已经跑着其他服务的机器上，不会改动别的站点。

| 文件 | 作用 |
| --- | --- |
| `bootstrap-server.sh` | 初始化服务器，可重复执行 |
| `deploy.sh` | 部署 / 更新，可重复执行 |
| `proxy.sh` | 安装 / 刷新反向代理配置（deploy.sh 会自动调用） |
| `backup.sh` | 备份数据库和上传文件 |
| `nginx/srh.conf.template`、`Caddyfile` | 反向代理模板，`__PUBLIC_PORT__`、`__APP_PORT__` 由 .env 填入 |

服务器上的目录：

| 路径 | 用途 |
| --- | --- |
| `/opt/yanxie/app` | 仓库检出（由 `deploy.sh` 管理，不要手改） |
| `/opt/yanxie/.env` | 生产环境变量，只在服务器上，权限 600；`app/.env` 是指向它的软链 |
| `/opt/yanxie/backups` | 数据库与文件备份，保留 14 天 |
| `/opt/yanxie/deploy-history.log` | 每次成功部署的时间和提交 |

## 第一次

```bash
# root 登录服务器，下载初始化脚本；先把域名 A 记录指向这台服务器
curl -fsSLO https://raw.githubusercontent.com/likangxian1007/yanxie/main/deploy/bootstrap-server.sh
DOMAIN=lab.example.com bash bootstrap-server.sh
# 默认克隆公开仓库；用自己的 fork 时加 REPO_URL=https://github.com/<your-org>/yanxie.git
# 暂时没有域名：去掉 DOMAIN，按 http://服务器IP 访问；端口被占时加 PUBLIC_PORT=8088 APP_PORT=18787
# 私有仓库：REPO_URL 用 SSH 地址，并先为 root 配好对该仓库有只读权限的 SSH key（如 GitHub Deploy key）
nano /opt/yanxie/.env          # 填 LLM_API_KEY（DeepSeek）
bash /opt/yanxie/tools/deploy/deploy.sh
```

`bootstrap-server.sh` 做的事：缺 Docker/Compose 才装；没有 swap 才建；ufw 未启用时放行 22/80/443 并启用，已启用时追加 22 和对外端口（`PUBLIC_PORT=80` 时为 80/443）；设置了 `REPO_URL` 时克隆仓库到 `/opt/yanxie/app`；生成 `.env`（随机 `SESSION_SECRET` 和数据库密码）；配置反向代理；写入每日 03:30 备份的 cron。已经存在的 `.env` 不会被覆盖。

## 更新

```bash
bash /opt/yanxie/tools/deploy/deploy.sh            # 部署 origin/main 最新提交
bash /opt/yanxie/tools/deploy/deploy.sh <分支或提交>
```

入口用 `tools/deploy` 下的副本而不是 `app/deploy`：上一次部署的提交里如果没有 `deploy/`（比如试部署一个应用分支），`app/deploy` 就不存在，副本始终在。

流程：加锁 → `git fetch` 并切到目标提交 → 已有数据库时先备份 → `docker compose build --pull` → `up -d --remove-orphans`（`DB_AUTO_MIGRATE=true` 时应用启动自动迁移；也可设 `MIGRATE_CMD="node dist/migrate.js"` 显式执行）→ 轮询 `GET /api/health` → 刷新反向代理 → 清理本项目的悬空镜像。失败时打印容器状态和最近日志并以非 0 退出。

## 文献库的论文解析（GROBID）

`docker-compose.yml` 里的 `grobid` 服务（`grobid/grobid:0.9.1-crf`，纯 CPU，镜像约 510 MB 压缩 / 1.7 GB 解压）负责论文版面解析，`deploy.sh` 会和 app 一起拉起，第一次部署要多下载一次镜像。应用通过 `http://grobid:8070` 访问它，不对外暴露端口。

- 内存：CRF 模型启动时全部预加载（主要是堆外内存，`-Xmx` 只管 768 MB 的堆），空闲时就占约 2.9 GB。默认 `mem_limit` 4g、`memswap_limit` 5g。在一台 7.4 GB 的机器上实测过 3g 硬上限：容器空闲时贴着 2.99/3 GiB 反复换页，整机 load 到 8、iowait 50%，所以默认值改成了 4g。2g 加 swap 余量也能跑，但常驻会有约 1.2 GB 被换出。**2.5 GB 硬上限且不允许 swap 会在启动时被 OOM 杀掉**。内存紧时在 `.env` 里设 `GROBID_MEM_LIMIT=2g`、`GROBID_MEMSWAP_LIMIT=4g`（机器上要有 swap）。
- 速度：15 页论文冷启动后第一篇约 45 s，之后每篇约 6 s。应用的解析队列一次只送一篇，所以调低 GROBID 自身的并发并不能省内存。
- 可选：不想跑 GROBID 时，删掉 compose 里的 `grobid` 服务（或把 `GROBID_URL` 指向别处）。连不上时论文会降级为逐页纯文本，界面上有提示，服务恢复后在论文页点“重新解析”。
- 建议在 `.env` 里填 `CROSSREF_MAILTO=你的邮箱`，这样访问 Crossref、OpenAlex 和 arXiv 时会走礼貌通道。

## 备份与恢复

每天 03:30 由 `/etc/cron.d/srh-backup` 运行 `backup.sh`，日志在 `/var/log/srh-backup.log`。手动：`bash /opt/yanxie/tools/deploy/backup.sh`。

`/opt/yanxie/tools/deploy` 是部署工具的副本，每次部署自动刷新；当要部署的提交里没有 `deploy/` 目录时（比如临时验证某个应用分支：`deploy.sh feat/xxx`），`deploy.sh` 会改用这份副本。

```bash
cd /opt/yanxie/app
# 恢复数据库
docker compose -p srh --env-file /opt/yanxie/.env exec -T db \
  pg_restore -U srh -d srh --clean --if-exists < /opt/yanxie/backups/db-YYYYMMDD-HHMMSS.dump
# 恢复上传文件
docker compose -p srh --env-file /opt/yanxie/.env exec -T app tar -C /data -xzf - < /opt/yanxie/backups/files-YYYYMMDD-HHMMSS.tar.gz
```

## 常用

```bash
cd /opt/yanxie/app
docker compose -p srh --env-file /opt/yanxie/.env ps
docker compose -p srh --env-file /opt/yanxie/.env logs -f app
tail -f /var/log/nginx/srh.error.log
```

## 绑定域名

nginx：在 `nginx/srh.conf.template` 旁边加一个带 `server_name 域名;` 的 server 块（经 Cloudflare 时可只监听 80，由 Cloudflare 提供 HTTPS）；Caddy：在 `.env` 里设 `DOMAIN=域名`，`proxy.sh` 会把它作为站点地址，自动签发 HTTPS。然后把 `.env` 的 `PUBLIC_URL` 改为 `https://域名`，再跑一次 `deploy.sh`。

### 挂在子路径下（可选，默认根路径）

和别的站点共用一个域名、把平台放在 `https://域名/app/` 时，前端要在构建时知道这个前缀（资源、路由、API、WebSocket 都会带上它），服务端不用改：

```bash
# /opt/yanxie/.env
WEB_BASE_PATH=/app/
PUBLIC_URL=https://域名/app
```

也可以临时用环境变量覆盖：`WEB_BASE_PATH=/app/ bash deploy.sh`（优先于 `.env`）。它经 `docker-compose.yml` 作为构建参数 `VITE_BASE_PATH` 传给 `Dockerfile`，改了要重新跑 `deploy.sh` 才会生效。

反向代理负责剥掉前缀再转给应用，Caddy 示例：

```caddyfile
域名 {
	redir /app /app/
	handle_path /app/* {
		reverse_proxy 127.0.0.1:8787
	}
	# 其他站点的 handle …
}
```

`PUBLIC_URL` 要写成带前缀的 `https://域名/app`（结尾不加斜杠），通知里的链接和 WebSocket 来源检查都靠它。

## Notebook 内核隔离

云电脑功能已移除，不再构建桌面镜像或启用 DESKTOP 配置。Docker 代理仍供 Notebook 内核使用。历史桌面容器与卷的清理由管理员在独立维护操作中处理。

Notebook 内核的网络规则在 `deploy/kernel-firewall.sh`：内核只能被 app 连到 :8888，不能主动连 app、别的容器或宿主机端口（内核网络本身是 internal，没有外网）。`deploy.sh` 每次部署后自动执行；需要开机持久化时，使用在 Docker 启动后运行的 oneshot 服务，单元名 `srh-kernel-firewall`，`ExecStart=/bin/bash /opt/yanxie/tools/deploy/kernel-firewall.sh`。查看：`bash deploy/kernel-firewall.sh --status`。

内核里的 `pip install` 走 Compose 服务 `pypi-proxy`（`deploy/pypi-proxy`，tinyproxy 白名单只有 `pypi.org`、`files.pythonhosted.org`，其他域名返回 403）。app 起内核时把它接入该项目的 internal 内核网络（别名 `pypi-proxy`）并注入 `HTTP(S)_PROXY`；内核网络本身仍没有外网。要加镜像或别的域名，改 `deploy/pypi-proxy/filter` 后重新部署。想完全断网：`.env` 里设 `KERNEL_PIP_PROXY_CONTAINER=`（空）。
## 接入：API 令牌（可选，默认关）

给外部 agent / 脚本用的「门禁卡」（API.md §2.21）。代码默认关闭，打开后在「设置 → 接入」里生成令牌：

```bash
# /opt/yanxie/.env
API_TOKENS_ENABLED=true
# 每张令牌每分钟的调用上限（默认 120）
API_TOKENS_RATE_PER_MINUTE=120
bash /opt/yanxie/tools/deploy/deploy.sh
```

用法：

```bash
curl -s https://你的站点/api/v1/projects -H "Authorization: Bearer srh_pat_…"
```

令牌和本人登录等效（权限仍按角色 / 项目成员计算），可以限项目、设过期、只给只读。库里只存 SHA-256，原文只在生成时显示一次，丢了只能重新生成。关闭：`API_TOKENS_ENABLED=false` 再部署，所有令牌立刻失效，网页登录不受影响；已生成的令牌仍可在设置里撤销。

### 让 AI agent 用 MCP 接进来（可选，默认关）

上面那张令牌也能当 MCP 凭证用（API.md §2.22）：外部 agent 填「地址 + 令牌」就能读写，不用自己写命令。**需要同时打开两个开关**：

```bash
# /opt/yanxie/.env
API_TOKENS_ENABLED=true
MCP_ENABLED=true
# 每张令牌每天的写操作上限（默认 200），防 agent 死循环刷屏
MCP_WRITE_PER_DAY=200
bash /opt/yanxie/tools/deploy/deploy.sh
```

客户端（dots / Cursor 这类）填：

```json
{
  "mcpServers": {
    "研协": {
      "type": "http",
      "url": "https://你的站点/api/v1/mcp",
      "headers": { "Authorization": "Bearer srh_pat_…" }
    }
  }
}
```

「设置 → 接入」里有一段同样内容、带复制按钮（开关打开后才显示）。只读令牌接进去只能看；写操作有每日上限。关闭：`MCP_ENABLED=false` 再部署，`/api/v1/mcp` 全部 403，REST 与网页不受影响。

### 通知群机器人（可选，默认关）

把项目里的事推到自己的飞书 / 企业微信 / 钉钉群（API.md §2.23）。代码默认关闭：

```bash
# /opt/yanxie/.env
NOTIFY_ENABLED=true
# 每人最多几个订阅（默认 3）
NOTIFY_MAX_PER_USER=3
bash /opt/yanxie/tools/deploy/deploy.sh
```

用法：群设置 → 群机器人 → 添加 → **自定义机器人** → 复制它给的 webhook 地址 → 填进「设置 → 通知」。

**支持范围**：本版只支持**自定义机器人（群 Webhook）**，即"往机器人所在的那一个群推送"。**不支持**应用机器人（企业自建应用：单聊、按 `open_id`/`chat_id` 定向发送，需要 `app_id`+`app_secret` 换令牌）——**按当前范围不做**。三家都只验证过请求格式，**真机验证只有飞书**（企业微信、钉钉缺可用凭据，未验证）。

- 只接受三家官方域名（`open.feishu.cn` / `qyapi.weixin.qq.com` / `oapi.dingtalk.com`）的 `https` 地址，其它一律拒绝。
- 地址里的密钥只写不读，接口只显示打码版；日志里也不打印完整地址。
- 只发**「【研协】+ 事件说明 + 链接」**，**不发正文片段**（收件箱标题里的原文摘录也不会外发）；旁聊、个人线程、别人的收件箱不会外发；被移出项目后待发的记录会终止。
- 成功判定看平台返回码（`code`/`StatusCode`/`errcode` 必须为 0），HTTP 200 不等于成功；失败按 1m/5m/30m/2h/6h 重试，5 次后放弃；连续失败 20 次自动停用该订阅并在主人收件箱提醒。
- **平台安全设置**：自定义关键词填 `研协`（消息前缀「【研协】」）；IP 白名单填**服务器出站公网 IP**；**签名校验本版未实现，开了会全部失败**，请改用关键词或 IP 白名单。
- 关闭：`NOTIFY_ENABLED=false` 再部署，不再推送（REST 与网页不受影响）。

## 邮件（找回密码）

登录页「忘记密码？」会发一封重置邮件（API.md §2.1）。发信方式只看环境变量，按顺序选第一个配好的：

1. `RESEND_API_KEY` 有值 → 走 Resend HTTP API；
2. `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS` 都有值 → 走 SMTP（nodemailer）；
3. 都没配 → 不发信，只把重置链接写进服务端日志（接口照样返回同一句成功，方便本地调试）。

以任意支持 587 + STARTTLS 的 SMTP 中继为例：

```bash
# /opt/yanxie/.env
MAIL_FROM="研协 <no-reply@example.com>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=<SMTP 登录名>
SMTP_PASS=<SMTP 密码或 key>
# 默认值即可：587 强制 STARTTLS，服务器不支持就拒绝发送，不会降级成明文
# SMTP_SECURE=
# SMTP_STARTTLS=true
bash /opt/yanxie/tools/deploy/deploy.sh
```

| 变量             | 默认                         | 说明                                                                                         |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `MAIL_FROM`      | `研协 <no-reply@example.com>` | 发件人；域名要在发信服务里验证过（SPF / DKIM）                                               |
| `RESEND_API_KEY` | 空                           | 设置后优先走 Resend，SMTP 配置被忽略                                                         |
| `SMTP_HOST`      | 空                           | 如 `smtp.example.com`                                                                    |
| `SMTP_PORT`      | `587`                        | 465 时默认直连 TLS                                                                           |
| `SMTP_USER`      | 空                           |                                                                                              |
| `SMTP_PASS`      | 空                           | 只放 `.env`，不要提交                                                                        |
| `SMTP_SECURE`    | 空（按端口推断）             | `true` 直连 TLS（通常 465），`false` 先明文连接再看 `SMTP_STARTTLS`                         |
| `SMTP_STARTTLS`  | `true`                       | 非直连 TLS 时是否强制 STARTTLS；`false` 不升级加密，只用于内网中继                           |

- 重置链接是 `${PUBLIC_URL}/reset-password?token=…`，**`PUBLIC_URL` 必须是对外域名**（例如 `https://yanxie.example.com`，挂子路径时为 `https://example.com/app`，不带结尾斜杠），不要填服务器 IP。
- 链接 30 分钟内有效、只能用一次；新的申请会作废之前的链接；重置成功后该账号所有登录会话失效。
- 限流：同一邮箱 15 分钟内最多 3 次、同一 IP 15 分钟内最多 20 次，超出 429。不管邮箱是否注册，响应都一样。
- 发信在后台进行、不阻塞接口；失败只写 warn 日志（`[mail] 发送失败`），可用 `docker compose logs server | grep mail` 排查。
