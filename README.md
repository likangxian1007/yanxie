# 研协 · Scientific Research Harness

> **English summary.** 研协 (Yanxie) is a self-hostable, multi-user AI agent platform for research teams. Each project shares a _coordinator_ agent that splits work into parallel threads; members get private workspaces, review/LGTM checkpoints, auto-generated group-meeting reports, real-time collaborative docs / LaTeX / sheets / slides, a paper library with GROBID parsing, research spaces with notebooks, kanban/todos and academic web search. DeepSeek is the default model provider (OpenRouter or any OpenAI-compatible endpoint optional). UI in Chinese and English. Licensed under Apache-2.0. Quick start: `pnpm install && cp .env.example .env && pnpm dev`, then open http://localhost:5173.

面向科研团队的多人协同 AI Agent 平台，可以部署在课题组自己的服务器上，消息、文档和研究记录都留在你们自己的数据库里。

## 功能

- **协调者拆线程并行**：一个项目共用一个协调者，它把需求拆成多个线程交给 agent 并行推进。
- **我的工作区与转发**：每人有私有会话，想法成熟后转发给协调者。
- **审阅 / LGTM**：导师直接看协调者的思路、研究空间和 agent 的改动，在关键节点审阅放行。
- **组会汇报生成**：从项目上下文直接生成组会汇报。
- **多人实时协同**：文档、LaTeX、表格、幻灯片多人同时编辑（Yjs）。
- **文献库与论文解析**：导入 PDF，用 GROBID 解析版面，标注、笔记、问答。
- **研究空间与 Notebook**：记录研究过程与证据，在隔离容器里运行 Python Notebook。
- **看板与待办**。
- **联网学术检索**：自托管 SearXNG + Crossref / OpenAlex / arXiv。
- **多模型**：默认 DeepSeek；可选 OpenRouter，或自配任意 OpenAI 兼容服务。
- **中英切换**：界面与服务端文案都支持中文 / English。
- **MCP / API 令牌接入**：外部 agent、脚本用令牌通过 REST 或 MCP 读写（默认关）。
- **可选计费**：按用量扣点数（默认关）。

## 本地快速开始

需要 Node ≥ 22.12（推荐 24）和 pnpm 11（`corepack enable`）。本地不需要 Docker 或 Postgres（默认用嵌入式 PGlite）。

```bash
pnpm install
cp .env.example .env     # 至少填 LLM_API_KEY（DeepSeek key）；不填也能启动，只是 agent 不回复
pnpm dev                 # 后端 :8787，前端 :5173
```

打开 http://localhost:5173 注册账号即可使用。注册对所有人开放，**第一个用户不会自动成为管理员**；要用管理后台，把你的邮箱写进 `.env` 的 `ADMIN_EMAILS`（逗号分隔），重启后登录即生效。

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env：POSTGRES_PASSWORD、SESSION_SECRET（openssl rand -hex 32）、LLM_API_KEY、PUBLIC_URL（对外地址）
docker build -t srh-kernel:latest deploy/kernel     # Notebook 内核镜像；不需要 Notebook 就在 .env 设 KERNEL_MODE=none
docker compose --env-file .env up -d --build
```

Compose 会启动 app、PostgreSQL、SearXNG、GROBID、pypi 代理和 Docker API 代理；应用只监听 `127.0.0.1:${APP_PORT:-8787}`，请用 Caddy / Nginx 反向代理并透传 `/ws`、`/collab` 的 WebSocket。完整的单机部署脚本（反向代理、备份、更新）见 [deploy/README.md](deploy/README.md)。

## 主要环境变量

完整列表与说明见 [.env.example](.env.example)。

| 变量                                      | 说明                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| `LLM_API_KEY` / `LLM_BASE_URL`            | 默认模型服务（DeepSeek，或任意 OpenAI 兼容地址）                |
| `OPENROUTER_API_KEY`                      | 可选，启用 OpenRouter 上的更多模型                              |
| `SESSION_SECRET`                          | 会话签名密钥，生产必须是 32 位以上随机串                        |
| `DATABASE_URL`                            | 留空 = 嵌入式 PGlite；生产用 `postgres://…`（Compose 自动设置） |
| `POSTGRES_PASSWORD`                       | Docker 部署时的数据库密码                                       |
| `PUBLIC_URL`                              | 对外访问地址，用于邮件链接和 WebSocket 来源检查                 |
| `ADMIN_EMAILS`                            | 自动成为管理员的邮箱                                            |
| `KERNEL_MODE`                             | `none` / `gateway` / `docker`，Notebook 内核                    |
| `AGENT_WEB` / `SEARXNG_URL`               | 联网检索                                                        |
| `GROBID_URL`                              | 论文解析服务                                                    |
| `SMTP_*` / `RESEND_API_KEY` / `MAIL_FROM` | 找回密码邮件；不配则只把链接写进日志                            |
| `API_TOKENS_ENABLED` / `MCP_ENABLED`      | API 令牌与 MCP 接入（默认关）                                   |
| `BILLING_ENABLED`                         | 计费（默认关）                                                  |

## 目录结构

```
apps/server      Fastify 后端：REST / WebSocket / Yjs 协同、agent 运行时、迁移（drizzle/）
apps/web         React + Vite 前端
apps/landing     产品介绍页
packages/shared  前后端共享的类型、zod schema 与 i18n 工具（tr / trServer）
tools/           i18n 等维护脚本
deploy/          自托管部署脚本、内核镜像、SearXNG / GROBID 配置
docs/            设计与调研文档
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：架构、模块归属、一致性设计
- [API.md](API.md)：REST / WebSocket / 事件契约
- [STYLE.md](STYLE.md)：界面规范
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献指南（fork + PR、`pnpm check`、i18n）
- [AGENTS.md](AGENTS.md)：给 AI agent 的守则
- [deploy/README.md](deploy/README.md)：自托管部署

## 许可证

[Apache License 2.0](LICENSE) © 2026 研协 contributors
