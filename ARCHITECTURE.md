# ARCHITECTURE.md · 研协（Scientific Research Harness）

> 面向科研团队的多人协同 AI Agent 平台：一个项目共用一个**协调者**（coordinator agent），它把需求拆成**线程**交给 agent 并行推进；每人还有**我的工作区**，私有会话可一键**转发给协调者**；导师和师兄直接看协调者里的思路、实验记录和 agent 的改动，在关键节点**审阅 / LGTM**；组会从上下文直接生成**汇报**；文档多人实时同步编辑，配**看板**、**待办**、**实验记录**。
>
> 本文是所有后续线程的契约。接口细节见 [API.md](API.md)，界面规范见 [STYLE.md](STYLE.md)，agent 提示词见 [`apps/server/prompts/`](apps/server/prompts/)。

## 1. 技术栈与取舍

| 层         | 选型                                                                                                                                                               | 理由                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库       | pnpm workspace monorepo（`apps/web`、`apps/server`、`packages/shared`）                                                                                            | 前后端共享类型和 zod 校验，一处改两边报错                                                                                                                                 |
| 前端       | React 19 + Vite 8 + Tailwind CSS 4（CSS-first `@theme`）+ Motion（原 Framer Motion，`motion/react`）+ React Router 8 + TanStack Query 5 + Zustand 5 + lucide-react | 主流、AI 熟悉、动画能力强；Tailwind 语义 token 让多线程生成的 UI 保持一致                                                                                                 |
| 后端       | Node 24 + Fastify 5 + @fastify/websocket                                                                                                                           | 比 Express 快、插件化、自带 `inject`/`injectWS` 便于测试                                                                                                                  |
| 数据库     | PostgreSQL 16 + Drizzle ORM（迁移用 drizzle-kit）                                                                                                                  | 类型安全的 SQL，迁移是纯 SQL 文件，可审阅                                                                                                                                 |
| 本地数据库 | **PGlite**（WASM 版 Postgres，嵌入进程）                                                                                                                           | **对默认方案的调整**：本机没有 Docker 也能 `pnpm dev` 一键跑起来；与生产同一套 schema、同一套 SQL 方言。`DATABASE_URL` 为空即用 PGlite，填 `postgres://…` 即用真 Postgres |
| 协同文档   | Yjs + Hocuspocus（`/collab` WebSocket）                                                                                                                            | CRDT 自动合并多人与 agent 的并发编辑；Hocuspocus 负责同步、awareness、持久化钩子                                                                                          |
| 实时事件   | 自研 `/ws`：事件表 `events` + 进程内总线                                                                                                                           | 断线按 `seq` 补发；agent 唤醒与前端推送读同一张表（见 §5）                                                                                                                |
| LLM        | DeepSeek（OpenAI 兼容接口，`openai` SDK）+ provider 注册表                                                                                                         | 默认 `deepseek-flash`，可切 `deepseek-v4-pro`；推理强度 off/low/high/max。自部署可经 `.env`（`LLM_PROVIDERS`）或设置页接入更多 OpenAI 兼容模型，每个会话各自选（§7.6）    |
| 部署       | 单镜像（Node 同时托管前端构建产物）+ Postgres，Docker Compose；宿主机 Caddy 反代                                                                                   | 自托管一条命令；也能直接作为公共站点使用，纯 web 端                                                                                                                       |

不做的（v1）：agent 执行任意代码的沙箱（科研计算先通过上传结果文件 + 实验记录承载；沙箱作为后续扩展点 `agents/tools/sandbox`）、多实例水平扩展（总线换 Postgres `LISTEN/NOTIFY` 即可，调用方不变）。

## 2. 目录结构与归属

```
.
├── STYLE.md / ARCHITECTURE.md / API.md     契约文档（改动需在 PR 里说明）
├── docker-compose.yml / Dockerfile          部署（服务器侧脚本在 deploy/，由部署线程维护）
├── packages/shared/src/                     前后端共享（契约代码）
│   ├── ids.ts        ID 规则（前缀 + ULID）
│   ├── enums.ts      所有枚举（角色、状态、类型）
│   ├── entities.ts   实体 DTO（REST 响应、事件 payload 的形状）
│   ├── api.ts        REST 请求体 zod schema、分页、HealthResponse
│   ├── events.ts     项目事件类型表 EVENT_PAYLOADS、瞬时事件
│   ├── ws.ts         /ws 协议帧 ClientFrame / ServerFrame
│   ├── errors.ts     错误码与 ApiError
│   └── format.ts     状态清单解析、中文相对时间
├── apps/server/
│   ├── drizzle/                 SQL 迁移（drizzle-kit 生成，勿手改已合并的文件）
│   ├── prompts/                 agent 提示词（Markdown，见 §7）
│   └── src/
│       ├── index.ts             进程入口（连库、迁移、listen、优雅退出；agent 运行时在此接入）
│       ├── app.ts               组装 Fastify（不 listen），测试直接用
│       ├── config.ts            环境变量唯一读取点
│       ├── context.ts           AppContext（app.ctx：config、db、bus、access）
│       ├── db/                  client.ts（postgres/pglite 双驱动）、schema/{core,agents,collab}.ts、migrate
│       ├── lib/http.ts          parse()（zod 校验）、统一错误处理
│       ├── realtime/            bus.ts（事件总线）、ws.ts（/ws）、collab.ts（/collab）、access.ts（鉴权钩子）
│       ├── modules/<name>/      业务模块，每个导出 ModuleDef，已在 modules/index.ts 全部登记
│       ├── websearch/           联网搜索：公网守卫、SearXNG、学术检索、正文抽取（§12）
│       └── agents/              llm/（客户端 + registry.ts 模型路由）、runtime/（turn 调度）、tools/（工具实现）、
│                                mcp/（MCP 客户端池）、harness/（profile / skill / 目标 / 斜杠指令进 turn，§7.6）
└── apps/web/src/
    ├── app/                     router.tsx（已汇总所有 feature 路由）、providers、App
    ├── styles/                  tokens.css（唯一色值来源）、index.css（Tailwind @theme 映射与动画）
    ├── lib/                     api.ts、ws.ts（RealtimeClient）、motion.ts（动效预设）、query.ts、theme.ts
    ├── components/ui/           基础组件（Button、Avatar、StatusDot、AgentThinking…）
    ├── components/layout/       AppShell、Sidebar、Topbar、RightPanel
    └── features/<name>/         页面与该功能专属组件，每个 feature 只通过自己的 routes.tsx 注册
```

### 2.1 并行开发的落点（谁改哪里）

| 线程                  | 拥有（可自由改）                                                                                                                                                                                                                                                      | 只新增、不改已有                                                                                                                   | 不碰                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **后端与 agent 引擎** | `apps/server/src/modules/{auth,projects,timeline,threads,agents,memory,claims,routines,files,inbox}`、`apps/server/src/agents/**`、`apps/server/src/realtime/access.ts`、`src/index.ts` 中接入 runtime 的部分、`db/schema/{core,agents}.ts`、`apps/server/prompts/**` | `packages/shared/src/{entities,api,events}.ts`（只追加）                                                                           | `apps/web/**`、协作模块                                          |
| **前端全部页面**      | `apps/web/src/{app,lib,components,styles}`、`apps/web/src/features/{coordinator,workspace,threads,inbox,settings}`                                                                                                                                                    | `packages/shared/src/format.ts` 等纯函数                                                                                           | `apps/server/**`、协作 feature 目录                              |
| **协作功能**          | `apps/server/src/modules/{documents,boards,todos,experiments,reviews,reports}`、`apps/server/src/realtime/collab.ts`、`db/schema/collab.ts`、`apps/web/src/features/{docs,board,todos,experiments,reviews,reports}`                                                   | `apps/web/src/components/ui/`（新组件新文件；已有组件的改动请交给前端线程）、`packages/shared/src/{entities,api,events}-collab.ts` | 其他模块目录                                                     |
| **反馈与运维**        | `apps/server/src/modules/{feedback,admin}`、`apps/server/src/lib/ops-events.ts`、`db/schema/feedback.ts`、`modules/integrations/catalog-feedback-interactive.ts`                                                                                                      | `packages/shared/src/feedback.ts`（只追加）；`config.ADMIN_EMAILS`、`modules/auth` 管理员提升                                      | `apps/web/**`（前端另行实现）                                    |
| **计费与充值**        | `apps/server/src/modules/billing`（`service.ts` 唯一扣费点、`pricing.ts`、`kyren.ts`、`topup.ts`）、`db/schema/billing.ts`、`apps/web/src/features/billing`                                                                                                           | `packages/shared/src/billing.ts`（只追加）；`agents/llm/{registry,complete}.ts`、`modules/collab-common/llm.ts` 的计费钩子         | 项目自配 provider（永不计费）                                    |
| **部署**              | `deploy/**`                                                                                                                                                                                                                                                           | —                                                                                                                                  | 应用代码；`docker-compose.yml`/`Dockerfile` 如需改动在 PR 里说明 |

**harness 能力**（模型、MCP、skill、斜杠指令、profile，2026-10-26 新增）：`apps/server/src/agents/{llm/registry.ts,mcp,harness}`、`apps/server/src/modules/harness`、`db/schema/harness.ts`、`packages/shared/src/harness.ts`、`apps/web/src/features/harness`、`apps/web/src/features/settings/components/harness`、`apps/web/src/lib/harness.ts`；输入框（`components/chat/Composer.tsx`）只接入菜单与选择器，布局归前端线程。

共享文件（`packages/shared`、三份契约文档、`modules/index.ts`、`app/router.tsx`、`db/schema/index.ts`）：脚手架已经把所有落点登记好，正常开发不需要改它们；确需改动时**只追加**，并在 PR 描述里写明，合并时以 main 为准 rebase。`packages/shared` 已按归属拆成两组文件（后端：`entities.ts`/`api.ts`/`events.ts`；协作：`*-collab.ts`），`events.ts` 自动合并两边的事件表，所以两个线程不会在同一处追加。

依赖：各线程需要新依赖时自己 `pnpm --filter <包> add`；`pnpm-lock.yaml` 冲突时不要手工合并，rebase 后直接 `pnpm install` 重新生成再提交。预计会加的：后端 `@fastify/multipart`、密码哈希库；协作 `@hocuspocus/provider` 与编辑器（装在 `apps/web`，属于协作线程的例外，PR 里说明）。

## 3. 本地运行

```bash
pnpm install
cp .env.example .env         # 可选；不填 DATABASE_URL 就用嵌入式 PGlite，数据在 apps/server/.data/pglite
pnpm dev                     # 并行启动 server(:8787) 与 web(:5173)，web 代理 /api /ws /collab
pnpm check                   # lint + typecheck + test
pnpm db:generate             # 改 schema 后生成迁移
```

服务启动时 `DB_AUTO_MIGRATE=true` 自动执行迁移。健康检查：`GET /api/health`。

## 4. 数据模型

所有主键为 `<前缀>_<ULID>`（`@srh/shared` 的 `newId`），可按时间排序，直接当分页游标。时间一律 `timestamptz`，接口输出 ISO 字符串。作者/操作者统一用 `ActorRef { kind: user|agent|system, id, name }` 冗余存储。

### 4.1 核心（`db/schema/core.ts`）

| 表                | 关键字段                                            | 说明                                                      |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `users`           | email(唯一), name, password_hash, avatar_color(0–7) | 头像色对应 STYLE.md 色板                                  |
| `auth_sessions`   | user_id, token_hash, expires_at                     | Cookie 里放原 token，库里只存 SHA-256                     |
| `projects`        | name, icon, color, instructions, visibility         | `instructions` = 项目级 agent 指令                        |
| `project_members` | (project_id, user_id), role                         | 角色见 §9                                                 |
| `invites`         | token, role, email?, expires_at                     | 邀请链接                                                  |
| `files`           | project_id, path(项目内唯一), mime, size            | 本体在 `STORAGE_DIR/<projectId>/<path>`，即项目共享文件夹 |
| `inbox_items`     | user_id, kind, title, href, source_id, done_at      | “待我处理”，按 `INBOX_PRIORITY` 排序                      |

### 4.2 会话与 agent（`db/schema/agents.ts`）

| 表               | 关键字段                                                                                                                                                                                      | 说明                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `messages`       | project_id, thread_id(null=时间线), author_kind/id/name, kind, body, meta, agent_visible                                                                                                      | 追加型；`agent_visible=false` 为旁聊，agent 永远读不到                                        |
| `threads`        | kind(project/personal), root_message_id(唯一), title, label, owner_user_id, status_bucket, status_text, resolved, forwarded_at                                                                | 根消息唯一约束保证“同一条消息只开一个线程”（幂等）                                            |
| `agent_sessions` | role(coordinator/thread/personal), thread_id(唯一), status, activity, working_for_user_id, last_event_seq, context_summary, token_usage, locked_by/locked_until, model, effort, profile, goal | 一个项目一个 coordinator 会话；一个线程最多一个 agent 会话；model/effort/profile/goal 见 §7.6 |
| `agent_steps`    | session_id, turn_id, index, kind(thinking/text/tool_call/tool_result/note), content, data                                                                                                     | agent 的完整思路与工具调用，供导师审阅；给人看全量，给 agent 的上下文另行截断                 |
| `decisions`      | message_id, question, options[2–4], recommended, state, chosen, chosen_by                                                                                                                     | 决策卡；成员的选择优先于 agent 的记录                                                         |
| `reactions`      | (message_id, emoji, actor_id)                                                                                                                                                                 | 幂等                                                                                          |
| `outputs`        | thread_id, message_id, kind(file/link/document/experiment/report), ref, title                                                                                                                 | 消息上的产出卡片，汇总为资料库                                                                |
| `memory_files`   | (project_id, path) 唯一, description, type, content, version                                                                                                                                  | 项目记忆，乐观并发；`MEMORY.md` 为索引                                                        |
| `work_claims`    | resource_kind, resource_ref, mode, intent, holder, on_behalf_of_user_id, status, expires_at                                                                                                   | 认领与冲突预警，见 §5.3                                                                       |
| `routines`       | schedule(cron/every/at), prompt, target_thread_id, enabled                                                                                                                                    | 定时唤醒                                                                                      |
| `events`         | seq(bigserial), project_id, thread_id, type, payload, actor                                                                                                                                   | **所有写操作的唯一出口**，见 §5.1                                                             |

harness 表（`db/schema/harness.ts`，迁移 `0006_harness_capabilities`）：`llm_providers`（项目级 OpenAI 兼容服务：base_url、api_key、thinking_format、models[]）、`mcp_servers`（scope project/personal、transport stdio/http/sse、command/args/env 或 url/headers、enabled、disabled_tools、roles）、`skills`（slug、description、body、attachments、user/model_invocable）、`slash_commands`（自定义指令模板，`$ARGUMENTS`）、`agent_profiles`（科研 profile：prompt、常用 skill、建议强度、开场示例）。密钥类字段（api_key、env、headers）只写不读，接口只返回键名。

### 4.3 协作（`db/schema/collab.ts`）

| 表                                                    | 关键字段                                                                                         | 说明                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`                                           | parent_id(树), kind(doc/sheet/slides/latex), title, ydoc_state(bytea), content_text, archived_at | 正文是 Yjs 状态（四类文档的 Y.Doc 字段见 `@srh/shared` 的 `YDOC_FIELD` 与 API.md §2.7.1）；`content_text` 是正文的 markdown 表示（API.md §2.7.2），供搜索、汇报与 agent 读取 |
| `document_versions`                                   | document_id, label, ydoc_state                                                                   | 命名版本、可恢复                                                                                                                                                             |
| `boards` / `board_columns` / `cards`                  | position 为分数索引字符串；cards 带 thread_id、experiment_id、version                            | 看板；卡片乐观并发                                                                                                                                                           |
| `todos`                                               | owner_user_id(null=项目共享), assignee_id, done, priority, source                                | 待办；`source` 记录来源（如组会汇报拆出）                                                                                                                                    |
| `experiments`                                         | hypothesis, setup, status, metrics(jsonb), conclusion, tags, thread_id, version                  | 实验记录；乐观并发                                                                                                                                                           |
| `experiment_logs`                                     | experiment_id, author, body, attachments                                                         | 追加型实验日志（每次运行的原始数字只来自这里）                                                                                                                               |
| `reviews` / `review_participants` / `review_comments` | target_kind/target_id, status, verdict(pending/lgtm/changes_requested/commented), anchor         | 审阅与 LGTM；目标可以是线程、计划、文档、实验、汇报、产出                                                                                                                    |
| `reports`                                             | period_start/end, status(draft/generating/final), content(md), document_id                       | 组会汇报                                                                                                                                                                     |

### 4.4 文献库（`db/schema/library.ts`，API.md §2.15）

| 表             | 关键字段                                                                                                                                                                               | 说明                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `papers`       | project_id, title, authors(jsonb), year, doi / arxiv_id / citekey（项目内唯一索引）、url 与 pdf_sha256（导入时查重）、status、progress、parser、file_id、structure(jsonb)、meta(jsonb) | 元数据、解析状态与结构（章节、公式、图表、参考文献、KaTeX 宏）；PDF 本体存在项目共享文件夹的 `library/` 下 |
| `paper_chunks` | paper_id, seq, kind, section_path, page, para, boxes(jsonb), text                                                                                                                      | 一段一行，检索与引用的最小单位（`p.<page> ¶<para>`）；BM25 索引在进程内按项目缓存，不需要向量扩展          |

解析流水线（`modules/library/pipeline.ts`、`queue.ts`）：进程内队列，并发 1，暂时性错误重试；外部依赖（GROBID、arXiv、Crossref、OpenAlex、Semantic Scholar）集中在 `LibraryDeps`，测试里整体替换。版面解析用 GROBID（CRF 镜像，纯 CPU）。不选 MinerU / marker / Nougat，是因为部署机没有 GPU（4 vCPU / 7.4 GB），这几个在 CPU 上一篇要几分钟、镜像 10 GB 以上。arXiv 论文另外用 LaTeX 源码补公式。GROBID 不可达时降级为 pdf.js 逐页纯文本。

**L01 个人/项目归属扩展**：`papers` 与 `files` 的 `project_id` 改为可空，新增 `owner_user_id`，数据库 CHECK 约束两者恰有一个非空。已有行的项目归属、文件路径和引用不变；个人 DOI、arXiv ID 与 citekey 按所有者建立独立唯一索引。`paper_chunks.project_id` 可空，权限以所属 `papers` 行为准，段落检索通过父论文过滤归属，不能单靠段落表中的项目字段判断。

私人 PDF 保存于 `<STORAGE_DIR>/personal/<userId>/library/<fileId>/<filename>`；项目 PDF 保留原目录。个人下载经登录身份与归属检查，不开放私人文件的项目下载链接。`modules/library/scope.ts` 统一查询条件和缓存键，`storage.ts` 复用项目存储并提供无项目广播的私人 PDF 存储；个人解析任务和恢复队列携带其真实所有者，项目删除不会级联删除个人库。私人进度不进入项目事件，L02 页面需通过个人接口刷新。

**L07 / L11 追加（2026-10-31）**：`modules/library/publication.ts` 负责个人论文到项目的独立发布。使用项目行锁串行化同项目发布、源论文行锁固定复制快照，以及成员行共享锁保障提交时的权限。PDF 写入项目自己的 `library/<newFileId>/`；论文与段落使用新 ID，段落坐标和结构原样复制。数据库事务同时提交文件记录、论文、段落和事件，提交后才广播；失败回滚并清理本次新文件。磁盘与数据库不是一个事务，进程中断后的孤立文件清理仍属后续运维工作。私人笔记和其他阅读记录不参与本轮发布。

| 新表／字段                              | 作用与约束                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paper_publications`                    | 发布凭据：发布人、请求 UUID、目标项目／论文、源论文／文件标识、源更新时间、发布署名。发布人与 UUID 唯一；目标论文删除时置空，防重试复活。源标识无删除级联，原件删除后仍可核对既有发布；仅服务端保存，不通过团队 DTO 开放私人资源路径。 |
| `papers.title_version` / `tags_version` | 独立字段版本，初值 1；带基线的原子 UPDATE 防止同字段覆盖，不同字段互不阻塞。原 `note_version` 契约保留。                                                                                                                               |

迁移由 `pnpm db:generate --name library_publication_l07` 生成 `0022_library_account_collaboration.sql`，只追加表、索引、外键和默认列，不改论文归属。前端 `PublishPaperDialog` 展示复制范围并为一次发布固定请求编号；`PaperMetadataDialog` 保留打开时的字段版本与编辑草稿。项目事件使用现有 `paper.*` 和 `file.created`，不新增协议种类；列表／阅读页在重连后刷新，取消旧在途请求避免过时响应覆盖实时结果。`realtime/ws.ts` 在移除成员／归档项目时撤销订阅并关闭连接（4403），客户端清除对应缓存。L11 的后续阅读资料目录随 L03—L05 接入，正文共同编辑由 L12—L14 完成。

### 4.5 反馈与运维（`db/schema/feedback.ts`，API.md「反馈中心与运维后台」）

迁移 `0023_feedback_ops.sql`（`pnpm db:generate` 生成）。管理员沿用 `users.is_admin`（`0000_init` 已有），`ADMIN_EMAILS` 只提升不降级。

| 表                   | 关键字段                                                                                                                                                       | 说明                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tickets`            | no(serial 唯一，显示 YX-no), kind(bug/idea/question), status, priority, roadmap, source, reporter/assignee, context, attachments, vote_count, last_reply_by/at | 工单；附件本体在 `STORAGE_DIR/feedback/<ticketId>/`，诊断日志只给提交人和管理员           |
| `ticket_messages`    | ticket_id, author_user_id, is_staff, is_system, body, attachments                                                                                              | 提交人与管理员的对话；`is_staff` 显示为「研协支持」                                       |
| `ticket_votes`       | (ticket_id, user_id)                                                                                                                                           | 建议墙 +1，幂等                                                                           |
| `ticket_reads`       | (ticket_id, user_id), last_read_at                                                                                                                             | 已读位置，算未读与对方已读                                                                |
| `changelog_entries`  | version, title, body, tags, ticket_ids, pr_url, published_at(null=草稿)                                                                                        | 发布时关联工单置 done、建议置 shipped 并通知提交人                                        |
| `ops_events`         | level, source(server/agent/web), message, detail, fingerprint(唯一), count, first_at/last_at, ticket_id                                                        | 按指纹合并的运维事件（`lib/ops-events.ts`，进程内 60 秒节流，写失败不影响业务）；可转工单 |
| `user_notifications` | user_id, kind, title, href, read_at                                                                                                                            | 站内通知（不推外部渠道）                                                                  |

### 4.6 计费与充值（`db/schema/billing.ts`，API.md §2.24）

迁移 `0024_billing.sql`（`pnpm db:generate` 生成）。积分是 bigint 整数，1 积分 = 0.001 美元。

| 表                | 关键字段                                                                                                              | 说明                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `credit_balances` | user_id(主键), balance                                                                                                | 余额，和流水在同一事务里改                    |
| `credit_ledger`   | user_id, delta, kind(signup/usage/topup/refund/adjust), ref(唯一), model, tokens, cost_usd_micros, note               | 每笔变动一行；ref 唯一保证幂等                |
| `kyren_products`  | sku, product_id, price, currency                                                                                      | 每个充值包对应的 KyrenPay 商品（懒创建）      |
| `pay_orders`      | ref(唯一), user_id, sku, credits, amount_cents, currency, product_id, kyren_checkout_id/order_id, status, review_note | 充值订单；金额对不上记 review_note 留人工复核 |
| `kyren_events`    | id(主键), type                                                                                                        | webhook 事件去重；业务写完才落                |

## 5. 一致性与冲突处理（核心）

一句话：**服务器是唯一的真相源，agent 会话只是缓存。** 任何 agent 在行动前从服务器重读承重状态；agent 之间传递的只是“提示 + 指针”，不是状态本身。（继承自 dsh-projects 对 Claude Projects 的分析：单一真相源、原话不经转述、单写者归属、实时优先于记忆、乐观并发、可验证性。）

### 5.1 事件总线

- 每个写操作在同一事务里写业务表 + 写一条 `events`（`bus.record(tx, …)`），提交后 `bus.emit`；不在事务里时直接 `bus.publish`。
- `events.seq` 是**项目内连续**序号：`bus.record` 在同一事务里先 `UPDATE projects SET event_seq = event_seq + 1 … RETURNING`，这行锁持有到提交，所以同一项目的事件按提交顺序编号、没有空洞，不会出现“seq 11 先提交、seq 10 后提交”导致消费者漏事件。前端断线重连发 `subscribe { afterSeq }` 补齐；agent 会话记 `last_event_seq`，唤醒时只取更新的事件。
- `/ws` 订阅时先缓冲实时事件、补发历史、再按 seq 去重冲刷缓冲，保证推给客户端的事件严格递增；客户端也按 seq 去重。
- payload 是**变更后的完整对象**（不是 diff），客户端与 agent 直接替换。
- 新增事件类型：在 `packages/shared/src/events.ts` 的 `EVENT_PAYLOADS` 加一行，并在 API.md §4 登记。

### 5.2 人与人：实时同步而不覆盖

| 对象                 | 机制                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 文档正文             | Yjs CRDT，字符级合并；awareness 显示每个人（和 agent）的光标、选区、颜色                                                  |
| 卡片、实验记录、记忆 | 乐观并发：写入带 `baseVersion`，过期返回 `409 version_conflict` + `details.current`，前端提示“已被某人修改”并给出合并视图 |
| 消息                 | 追加型，无冲突；编辑会推 `message.updated`                                                                                |
| 在线状态             | `/ws presence`：谁在看哪个页面、谁在输入、谁在编辑哪篇文档（不落库）                                                      |

### 5.3 agent 与 agent、agent 与人：认领（claim）与冲突预警

这是本平台区别于“各跑各的 agent”的地方：**在冲突发生之前就提醒**。

1. **先认领再动手。** agent（和愿意的人）在修改一个资源前调用 `claim(resource_kind, resource_ref, mode, intent, ttl)`。`resource_ref` 格式：
   - `document`：`doc_xxx`；`doc_section`：`doc_xxx#<标题原文>`，标题取 `read_document` 大纲里的原文（如 `doc_x#2 图对比学习`）；认领某标题即包含其下所有子标题
   - `file`：项目共享文件夹内的路径或 glob（`data/raw/**`）
   - `experiment`：`exp_xxx`；`card`：`crd_xxx`；`topic`：自由文本主题（如 `baseline-复现`）
2. **原子判定。** 认领在一个事务里完成：查同项目、同资源（或父子重叠：文档 ⊃ 章节，glob 相交）的 `active` 认领；与他人 `exclusive` 重叠 → 返回 `409 claim_conflict` + 冲突认领列表；`shared` 与 `shared` 可共存。
3. **冲突预警。** 发生重叠（含 `shared` 叠加 `exclusive` 的尝试）时发布 `claim.conflict` 事件：前端在右侧面板与相关线程顶部显示冲突卡片（“张三的 agent 正在改《方法》章节，李四的 agent 也想改”），并为双方发起人生成 `inbox_items(kind=conflict)`；被拒的 agent 在自己线程里说明并等待或换做别的。
4. **派活前检查。** 协调者开线程前用 `check_conflicts(计划要碰的资源)` 对照现有认领；有重叠则排队、合并到已有线程，或在时间线上一句话说明让人决定。
5. **TTL + 心跳。** 认领默认 30 分钟，agent 每个 turn 自动续期；会话结束或线程 resolved 时释放；过期自动置 `expired`。杜绝“死锁认领”。
6. **写入守卫。** `edit_document`、`update_experiment`、`update_card` 等 agent 工具在服务端检查：没有有效认领、或别人持有独占认领 → 拒绝并返回冲突信息。人在 UI 里编辑不被阻止（Yjs 会合并），但界面会显示“某某的 agent 正在编辑此章节”。

### 5.4 单写者与幂等

- 一线程一个声音：线程里只有该线程的 agent 发言；协调者只能用 `message_thread` 引导。工具层强制：线程 agent 的 `reply` 不接受 `thread_id`；协调者没有 `reply`；`update_message` 只能改自己的。
- 创建类操作幂等并显式报告：`start_thread` 以根消息唯一约束保证，重复调用返回 `already_running`。
- 用户原话只以服务器逐字复制的形式在会话间传递（`context_message_ids` 展开为 `<cited author="user">`，正文转义 `<` `>`）。

## 6. 实时协议概览

- `/ws`：应用事件。帧定义在 `packages/shared/src/ws.ts`，流程见 API.md §3。实现：`apps/server/src/realtime/ws.ts`；前端 `apps/web/src/lib/ws.ts` 的 `RealtimeClient`。
- `/collab/:documentId`：Yjs 同步（Hocuspocus 协议，`realtime/collab.ts`）。握手用 `AccessPolicy.userFromRequest` 识别用户、查文档所属项目的成员角色（未登录 4401、非成员或文档不存在 4404、跨站 Origin 4403），访客只读；`onLoadDocument` 读 `documents.ydoc_state`，`onStoreDocument`（防抖 2s、最长 10s）写回并更新 `content_text`，随后发布 `document.updated`。agent 与 REST 的结构化编辑走 `withLiveDocument`：在服务端同一个 Y.Doc 上开 Yjs 事务，在线编辑者实时看到。细节见 API.md §3.2。
- agent 流式输出走瞬时事件 `agent.delta`（不落库），完整内容在 turn 结束时作为消息/步骤落库。

## 7. Agent 运行时

### 7.1 角色

| 角色                    | 数量              | 看到什么                                                                         | 能做什么                                                                             |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **协调者** coordinator  | 每项目 1 个，持久 | 时间线所有消息（旁聊除外）、所有线程的动态（只为知情）、转发卡片、冲突与停滞通知 | 分诊：开线程、转达跟进、回答项目问题、更新记忆、派活前查冲突、生成组会汇报、汇总进度 |
| **线程 agent** thread   | 每个项目线程 1 个 | 本线程消息 + 按需拉取的任何项目状态                                              | 真正干活：调研、写文档、建实验记录、更新看板/待办、请求审阅、在本线程回复            |
| **个人 agent** personal | 每个个人会话 1 个 | 主人在该会话里的消息 + 项目只读状态                                              | 与主人私聊式协作；写共享对象前需认领；建议主人转发给协调者                           |

### 7.2 Turn 模型

会话不是常驻轮询，而是**事件驱动**：

1. 总线事件 → **路由器**按拓扑决定唤醒谁：时间线消息 → 协调者；线程消息 → 该线程 agent（协调者也收到，只为知情）；个人会话消息 → 个人 agent；转发 → 协调者；`decision.updated`(answered)、`review.updated`、`claim.conflict` → 相关线程；定时任务 → 目标会话；停滞/失败 → 协调者。
2. **调度器**为会话加运行锁（`locked_by/locked_until`），同一会话同一时刻只跑一个 turn；turn 运行中到达的新事件在下一步工具调用之间注入（priority=next）或排到下一个 turn。
3. **组装上下文**（顺序固定，详见 `prompts/README.md` §2）：system = `prompts/shared-protocol.md` → 角色提示词（只替换名称类变量，字节稳定以命中前缀缓存）→ `<session-context nonce>`（项目、成员与角色、项目指令、本轮工具清单、时间）→ `<memory>`（`MEMORY.md` + 按描述挑选的文件，各前 4KB，整块有 token 上限）→ `<context-summary>` → harness 段（profile / skills / goal / MCP）；之后按时间重放摘要后的历史 turn（含当时插入的 nudge / goal_reminder 提醒）→ 本次 `<wake>` 信封（只含新事件，`<cited author="user">` 由服务端逐字展开并转义；附件列在 `<attachments>`）→ 线程会话附 `<thread-state>`（成员上次发言距今、此后 agent 已回复几条）。各块预算见 `agents/runtime/budget.ts`（默认窗口 `AGENT_CONTEXT_TOKENS`=128K，预留输出 16K）。
4. **LLM 循环**：DeepSeek tool calling；每次工具调用与结果写 `agent_steps`；文字流经 `agent.delta` 推给前端；token 计入 `token_usage`。
5. **结束**：turn 必须以一个对外可见的工具结束：`reply`、`post_message`、`update_status`、`react`、`start_thread`、`message_thread`、`no_reply_needed`（与 `prompts/` 一致）；否则运行时提醒一次后强制结束。
6. **压缩与裁剪**：turn 开始时按整条 prompt（system + 工具定义 + 历史 + 本轮唤醒）的估算 token 判断；超预算就把较早的 turn 总结进 `context_summary`（≤ 3000 字，压缩 prompt 写的是同一上限），按大小保留最近 0~2 个 turn；转录过长时分块逐段并入（每块带上一块的摘要）。压缩调用失败时记日志，本轮只带放得下的最近 turn。轮内工具往返超预算时，较早的工具输出换成「[已省略较早的工具输出 N 字，需要时重新调用]」，最近 4 条保留。摘要有损，提示词要求承重事实重新验证。
7. **状态分栏**由服务端算，不由 agent 自报：有未答决策卡/待审阅 → `blocked`/`review_ready`；turn 运行中 → `working`；`set_thread_resolved` → `completed`；turn 异常 → `failed`。
8. **停滞看守**：线程 `working` 超过 20 分钟无步骤、或 `failed` → 给协调者发 `stalled-thread` 唤醒，由它推一下或在时间线一句话告诉人。

### 7.3 工具

工具定义在 `apps/server/src/agents/tools/`，每个工具 = zod 入参 + 权限（哪些角色可用）+ 实现（复用 modules 的 service，写操作照常发事件）。工具清单与使用规则见 `apps/server/prompts/`；名称在提示词与实现间必须一致。

### 7.4 提示词

位于 `apps/server/prompts/`（Markdown，中文）：`shared-protocol.md`（所有角色共有：平台全貌、“一个研协的声音”、真相源与重读、信任级别、记忆规则、认领协议、审阅礼仪、写作风格、科研诚信）、`coordinator.md`（分诊表、写 brief、派活前查冲突、进度汇总、计划审阅关口、组会汇报规则、记忆维护）、`thread.md`（首个 turn、状态清单格式、认领、调研/实验/写作工作流、决策卡、审阅、回复与 resolve 规则）、`personal.md`、`report.md`（组会汇报生成）。组装规则见该目录 README。

### 7.5 提示词对工具层的假设（后端线程已逐条确认，2026-10-26）

1. ✅ `doc_section` 的 `resource_ref` = `doc_xxx#<read_document 大纲里的标题原文>`；`document` 认领覆盖其下所有小节，小节认领只覆盖自己（`modules/claims/service.ts` 的 `overlap` / `covers`）。
2. ✅ 采用新增原因 `thread-activity`：线程里成员的发言（`trust=peer`）和线程 agent 的回复（`trust=relay`）以 `delivery="fyi"` 写进协调者的唤醒队列，`wakes=false`，不单独触发 turn，随下一次唤醒一起送达（`agents/runtime/router.ts`）。
3. ✅ `check_conflicts` 返回 `conflicts[{ resource, conflicts_with[{ claim_id, holder, holder_session, thread_id, on_behalf_of, intent, mode, expires_at }] }]` 与 `clear`。
4. ✅ 他人新认领与我持有的认领重叠（无论成败）都会发布 `claim.conflict`，路由器给被重叠认领的持有会话发 `claim-conflict` 唤醒。
5. ✅ 服务端强制认领：`edit_document`、`update_experiment`、`update_card`、覆盖已有文件的 `write_file`（没有覆盖该资源的有效认领 → `claim_required`；别人独占 → `claim_conflict`）。`update_card` 已补进 `prompts/thread.md`。`replace_text` 与不带 heading 的 `append` 需要整篇 `document` 认领。
6. ✅ `request_review(target_kind=plan, target_id=消息或文档 id)`；重新提交 = 再调一次。审阅的 `threadId` 取发起线程，结论与评论以 `review-updated` 唤醒该线程。
7. ✅ 转发卡片 = 成员附言（原话）+ 服务器摘录的会话最近 6 条（`<summary written-by="agent">`，视为数据）；协调者读不到个人会话本身（转发后也不行，验收发现会把私聊原文写进对全项目可见的思路，已收紧），只看卡片；agent 的所有读工具与唤醒信封都过滤旁聊（`agent_visible=false`）。
8. ✅ 个人 agent 写新文件不需要认领，草稿约定放 `drafts/<owner>/`；建项目文档前先问主人（提示词约束，服务端不拦）。
9. ✅ 新记忆文件 `base_version=0`；`MEMORY.md` 由 agent 维护，且不可删除。版本过期时工具返回最新内容与版本号。
10. ✅ `start_thread` 不带 label；`ask_decision` 只给 thread / personal，协调者没有。
11. ✅ `create_todo`、`create_card`、`request_review`、`draft_report` 协调者可用；`draft_report` 返回 `report_id`。这些协作类工具只在协作线程注册了对应端口（`agents/tools/collab-port.ts`）后出现。
12. ✅ `web_search`（通用网页搜索）、`paper_search`（学术检索）、`fetch_url`（抽正文，拒绝内网地址）只在 `AGENT_WEB=true`（或旧名 `AGENT_FETCH_URL=true`）时出现在 `{{tool_list}}` 里，见 §12。

### 7.6 Harness 能力：模型、MCP、Skill、斜杠指令、Profile

接口见 API.md §2.13。每个 turn 开始时 `agents/harness` 的 `prepareHarness` 为会话算出路由、追加的 system 段和额外工具。

**模型路由**（`agents/llm/registry.ts`）。provider 来源三处，按序合并：① `.env` 主服务（`LLM_BASE_URL` 指向 DeepSeek 时 id 为 `deepseek`，模型取 `LLM_MODELS`，缺省 `deepseek-flash, deepseek-v4-pro`）；② `.env` 的 `LLM_PROVIDERS`（JSON 数组，可写 `apiKeyEnv` 引用另一个变量）；③ 设置页添加的项目级 provider（表 `llm_providers`）。模型 id 统一写成 `<provider>/<model>`。会话的 `model` 为空或失效时退回 `LLM_DEFAULT_MODEL`/第一个模型。强度按 provider 的 `thinking_format` 翻译：`deepseek` → `thinking:{type}` + `reasoning_effort`（off 关掉思考）；`openai` → `reasoning_effort`（max 降为 high，off 不发）；`none` → 不发。会话没选强度时用 profile 的建议强度，再退回模型默认。每次调用实际用的模型与强度记在 `agent_steps.data.model/effort`，思路面板据此可见“切换后是否生效”。

**MCP**（`agents/mcp/manager.ts`，官方 `@modelcontextprotocol/sdk` 客户端）。服务器按配置哈希缓存连接，连接 20 秒、调用 60 秒超时，空闲 10 分钟断开，`stop` 时全部关闭。工具名对模型暴露为 `mcp__<服务器>__<工具>`（超过 64 字符时截断加哈希），入参直接用服务器给的 JSON Schema。可见范围：项目级服务器按 `roles` 给协调者 / 线程 / 个人会话；个人级服务器只出现在主人自己的个人会话里。stdio 会在服务器上起进程，默认关闭（`MCP_ALLOW_STDIO=true` 打开），且只有负责人 / 导师能加。某个服务器本轮连不上时，其余工具照常可用，system 段里写明哪台不可用。MCP 返回 `isError` 时作为工具错误交还模型，不中断 turn。

**Skill**。内置 14 个科研 skill（`modules/harness/skills.seed.json`）+ 项目级 + 个人级，同 slug 时个人 > 项目 > 内置（内置只读，用同 slug 新建即覆盖）。可由模型调用的 skill 只把 `slug：描述` 列进 system 的 `<skills>` 目录，正文按需经 `load_skill` 取回，格式 `<skill_content><skill_resources/><skill_instructions/></skill_content>`；附件经 `read_skill_file` 读。支持导入带 frontmatter 的 `SKILL.md`（`name`、`description`、`disable-model-invocation`、`user-invocable`）。

**斜杠指令**。三类：`client`（前端直接处理：/model、/effort、/profile、/forward、/stop、/help）、`session`（`POST P/commands/run`：/clear 把 `summary_through_turn_id` 推到最新 turn 并清空摘要，消息保留；/compact 立即压缩；/goal clear）、`prompt`（作为普通消息发出，由唤醒信封展开）。成员消息以 `/name` 开头时，`renderWake` 在该消息后追加 `<command-expansion>`：/goal 写入会话目标；/plan 要求只出计划不执行；/<skill> 或 /skill <slug> 内联 skill 正文；自定义指令按模板替换 `$ARGUMENTS`。只展开直接发给本会话（`trust=principal`）的成员消息。

**持续目标**（/goal）。目标写进 `agent_sessions.goal` 并进 system 的 `<goal>` 段；agent 达成后调用 `update_goal(complete)`，受阻时 `update_goal(blocked)`。turn 正常结束而目标未完成、本轮也没调用 `update_goal` 时，自动再推进一轮，同一目标最多 3 轮。

**Profile**。11 个内置科研 profile（`profiles.seed.json`：文献调研、论文精读、想法打磨、实验设计、数据分析、论文写作、rebuttal、组会准备、代码复现、内审等），可按项目或个人新建 / 覆盖。会话选了 profile 时，其 prompt 以 `<profile>` 段追加在稳定前缀之后（不破坏前缀缓存），常用 skill 在 `<skills>` 目录中排在前面。调研依据见 `docs/research-ai-landscape.md`。

## 8. 核心流程

**A. 在协作台提需求**：成员在时间线发消息 → `message.created` → 协调者 turn → 判定为新需求 → `check_conflicts` → `start_thread(anchor=该消息, brief, context_message_ids)` → 时间线该消息下出现线程卡片，协调者一行回执 → 线程 agent spawn turn：`update_status` → `claim` 要碰的文档章节 → 干活（`edit_document` 等，人们在文档里实时看到 agent 光标）→ `reply` 交付 → 需要导师把关时 `request_review` → 导师在“审阅”里 LGTM → 线程 `review.updated` 唤醒 → 收尾 `set_thread_resolved`，释放认领。

**B. 个人工作区转发**：成员在“我的工作区”与个人 agent 讨论出思路 → 点“转发给协调者” → 服务端在时间线发一条 `kind=forward` 的卡片（附会话摘要与链接，原话以 id 引用）→ 协调者分诊：采纳为新线程 / 并入已有线程 / 记入项目记忆。

**C. 组会汇报**：成员在“组会汇报”选时间段 → `POST /reports {generate:true}` → 服务端收集该期的线程清单与状态、时间线要点、实验记录与日志、审阅结论、文档改动、待办 → 用 `prompts/report.md` + 推理模型生成草稿（状态 `generating` → `draft`）→ 成员编辑定稿，可一键另存为协同文档、把“下期计划”拆成待办。

**D. 冲突预警**：两个线程的 agent 先后认领同一章节 → 后者收到 `claim_conflict` → `claim.conflict` 事件 → 双方发起人收件箱出现冲突项、右侧面板出现冲突卡 → 人选择“让 A 先做”（B 的线程收到 note 后等待）或“合并为一个线程”。

## 9. 权限

| 能力                                           | owner | advisor（导师/师兄） | member | guest |
| ---------------------------------------------- | ----- | -------------------- | ------ | ----- |
| 查看时间线、线程、文档、实验、汇报、agent 思路 | ✓     | ✓                    | ✓      | ✓     |
| 在时间线/线程发言、驱动 agent                  | ✓     | ✓                    | ✓      | —     |
| 编辑文档、看板、待办、实验记录                 | ✓     | ✓                    | ✓      | —     |
| 审阅、LGTM、回答决策卡                         | ✓     | ✓                    | ✓      | —     |
| 我的工作区（只看到自己的）                     | ✓     | ✓                    | ✓      | —     |
| 项目设置、成员与邀请、项目指令、记忆编辑       | ✓     | ✓（不能移除 owner）  | —      | —     |
| 删除项目                                       | ✓     | —                    | —      | —     |

个人线程（`kind=personal`）只有主人可见，转发后协调者看到的是转发卡片与摘要，不是整段私聊。

## 10. 并行开发规则

- **分支**：每个线程一个分支，从最新 `main` 拉出，PR 合并；不直接推 `main`。推送前 `git fetch && git rebase origin/main`。
- **迁移**：只改自己拥有的 schema 文件；合并顺序约定为**后端线程先、协作线程后**（协作表外键指向后端的表）。生成迁移前先 rebase 到最新 main，再 `pnpm db:generate --name <描述>`。若合并时迁移编号冲突：丢掉自己的迁移文件与 `meta` 改动，rebase 后重新生成。已合并的迁移文件永不修改。
- **契约变更**（shared 类型、事件、端点）：只追加、不改名不删；必须改时在 PR 描述里列出影响面。
- **UI**：严格按 STYLE.md；新增基础组件放 `components/ui/` 新文件。
- **质量门**：`pnpm check`（lint + typecheck + test）通过才开 PR；CI 还会构建 Docker 镜像并冒烟测试 `/api/health`。
- **密钥**：只放 `.env`（已在 .gitignore），`.env.example` 留占位。

## 11. 部署

`docker compose --env-file .env up -d --build`：`db`（postgres:16，卷 `pgdata`）+ `app`（单镜像，端口发布到 `127.0.0.1:${APP_PORT:-8787}`，卷 `storage` 挂 `/data/storage`）。宿主机 Caddy 反代到 8787，需透传 `/ws` 与 `/collab` 的 WebSocket 升级。启动时自动迁移；另有一次性命令 `docker compose run --rm app node dist/migrate.js`。健康检查 `GET /api/health`（数据库不通返回 503）。

Compose 里另有 `searxng`（自托管元搜索，只在 Compose 内网给 app 用，不发布端口；配置 `deploy/searxng/settings.yml`），见 §12。

## 12. 联网搜索（`apps/server/src/websearch/`）

agent 的三个联网工具定义在 `agents/tools/web.ts`，实现放在 `src/websearch/`，只在 `AGENT_WEB=true`（旧名 `AGENT_FETCH_URL=true` 等同）时出现在工具列表里。代码默认关；Compose 部署默认开。

| 工具           | 做什么                                                                                                                       | 后端                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`   | 通用网页搜索，可按 `time_range`、`language`、`category`（general/news/science/it）过滤，一次可传最多 5 个检索式              | 自托管 SearXNG 的 JSON 接口（`SEARXNG_URL`）；SearXNG 不可用或无结果时退回 DuckDuckGo HTML 版（`WEB_SEARCH_FALLBACK`）                                    |
| `paper_search` | 学术检索，并发查四个源，按 DOI / arXiv 号 / 归一化标题去重合并，倒数排名融合排序，可按年份过滤、按相关度 / 引用数 / 时间排序 | OpenAlex、Semantic Scholar、Crossref、arXiv（`RESEARCH_CONTACT_EMAIL` 进 polite pool；`SEMANTIC_SCHOLAR_API_KEY` 可选）                                   |
| `fetch_url`    | 抓取公网网页或 PDF，抽正文；超长内容用 `start_char` / `next_start_char` 分段续读                                             | 网页：Mozilla Readability + linkedom，转成保留标题层级、列表、表格的 Markdown 风格文本，认不出正文时退回整页文本；PDF：unpdf（pdf.js），逐页标「第 N 页」 |

模块：

- `net.ts`：公网地址守卫与抓取。请求前解析域名，任一地址落在内网、回环、链路本地、ULA、CGNAT、文档示例、组播或云元数据段就拒绝；真正建连时 undici `connect.lookup` 再校验一次实际连接的地址（防 DNS rebinding）；重定向手动跟随，每一跳都重新校验。拒绝 `localhost` / `*.local` / `*.internal` 和带用户名密码的网址。网页上限 4 MB、PDF 25 MB。`fetchApi` 只给配置里的受信任 API 用（SearXNG 本身在内网），不经过公网守卫。
- `general.ts`：SearXNG 与 DuckDuckGo 的请求和解析；结果带 `unresponsive_engines`，让模型知道哪些引擎被上游限流。
- `scholarly.ts`：四个学术源的映射、合并与排序；单个源失败不影响其他源，状态写进 `sources_status`。
- `extract.ts`、`text.ts`：正文抽取、字符集识别、HTML 实体。

同一检索式 10 分钟内命中进程内缓存（最多 200 条），减少学术 API 限流。冒烟脚本：`pnpm --filter @srh/server exec tsx scripts/websearch-smoke.ts "查询词" [网址…]`（真联网，不进 CI）。

SearXNG（`deploy/searxng/settings.yml`）：开 `json` 格式、关 limiter（只有 app 在内网调用），引擎组合按服务器实测挑选（机房 IP 会被 Google、DuckDuckGo、Wikipedia 等拦截，现用 Bing / Brave / Yahoo / mwmbl / Google CSE 和新闻、arXiv、代码类引擎），换服务器后用 `deploy/searxng/probe-engines.sh` 重测；容器 `cap_drop: ALL`、`no-new-privileges`、512 MB 内存、1 CPU。实测常驻约 130 MB。

安全边界：搜索结果和网页正文对模型来说是不可信数据，工具描述和 shared-protocol 第 10 节都要求把它当资料而不是指令；联网事实必须附网址和检索日期。

## 13. 共享云电脑（`modules/desktops/`、`docker/desktop/`）

每个项目一台 Linux 桌面（Debian + XFCE + Chromium + Python + tesseract），成员在「云电脑」页面用 noVNC 一起看、轮流或同时操作；agent 用 `computer_*` 工具操作同一台机器，每一步实时显示在画面上。总开关 `DESKTOP_ENABLED`（默认关）。

**容器**（`docker-runtime.ts`，经 `sandbox/docker.ts` 共享客户端）：名字 `${DESKTOP_NAME_PREFIX}<projectId>`，标签 `srh.kind=desktop / srh.project / srh.instance`。非 root（1000:1000）、`cap-drop ALL`、`no-new-privileges`、根文件系统只读、`/tmp` tmpfs、`Init`；内存（不给 swap）、CPU、pids、`/dev/shm` 都有上限。只挂本项目的具名卷 `${prefix}home-<projectId>` → `/home/researcher`（休眠、重建镜像都保留），不挂宿主机目录和 Docker socket。镜像 ID 变了会删掉旧容器按新镜像重建。

**网络与 VNC**：容器在独立 bridge `srh-desktops`，`enable_icc=false`（云电脑之间不通），能上公网；`deploy/desktop-firewall.sh` 在 `DOCKER-USER` / `INPUT` 链拦截它访问宿主机、RFC1918、100.64/10、169.254/16（云元数据）等。Xvnc 不监听 TCP，只在容器内的 unix socket（0600、SecurityTypes None）上；应用通过 `docker exec -i srh-vnc`（socat）的**连接劫持**（`POST /exec/{id}/start` + `Upgrade: tcp` → 101，`vnc-transport.ts`）拿到原始 RFB 字节流。所以应用不需要加入云电脑网络，也没有 VNC 密码；docker-socket-proxy（`EXEC=1`）原样透传 101。

**代理与控制权**：浏览器 ↔ `WS /projects/:id/desktop/vnc`（Cookie 鉴权 + 成员校验）↔ 应用 ↔ docker exec 隧道 ↔ Xvnc。每条连接一个 `RfbClientFilter`（`rfb-filter.ts`）：解析客户端→服务端的 RFB 消息（处理任意拆包 / 粘包），握手只接受 None、ClientInit 强制 shared；画面类消息（0/2/3/150/248）转发；输入类（4 键盘 / 5 鼠标 / 6 剪贴板 / 255 QEMU 按键）只有 `canInput()` 为真时转发，失去控制时仍放行“松开已按下的键 / 鼠标键”防粘滞；SetDesktopSize(251)、xvp(250) 丢弃；未知类型断开（4400）。控制状态机在 `control.ts`：

- 轮流模式：只有控制者能输入；别人要先申请，对方 30 秒不回应、2 分钟没操作或已离开时可以直接接管；交还时直接交给申请人；owner / advisor 随时可以接管、转交。
- 同时模式：所有非访客都能输入；人点「接管」= 让 agent 暂停。
- agent：每次操作拿 60 秒租约（从最后一次操作算起）；人接管后工具返回 `ToolError(code=desktop_taken_over)`，不会再执行任何命令。
- 访客只能看。成员被移出 / 改角色时断开他的 VNC。控制者关页面 15 秒后自动释放。

状态只在内存（`manager.ts`），以 Docker 为准：启动时和每 30 秒对账；操作模式存在 `STORAGE_DIR/_desktops/settings.json`，不建表。状态变化推 `desktop.updated`、agent 操作推 `desktop.activity`（瞬时事件，§6）。

**调度**（`scheduler.ts`）：`DESKTOP_MAX_RUNNING` 台上限；新启动时满了就按最近活跃时间停掉没人看、agent 1 分钟内没用过的云电脑（LRU，被停的项目显示“为其他项目让出资源”），一台都让不出来则 409 `reason=capacity`「资源不足」。没人看且 agent 没操作 `DESKTOP_IDLE_MINUTES` 分钟后自动休眠（`sandbox/idle.ts` 的 `IdleReaper`）。启动串行化，避免并发启动同时通过台数检查。

**agent 工具**（`agents/tools/computer.ts`，thread / personal 角色）：`computer_start`、`computer_screenshot`、`computer_click`、`computer_type`、`computer_key`、`computer_scroll`、`computer_open_url`、`computer_exec`。DeepSeek 看不了图，截图工具在容器里跑 `srh-screen`：`import` 截屏 → tesseract（chi_sim+eng，放大 2 倍）→ 返回屏幕尺寸、窗口列表、活动窗口和每行文字的坐标框 `[x,y,宽,高]`（最多 220 行 / 7000 字）；PNG 存进项目文件 `desktop/screenshots/`（保留最近 60 张）。点击 / 输入 / 按键用 xdotool，参数数组直接交给 docker exec，不经过 shell；按键只接受 keysym 名称；网址只允许 http(s)。`computer_exec` 用 `srh-run`（`timeout` + 输出截断，OOM 时优先被杀）。动作工具可带 `then_screenshot` 省一轮。休眠时自动启动。

**前端**（`features/desktop/`）：noVNC（`@novnc/novnc`，按需加载的独立分块）`scaleViewport`，没有输入权限时 `viewOnly`（服务端照样过滤）；顶栏：状态、观看者头像、控制者、申请 / 接管 / 交还、模式切换、CPU / 内存、休眠倒计时、全屏、剪贴板助手（放进远端剪贴板或由服务端直接打字，中文可用）；画面上 agent 提示条与点击涟漪；下方 agent 操作记录（截图可点开）。

**实测**（4 vCPU / 7.4 GB 的部署机，1600×900）：空闲约 135 MB；Chromium 打开 arXiv 列表、GitHub 仓库页、维基百科 3 个标签页峰值约 680 MB，CPU 峰值 150%（= 1.5 核上限）；4 进程 Python 跑满 CPU 时被限制在 150%；容器内吃内存的脚本在 1.5 GB 被 OOM 杀掉，Xvnc 和桌面不受影响；截图 + OCR 空闲时约 6 秒、页面加载中约 13 秒。

# 通用科研模块（追加）

`modules/research` 是独立的跨学科科研服务，`db/schema/research.ts` 保存项目模板发布版本、记录及修订、来源、快照、摘录、代码、编码、发现和幂等键。`packages/shared/src/research.ts` 是前后端 DTO 与校验契约，`research-templates.ts` 发布通用、计算仿真、实体实验、调查观测、质性、文献史料、理论推导七种预置方法。项目可设置研究领域与常用方法，旧项目默认空列表；会话模型、effort 和 profile 保持独立。

项目级来源允许被多个研究记录用 `sourceIds` 关联。来源指向项目文件/文档/论文/Notebook 或手工书目/URL；导入、转写来源通过 `originalSourceId` 连接原件。快照元数据在数据库，原字节在 `<STORAGE_DIR>/research-snapshots/<projectId>/<snapshotId>`，下载经项目权限和服务端定位；完整文件快照直接复制当前原文件全量字节，不依赖文件历史中的部分元数据。`coverage` 区分完整、摘录、外部链接，`sha256` 对实际保存字节计算。固定摘录始终指向原快照；来源或原件变化不会改写旧证据，并将相关发现标为待复核。PDF 页与表格范围没有可核对索引时一律标 unverified。

研究记录保存具体模板版本与完整不可变修订；更新带 `baseVersion`，模板升级必须显式指定版本并保留历史字段。完成状态仅表示过程完成，不自动代表证据支持或人工审阅通过。过程日志追加写。旧实验只经统一列表适配，不复制旧表、猜旧方法或更改旧 API。组会汇报上下文可读取研究记录、来源、快照覆盖、摘录定位与发现状态；审阅快照写入记录/发现当时修订号。项目事件写入和业务对象在同一事务、由项目事件序号保证顺序。

## 14. 研究工作空间与局部执行（2026-10-28）

研究重构限定在 `research` 模块；项目导航、协作台、个人工作区及原资源的归属不变。`ResearchRecord` 继续提供稳定身份、旧字段和历史版本，新创建入口内部选择通用配置。旧实验仍由适配列表打开原详情，不复制成新研究。

- 工作空间内容、普通关系和运行分别保存。条目引用文档、论文、文件、Notebook 或既有证据；其正文继续由原模块管理。笔记内容版本与卡片位置版本独立，逐条 CAS 更新并发布事务事件。总览读取持久化摘要，正文按需分页读取；当前原件内容版本使用读取时摘要检查，跨页变动必须提示重新读取。
- 新表 `research_workspace_items`、`research_workspace_relations`、`research_recipe_versions`、`research_runs`、`research_run_keys` 保存新增能力。方案发布版本不可变；运行保存操作定义、输入内容及摘要、实际产物、尝试记录与人工检查，不把实时原件引用当成固定输入。
- 执行片段是用户显式启动的有限无环依赖图，支持 AI、Notebook 和人工检查。普通关系图允许研究者自由组织，不承担执行语义。模型路由、profile 和 Notebook 内核复用现有实现；Notebook 在运行专属副本上执行冻结代码，避免成员后续编辑改变已启动的输入。运行不向项目讨论逐步刷屏。
- 后台执行通过运行 revision CAS 协调确认、停止及状态写入。重试保留成功尝试，输入有变更需新运行。启动时未明运行标为中断，不自动重做副作用。当前材料复核状态由独立读取计算，不改历史输入和输出。
- 审阅、Markdown/JSON/CSV 导出共用工作空间归档。归档以 repeatable-read 事务固定条目、证据闭包、方案和运行，包含版本及 SHA-256 清单；布局单独导出，不进入正文审阅摘要。只有来源快照或摘录实际保存的内容才声明已固定，外部链接与资源引用保留保存范围。
- 新对象接入研究搜索、产出定位和汇报。笔记与运行活动影响研究排序和汇报过期提醒。原 source/snapshot/excerpt/finding 的权限、版本和上游复核机制继续使用，不用复制绕过个人空间权限。

### 14.1 研究空间产品入口收敛（2026-10-28）

前端移除模板管理和旧记录编辑器及其专用草稿、冲突处理代码。研究详情始终加载工作空间；依据对象按需打开，旧字段与过程仅作原数据的只读投影。旧模板路由重定向，旧详情、证据和结论链接保留。研究列表仅展示研究空间，旧实验仍由原模块与资源关联访问；服务端统一列表适配契约不变。

AI 正常创建使用 `research_workspace.workspace_create`，不先选择模板。旧模板、记录字段 API 与专用工具分支仅为历史调用、版本与审阅兼容保留；不删除已有研究数据、不复制新身份。常驻提示词、内置技能和汇报围绕当前内容、依据与实际运行工作，不再输出模板作为工作要求。

### 可组合研究内容与不可变产物（2026-10-28）

研究空间继续使用原条目和运行 ID。`research-content.ts` 追加混合草稿有序素材块、协作表格元数据、图像配置、具名输入输出及固定产物引用；`inputs` 一旦出现（包括空数组）即优先于兼容字段 `inputItemIds`。普通关系保留研究语义，处理绑定形成无环依赖。

`modules/research/tables.ts` 读取现有 Y.Doc 工作簿的稳定工作表、行列 ID，不经过 Markdown 预览截断；表格转换和基础绘图由 `composable.ts` 实际执行，SVG 和 Chromium PNG 无须 Notebook 内核。运行固定完整输入、配置与模型；人工检查保存成员修改后的候选版本，下游仅使用固定版本。

`research_artifact_versions` 保存版本、哈希、来源和资源索引，正文与二进制进入项目隔离的 `.research-artifacts/<projectId>/`；不使用可覆盖的普通项目文件保存历史依据。字节读取校验哈希。发布仅认可运行成功尝试实际引用的产物，失败中的中间文件不进入画布、搜索、审阅或导出。产物按步骤和输出槽聚合展示，旧固定版本继续可读。

布局使用独立位置版本及批量事务，和正文并发分离。前端受控节点合并变化，本地拖动、待保存和已确认位置分别维护；同一条目至多一个在途请求，连续移动合并后续保存。位置事件只更新对应缓存，不重载整张画布。

## 15. 接入：API 令牌（`modules/integrations`，2026-10-30 新增）

第 1 步：让外部 agent（dots 这类个人 agent、脚本、CI）能用一把钥匙读写平台，而不是借用户的浏览器 Cookie。总开关 `API_TOKENS_ENABLED`，默认关闭。

**归属**：`apps/server/src/modules/integrations/`、`db/schema/integrations.ts`、`packages/shared/src/integrations.ts`、`apps/web/src/features/settings/components/IntegrationsSection.tsx`。

**数据**：一张 `api_tokens` 表——`user_id`（外键，删用户级联删令牌）、`name`、`token_hash`（唯一索引，只存 SHA-256）、`token_hint`（原文随机部分前 8 位）、`scopes`（`read`/`write` 数组）、`project_ids`（空 = 全部）、`expires_at`、`last_used_at`、`revoked_at`。原文 `srh_pat_<43 位 base64url>` 只在创建响应里返回一次。

**认证**（`guard.ts` 的 `currentAuth`、`realtime/access.ts` 的 `userFromRequest` 共用 `integrations/service.ts` 的 `bearerAuthFor`）：

1. 有 `Authorization: Bearer …` 就只认它——无效 / 未启用直接 401，不会退回 Cookie（避免“以为在用令牌”）。
2. 命中哈希 → 未撤销 → 未过期 → 每令牌每分钟限流 → 记 `last_used_at`（最多 60 秒写一次库）。
3. 得到的就是那个用户：`requireUser` / `requireProject` 照旧算角色与成员权限，**令牌不放大任何权限**。

**执行点**：

- 只读令牌：`integrations/service.ts` 的 `assertTokenCanWrite` 判方法（非 `GET/HEAD/OPTIONS` 且没有 `write` → 403），在**两条** REST 身份链上各调一次——`modules/auth/guard.ts`（项目、消息、收件箱…）和 `modules/collab-common/guard.ts`（看板、待办、文档、审阅、版本…）。要两处是因为协作模块的 REST 不经过 `auth/guard`，漏一条 `read` 令牌就能从那条链写进去。协同文档的 `/collab` 握手另外把只读令牌当访客（`readOnly`），能看不能落改动。
- 限项目：`guard.ts` 的 `requireProject`、`collab-common/guard.ts` 的 `requireProject`、`realtime/access.ts` 的 `canAccessProject` 三处，范围外一律当“不是成员”（404 / 拒绝订阅），`GET /projects`、`GET /auth/me`、`GET /inbox` 也按范围过滤。
- 令牌管理（`/auth/me/tokens`）只认网页登录会话：令牌不能创建 / 撤销令牌，防止一张泄露的令牌给自己续命。

**不做的**（后续步骤，见 `docs/integrations-and-notifications-plan.md`）：Webhook 订阅、SSE 实时流、邮件通知。这些表一张都没有建，避免提前占号。

**回滚**：`API_TOKENS_ENABLED=false` 再部署即可，所有令牌立刻失效，网页登录与现有接口不受影响；代码与表可以保留。

## 16. 接入：入站 MCP（`modules/mcp`，2026-10-30 新增）

把平台能力做成一个 MCP **服务端**，让外部 agent 用第 14 节那张令牌直接接进来（API.md §2.20）。总开关 `MCP_ENABLED`，默认关闭，且要求 `API_TOKENS_ENABLED` 同时打开。

**两个方向，别搞混**：

- **出站**（已有）：`agents/mcp/manager.ts` + `mcp_servers` 表 —— 我们的 agent 去连**别人的** MCP 服务器（stdio / http / sse 三种 transport，`mcp-net.ts` 做 SSRF 守卫）。
- **入站**（本节）：`modules/mcp/` —— 别人来接**我们**。只有 `POST/GET/DELETE /api/v1/mcp` 一个端点。

**传输**：`@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`（Node 版），**stateless**（`sessionIdGenerator: undefined`）+ `enableJsonResponse: true`。每个请求新建一对 `McpServer` + transport，用完关闭；不签发 `Mcp-Session-Id`，不提供 SSE 的 GET 流（按规范回 405）。

- 为什么 stateless：多一层会话状态就多一个「拿别人的 session 串号」的面；入站工具都是短请求，用不上长连接。
- Fastify 侧用 `reply.hijack()` 把原始 `req.raw` / `reply.raw` 交给 SDK；校验（开关、Origin、令牌）全部在 hijack **之前**做完，否则出错就没法返回正常响应。

**鉴权**：直接复用 `integrations/service.ts` 的 `bearerFromHeader` + `authenticateBearer`——与 REST 同一条链（未撤销 → 未过期 → 每令牌每分钟限流 → 记 `last_used_at`）。

- **只认 Bearer，不认 Cookie**：MCP 是机器入口，不让浏览器登录态在这里被顺带使用，浏览器侧的攻击面因此不变。
- `401` 一定带 `WWW-Authenticate: Bearer realm="srh"`（MCP 规范 MUST），令牌无效时再带 `error="invalid_token"`。
- 每次请求校验 `Origin`（规范 MUST，防 DNS rebinding），复用 `realtime/access.ts` 的 `isAllowedOrigin`；命令行客户端不带 `Origin` 时放行。

**工具即权限边界**（`modules/mcp/tools.ts`）：

- 9 个工具，`tools/list` 时按令牌 `scopes` 裁剪——只读令牌**根本看不到**写工具，而不是「调了才报错」。
- 每个工具都调既有 service（`listProjectsForUser` / `listMessages` / `createMessage` / `createTodo` / `readDocument` / `requireVisibleThread` …），因此自动继承角色、项目成员、个人线程过滤。唯一的例外是收件箱：`modules/inbox` 没有导出 service 函数，`tools.ts` 里按 `GET/PATCH /inbox` 的同样条件重写了两段（含 `bus.record` + `emit`），改动前请对照那份路由。
- 项目围栏在 `projectAccess()` 里做：令牌 `projectIds` 范围外一律「不存在」，不是成员 404，能力不够 403。
- **不提供**改项目设置、改成员、删项目、改文档正文这类不可逆或影响别人的工具。

**写操作的额外闸门**：`limits.ts` 的 `consumeWrite` 在内存里按「令牌 × UTC 日期」计数，超过 `MCP_WRITE_PER_DAY`（默认 200）返回工具级错误。分钟限流挡不住「每分钟 100 次刷一整天」，这层专治 agent 死循环；读操作不占额度，进程重启归零。

**留痕**：`post_message` 把 `meta.viaToken = { id, name, hint }` 写进消息（`messages.meta` 本来就是 jsonb，**没有加字段、没有加表**），前端 `MessageItem` 显示「来自令牌「名字」」。每次工具调用还会打一条结构化日志（令牌 id、用户、工具名、耗时、成败）——这就是本轮的「审计」，若要可查询的调用记录表属于改计划，另议。

**不做的**：OAuth 2.1 授权服务器 / RFC 9728 元数据（规范里授权是 OPTIONAL，Bearer 静态令牌已够用；只吃 OAuth 发现的云端客户端以后再说）、SSE 流、MCP 会话管理、写文档正文、管理类工具。

**回滚**：`MCP_ENABLED=false` 再部署即可——`/api/v1/mcp` 全部 403，REST 与网页完全不受影响。代码与表都不用动。

## 退役与协作入口调整（2026-11-01）

本节更新前文实验、云电脑和导航相关描述。实验模块与云电脑模块、工具及云电脑专用 Docker 镜像／防火墙配置已移除；Notebook 内核、Docker 代理及网络隔离继续保留。共享包遗留类型只用于历史兼容。

升级迁移先删除实验专属 Notebook 及其版本；研究实体、研究修订、工作空间条目、运行和方案固定版本引用的 Notebook 保留，随后解除实验关联。移除实验／日志表、课题方法偏好列和卡片／Notebook 实验关联列；释放旧实验认领，关闭相关提醒，清理当前结构化资源关联。消息、汇报、审阅文字及独立研究证据保留。此升级包含不可逆数据删除，恢复依赖部署前备份。

前端任务入口组合看板／待办，研究空间列表提供工作空间／研究资料。旧实验和云电脑 URL 只显示移除说明。Notebook 独立路径为 `/p/:projectId/notebooks/:notebookId`，供研究空间资料打开。

消息提及通过成员 ID 和正文范围保存于消息元数据，不新增消息表字段。通知使用消息行锁及累计收件人避免并发重复；个人会话和团队讨论的既有可见性边界继续生效。

## 研究空间现有处理整合（2026-11-01）

自动处理由研究模块内的专用规划与执行器组织已有笔记、表格生成、确定性表格计算及图表渲染，不复用具有全项目写入能力的常驻会话工具集。模型、推理强度及 profile 沿用行动／运行选择。内部方案和状态保存在现有运行 JSONB，不新增数据库表、依赖或环境变量。

新行动显式设置 `processing.mode=auto`；旧行动保持固定语义。规划先验证输入范围、依赖顺序、输出槽、列与锁定配置，再调用实际服务。实际计算使用完整固定表，规划阶段样本不能代替完整数据。目标、输出要求、参数和输入结构相同才复用成功方案；输入值变更仍产生新的快照与独立产物。

澄清与人工确认分别表达，成员回答以问题标识、执行状态版本和幂等键保护，在原运行／尝试中恢复。中间快照进入项目隔离存储，最终产物的递归依据链纳入冻结归档；未成功的内部步骤不会向下游或正式成果列表发布。保留既有布局继承、跨运行历史及人工修改边界。

## 17. 个人 Agent 操作目录与统一调用（2026-11-01）

本节更新 §15/§16 的实现范围。研协的有效业务路由逐项登记在 `modules/integrations/catalog*.ts`；Fastify `onRoute` 收集真实路由，覆盖检查报告未分类和缺少契约的操作。分类为开放、网页专用及退役；未知入口关闭。机器可读目录供 REST 脚本与 MCP 共同使用，输入尽量直接从共享 Zod 契约生成，业务层仍做最终校验。

四个通用 MCP 工具负责发现、描述、读取和写入／执行。它们只把登记的操作映射到当前应用内的 REST 路由，复用现有业务守卫及服务，不发往任意外部 URL。内部调用用私有 AsyncLocalStorage 传递已鉴权身份，不能通过请求头伪造，也不重复计分钟额度；所有资源权限检查仍正常执行。九个兼容工具保留，写入统一通过同一调用链。

`integrations/runtime.ts` 在两条传统守卫之外统一执行令牌策略：语义读写、交互专用限制、项目围栏、幂等、日额度和审计。新增表 `api_operation_requests` 保存重试收据与响应；`api_token_write_usage` 保存每令牌 UTC 日额度；`api_operation_audit` 保存不含正文的调用记录。迁移由 drizzle-kit 生成。pending 收据在进程中断后阻止盲目重复执行；幂等缓存重放同样重新授权。它不声称把全部业务服务和外部副作用变成跨系统事务。

日额度沿用 `MCP_WRITE_PER_DAY` 配置，但覆盖全部令牌业务写入，且持久化。审计保留 30 天，不保存 Authorization、分享凭证或请求正文。原 `mcp/limits.ts` 的进程内计数退出调用链。

二进制接口使用受限的编码适配；大文件先按 256 KiB 分块暂存，20 MiB 内校验 SHA-256 后调用既有文件发布服务。临时传输是实例私有状态，重启后未完成上传须重传。通用大响应按令牌绑定分段，使用有容量和有效期上限的实例缓存，权限变化后不能继续读取。

Notebook 增加内容／执行快照分段和带哈希的单元格编辑，直接操作实时 Yjs 文档；复用既有内核调度，不额外引入执行沙箱。研究流程、站内 Agent 的启动／查询／停止沿用原服务；人工批准、成员权限及凭证管理始终保留网页会话。令牌到期／撤销、项目归档和成员／分享变化对持续连接也生效。本轮不增加 Webhook、SSE 或邮件系统。

## 18. 接入：通知订阅（群机器人，`modules/notify`，2026-11-02 新增）

把项目里发生的事推给用户自己的群（飞书 / 企业微信 / 钉钉）。总开关 `NOTIFY_ENABLED`，默认关闭。

**数据**：两张表。`notify_subscriptions`（谁订阅了哪个群、要哪些事件、开关与连续失败次数、`url` 含密钥只写不读 + `url_hint` 打码）；`notify_deliveries`（每条的 payload、人话摘要、状态、尝试次数、下次重试时间、平台响应片段），唯一索引 `(subscription_id, project_id, event_seq)` 做幂等。

**投递链路**（`pump.ts`）：

1. `bus.onEvent` 收到项目事件 → 只处理 7 种可订阅类型；
2. **隐私判定**（`resolveAudience`）：旁聊直接丢弃；个人线程只有主人；收件箱事件只有该条目主人，且 **@ 提醒要按 `sourceId` 回查来源消息与线程**（`timeline/mentions.ts` 会给旁聊里的 @ 也建收件箱条目，标题含正文前 40 字，不回查就等于把旁聊推到群里）；其余按项目可见；
3. 查"仍在该项目且订阅了这类事件"的订阅 → 写 `notify_deliveries`（`onConflictDoNothing` 幂等）；
4. `flushPending` 取到期记录 → **先重新核验成员身份与项目归档状态**（入队后可能被移出项目，失权直接 `dropped`）→ 按平台格式 POST → 成功/失败回写；失败按 `1m/5m/30m/2h/6h` 退避，5 次后 `dropped`；
5. 订阅连续失败 20 次自动停用（`disabledReason` 写明原因）并在主人收件箱留一条提醒。

**消息内容**：只有「【研协】+ 事件说明 + 链接」，**不发正文片段、不复用收件箱标题**（标题可能嵌着原文摘录）。按收件箱 `kind` 用固定文案。

**安全**：

- 只允许三家官方域名 + 正确路径前缀（`assertAllowedUrl`），第一版不做通用 webhook，因此**不需要**走 `fetchPublic`；若以后放开任意地址，必须改用公网守卫。
- 成功判定是"HTTP 2xx **且** 能解析成 JSON **且** 平台 `code/StatusCode/errcode` 为 0"——三家在参数错误、限流、关键词不匹配、签名失败时同样返回 200；空响应和被网关换成 HTML 也按失败处理。
- 地址里的密钥只写不读：接口只给 `urlHint`；打码按 provider 的凭证位置（飞书＝路径末段，企微/钉钉＝`key`/`access_token`）并同时遮蔽其它敏感参数，不做 early return。

**支持范围（本版）**：仅**自定义机器人（群 Webhook）**，即"往机器人所在的群推送"。**不做**：应用机器人（单聊 / 按 `open_id`·`chat_id` 定向 / `app_id`+`app_secret` 换令牌）、签名校验、邮件通知。真机验证仅飞书（企业微信、钉钉未验证，缺凭据）。

**不做的**：通用 webhook（任意地址）、富文本/卡片消息、消息补发与重放、应用机器人、邮件通知（另一步）。

## 文献笔记协作增量（2026-11-01）

L03/L06/L08 笔记部分/L12 使用现有 Yjs、Hocuspocus 和 IndexedDB 能力，没有增加运行时依赖。新版入口复用 ProjectShell 与原侧栏：项目只作为导航上下文，个人数据仍从登录用户与 /library 路由确定；无项目账号使用独立个人导航。

新增 `paper_notes`，归属从 papers 继承，正文同时存可读取文本和 ydoc_state；version 覆盖正文和标题变化，deleted_at 用于软删除与迟到写入保护。来源 published_from 是对团队安全的署名快照，缺省为空。旧 papers.note 保留，网页可复制为独立笔记。迁移 `0022_library_account_collaboration.sql` 由 drizzle-kit 生成，只追加新表、外键、索引和 paper_publications.note_selection 默认列。

服务端主要代码为 library/notes.ts、notes-routes.ts，协同存储注册前缀 lnt。realtime/collab.ts 增加可选 access、validateUpdate、changed 扩展：access 与已审阅上游同名接口保持兼容；普通文档未注册扩展时仍遵循原角色规则。笔记额外在消息进入前检查资源权限、正文长度；实际修改者单独记录，不把点击保存的旁观者误记为作者。同笔记保存串行化，并在 withLiveDocument 持久化前取状态哈希，防保存期间的新编辑被误认为已落库。

发布仍由 publication.ts 管理，源笔记逐条锁定与核对版本，选中笔记和论文在同一事务创建；私人 Y.Doc 历史不跨库复制。说明稿也是一条独立私人笔记，只有用户明确选中发布后才生成团队副本。项目事件只包含已在团队库中的 paperId/noteId，私人的 ID 与正文不随项目事件传播。

2026-11-02 整合：保留 0000—0021 迁移和项目内 personal/team 空间，账号个人库及文献协作增量统一由 drizzle-kit 生成 `0022_library_account_collaboration.sql`。这条链支持从上游数据库升级；旧本地分支已执行的 0012—0017 是另一条迁移历史，不能复制其数据库直接启动本版。旧本地数据迁移需单独准备转换与核验。

### 个人模型与翻译侧栏修复（2026-11-01）

`library/models.ts` 统一文献翻译和问答的模型来源。项目范围沿用 registry；个人范围将平台模型与账号具有项目写入权限的模型合并，查询联接 project_members/projects/llm_providers，过滤访客、归档项目和禁用模型。每次执行重新查权限，模型目录仅返回标识与显示名称；模型服务配置与凭据不复制到个人资料，也不向浏览器返回凭据。个人原文只发送给所选服务，调用本身不发布团队事件。选择项目模型意味着使用该服务的额度和数据处理规则，不等于把个人论文发布到项目。

`library/llm.ts` 为关键词与问答提供范围内调用，不再使用仅依赖环境配置的 collab-common/llm。翻译仍复用 registry 客户端、参数适配和原有取消/限流边界。运行时移除“没有环境变量模型就不启动”的条件，在每轮调用时路由项目模型，因此通过网页新增提供方后不需要重启。没有模型时请求明确失败，配置后由用户重新发送，不自动重试历史任务。

个人会话创建追加 `model` 参数，在根消息触发运行之前校验和保存；省略时使用项目目录默认值。网页新会话提供模型选择器。模型失效的显式创建请求返回 422；旧会话的模型解析兼容策略仍由 registry 管理。

论文阅读页提升选区快照到页面层，以账号/库/论文/文件标识隔离。PDF 和翻译侧栏在标签切换与响应式布局变化时保持挂载，避免丢失阅读进度和请求。翻译使用 500ms 延迟合并连续选择，输入身份标记与 AbortController 防止旧结果覆盖新选区。自动开关和模型选择属于本次阅读内存状态，原文/译文不写浏览器持久存储。本轮没有新增依赖、环境变量或数据库迁移。

### 高亮、批注和团队协作（L04 / L08 / L13，2026-11-01）

`paper_annotations` 通过 paperId 继承个人/项目归属，以 kind 区分独立的 highlight 和 comment。每条保存文件身份快照、PDF hash、页码、引用原文、PDF 用户空间矩形、颜色、说明、署名及版本；批注额外保存 body 和 ydocState。没有“高亮自动携带其私人评论”的关联。fileId 是定位快照而非文件外键：原文件被替换或删除时不能抹掉来源信息。当前 PDF 不匹配时记录仍保留，但停止覆盖显示、跳转和发布。

`modules/library/annotations.ts` 处理存取与协同存储，`annotations-routes.ts` 注册两套同形路径。项目写入在事务内重新检查成员、未归档项目和论文，按成员→项目→论文→标注的固定顺序加锁；事件和更新一并提交后广播。元数据采用 metadataVersion 乐观并发，正文使用现有 Yjs 合并；统一 version 用于预览和删除时的一致性检查。项目所有成员可以维护标注，论文管理/发布权限仍独立。

协同存储注册 `lan` 命名空间，接入已有逐消息鉴权和资源撤权机制；只加载/更新未删除批注，正文最多 100000 字符。删除关闭连接，保留软删除记录；恢复从最后保存正文创建新标注与新 Y.Doc，旧行记录 restoredToId 支持重试。新的标注 ID 隔离旧的 IndexedDB 和离线队列，避免恢复后混入迟到编辑。本轮没有跨版本回溯/审计时间线或离线删除合并策略。

`publication.ts` 扩展 annotations 选择和版本核对，发布事务复制 PDF、解析结果、所选笔记和标注。标注文件 ID 映射到团队文件，安全来源仅包含作者/发布者/来源版本；Y.Doc 从正文重建，不复制私人删除历史或同步关系。发布凭据新增 annotationSelection，旧凭据默认空选择。L10 前仍拒绝向已有同论文追加或覆盖。

前端 `PaperSelectionReader` 提供保存高亮/添加批注入口；`AnnotationsPanel` 显示列表、原文定位、版本冲突、已删除记录和恢复；`AnnotationBodyEditor` 复用 Y.Text 绑定与离线缓存；`AnnotationPublicationPicker` 逐条选择和预览。PDF 覆盖层用 viewport 正向变换把保存坐标还原到当前页面，pointer-events:none，保留拖选行为。批注编辑器在阅读标签切换时保持挂载。没有引入新依赖、LLM 调用或 GROBID 部署要求；普通含文字 PDF 在纯文本降级模式下也能标注。

迁移由 drizzle-kit 生成 `0022_library_account_collaboration.sql`，只增加标注表、论文/页索引和发布凭据字段；空库及保留旧论文/笔记/凭据的内存旧库已验证。与其他分支整合迁移时，须基于实际目标 schema 重新生成未合并迁移，不能只按编号拼接两个目录。

### 持久问答、选择发布与共同维护（L05 / L09 / L14，2026-11-02）

追加 `paper_qa_sessions`、`paper_qa_turns`、`paper_qa_revisions`，归属从 papers 继承，不另设个人/团队开关。sessions 管理目录与软删除；turns 保存独立生成任务、当前可维护正文、不可覆盖的初始输出、来源与生成上下文；revisions 保存人工修改快照。迁移 `0022_library_account_collaboration.sql` 由 drizzle-kit 生成，新增表、外键、索引及 paper_publications.qa_selection 默认列。验证覆盖内存空库和有论文/笔记/标注/凭据的旧库；未操作日常数据库。

`qa-jobs.ts` 接受提交后独立执行检索与模型流，记录进度检查点；HTTP 断开不终止任务。提交在进程内串行完成鉴权、幂等与并发限额检查，实际生成并行。每轮捕获实际使用的最多三条前文版本，不因后续编辑而改变。运行中重新检查资源/模型权限；停止、超时和成员撤权通过 AbortController 取消，保存明确终态和部分正文。启动将无存活任务的旧 running 状态转为 interrupted，避免重复收费。此实现明确用于单后端进程；多实例需增加任务租约、队列和分布式并发管理，不能直接多开实例共享同库。

`qa-records.ts` 管理事务锁、事件、会话和修订。项目写入锁序为成员→项目→论文→会话→轮次，个人写入从论文开始；内部失败收尾仅更新仍在运行的既有轮次，不能创建/复活记录。协同存储注册 lqt，已完成轮次的 question/answer 共同放入 Y.Doc，复用已有输入绑定、撤权与离线缓存；正文变化才递增版本并存修订。多人在同一位置逐字输入可能交错，保证字符合并收敛，不提供语义冲突解决。原始模型输出保留在独立字段中。

`qa-publication.ts` 只从选中当前公开版本创建新记录；引用同篇新团队 PDF 或经发布凭据/PDF 身份/段落文本验证的现有团队来源。未共享引用支持显式标记/移除，不传私有文件链接和检索正文。预览 hash 包含最终问答文本、引用与漏选上下文，发布事务重新计算；变化导致 409。发布后私人和团队没有自动同步关系，团队初始历史从公开版本开始。可制作独立个人说明稿，经用户整理后复用笔记发布；L06 的标注转说明稿入口仍属后续补齐项。

前端 `qa-api.ts`、`QaPanel`、`QaTurnEditor`、`QaPublicationPicker` 分别承担查询/事件、会话与模型任务、协作与修订、逐条选择/全文预览。首次打开问答才挂载，随后切换栏目保留输入及编辑连接；手机阅读区扣除底部导航高度，保证发送按钮可见。无模型不阻断历史记录访问。未新增运行依赖、环境变量或部署服务，旧 qa 流接口保留。GROBID 部署仍不在本轮范围，已降级为可用文本的论文可正常问答。

### 同论文追加、来源说明稿与阅读入口（L06 / L10，2026-11-02）

本节完成前述 L06 标注快捷入口与 L10 的后续部分。`publication-targets.ts` 从明确身份字段及发布历史生成候选；`publication.ts` 在既有项目行锁中核对目标预览版本，按来源记录 ID／版本与目标发布历史过滤已发布记录。追加分支只插入新笔记、标注、问答及凭据，不覆盖团队论文或旧记录。个人新版本作为另一条独立团队记录，团队删除过的同版记录不因重复发布而恢复。标注要求相同 PDF 指纹；不提供跨 PDF 版本的位置迁移或正文语义合并。

`paper_publications` 增加 requestOptions 与 summary，前者记录明确选择的目标及预览时间，后者保留新增／跳过统计。旧凭据的 requestOptions 默认 `{}`，summary 可空，重试仍按原契约执行。`qa-publication.ts` 将目标和选句纳入预览指纹，并验证现有团队来源的 PDF／段落身份；新轮次依赖的已发布前文不会重新复制，其缺失提示要求显式确认，避免把团队当前版本冒充生成时上下文。发布提交后沿用既有项目事件，接收方通过原查询与协作通道看到新增记录。

`annotations.ts` 的说明稿创建复用原件锁与协作正文落库机制，核对 sourceVersion 及内存最新正文，再新建独立 note 与 Y.Doc。只复制当前选中标注，保留来源文字及版本信息，不复制其他私人记录、隐藏历史或自动发布。旧 PDF 定位失效时仍可整理历史文字，正文明确提示复核。问答转说明稿增加原文选句段落。

`paper_qa_turns.selection` 为可空 JSONB，保存文件身份、页码、原文与状态快照。`qa-jobs.ts` 将这段资料与问题分开组织，在缺解析文本时允许基于有效选句解释；不声称选句由服务端全文核验。`QaPanel` 在发送前展示可移除的引用，历史记录展示当时快照并核对当前 PDF 后跳页。此字段不改变最近最多三条问题／答案的前文机制，也不意味着后续提问自动携带此前所有选句。

`useReaderFullscreen` 与 `PaperReaderPage` 保持阅读器及编辑器 DOM，只改变容器布局并尝试浏览器原生全屏；浏览器拒绝时使用应用内全屏。原生全屏作用于 documentElement，兼容已有浮层 portal；处理 Escape、焦点返回、键盘焦点范围、原生退出及晚到请求。手机选区工具保留在原文栏目，用户可选择翻译、标注或引用到问答，宽屏仍保留自动显示翻译。发布候选查询每次打开重新核对，发布成功后失效缓存，防止首次发布后立即追加仍显示“没有同论文”。

迁移 `0022_library_account_collaboration.sql` 由 `pnpm db:generate --name library_append_selection` 生成，只追加上述三列；验证涵盖空库、上游 0021 数据升级及重复启动后的数据保持。无新增依赖、环境变量或外部服务。本轮仅操作临时测试库；上游空间模型已保留，迁移在上游链后生成；旧本地迁移历史不在本次自动转换范围内。

全屏样式仅在 `data-reader-fullscreen=true` 存在时解除工作区祖先的 isolation，并移除页面入场容器的 transform，避免平板宽度的固定阅读器被外层侧栏遮挡或相对动画容器定位。退出后由选择器自动恢复原布局，不修改全站外壳组件。补充 Edge 回归覆盖 12 种外观、四种宽度及 125%／150% 等效 CSS 布局视口下的按钮可达性与草稿保留。

### 单篇文献概括与追问检索修复（2026-11-02）

原流程将“概括文献”等不含专业词的请求直接交给 BM25，零命中时不会进入回答生成。`search.ts` 追加 `paperOverview`，复用既有个人／项目范围索引，按指定论文选择有界概览；`qa.ts` 将相关段落与概览去重合并，最多 12 段。选取兼容 GROBID 章节和逐页纯文本：优先首尾、摘要和主要章节，再按位置补足。章节名明确为参考文献的段落不进入概览；纯文本没有章节名时无法可靠识别参考文献边界，因此不能视为准确的全文总结。保留原有引用身份，不重新编号论文段落。

`qa-jobs.ts` 将提交时冻结的历史传入检索与生成。检索只使用最近两条历史问题，不把历史模型答案当作事实来源。单篇问题都可获得概览补充，无须限定用户必须输入某个“总结”关键词；全库仍要求相关性命中。缺资料且没有选句时，持久任务保存 `failed` 与明确错误，不再把固定提示存成模型已完成的正文；旧流端点保持原帧协议。生成提示要求区分节选与全文、历史对话与论文证据，按概括、解释、比较或追问等实际任务作答。

本轮没有新增依赖、迁移或真实模型调用，也不改变既有记录。测试使用内存 PGlite 和模拟模型验证“检索后确实把正文交给回答模型”、来源隔离和无资料失败；实际模型的概括质量仍需用真实论文人工验收。

### 章节取材与选句问答入口修复（2026-11-02）

实际 PDF 验证发现：纯文本解析已保留引言正文，但章节词被附加到每个段落的索引后，短页眉与图中文字可能比长正文得到更高的 BM25 分数。`qa-context.ts` 追加问答材料清理、正文候选选择、章节请求匹配与字符预算；`search.ts` 的 `paperSection` 复用按归属隔离的索引，选择指定章节及子节。全篇概括直接使用清理后的概览，普通问题仍保留关键词检索。原始解析结构不改写，因此已有正确解析的数据可直接受益，无需再次解析；未识别的章节或实际缺失的正文仍是能力边界。

章节材料不再固定截掉每段 1800 字符后的内容，改用每段 6000／总量 24000 字符的有界预算，最多 24 段。原始坐标和段落身份继续复用；`qa-jobs.ts` 保存模型实际收到的文本，`qa-publication.ts` 按保存引用的实际长度核对目标段落，兼容旧记录。没有新增数据库字段、迁移、运行依赖或真实模型调用。

`PaperSelectionReader` 将工具条引号图标改为文字按钮；`SelectionAnnotationMenu` 接受独立的选句问答回调，按权限显示第三个文字操作。点击仍由阅读页把选句传入 `QaPanel`，发送前展示可移除的原文快照，不直接生成答案。菜单保留既有选区保护和键盘操作。验证采用真实 PDF 本地解析／取材对照、内存数据库回归和隔离 Edge 页面；实际模型输出质量需人工复核。

## 文献空间整合约定（2026-11-02）

本版同时保留三种归属：账号个人库（`projectId=null, ownerUserId=本人`）、项目内个人文献（`projectId=项目, space=personal, ownerUserId=本人`）、团队文献（`projectId=项目, space=team, ownerUserId=null`）。同一论文可在三种范围各自保存。账号库的去重索引仅作用于 `project_id IS NULL`。

账号个人库通过 `/library` 使用，发布时生成独立团队副本；选中的笔记、标注和问答只复制当前正文与来源署名，不复制私人协同历史。项目内个人文献保留上游分享链接及移动机制；链接分享继续操作同一份资料，与独立副本发布的行为不同。发布目标仅匹配团队文献，追加同版本内容会跳过，团队已修改的内容不会被覆盖。

项目内个人论文的笔记、批注和问答继承论文分享权限，撤销分享或改变空间会断开对应子文档的既有及鉴权中连接。团队持久问答只检索团队资料；私人项目论文持久问答可使用团队资料和当前私人论文。账号个人记录不进入项目事件流。上游私人 PDF 用 `private:<hash>` 作为阅读定位的稳定标识，文件读取仍通过论文授权接口。

新增文献路由在接入操作目录逐条标记为 `interactive`，当前只接受网页登录会话，不因令牌具备项目写权限就开放个人数据或发布操作。PDF 导入上限跟随上游为 100 MB。
