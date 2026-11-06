# CONTRIBUTING.md · 贡献指南

欢迎参与「研协」的开发！这份文档写给贡献者，也写给大家各自用的 AI agent（Claude Code、Codex、Cursor 等）。和 [ARCHITECTURE.md](ARCHITECTURE.md)、[API.md](API.md)、[STYLE.md](STYLE.md)、[deploy/README.md](deploy/README.md) 冲突时以那几份为准，并欢迎在 PR 里顺手修正本文。

给 agent 的精简版守则在 [AGENTS.md](AGENTS.md)。

## 0. 开工前先读

| 你要改的东西                                  | 先读                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 任何代码                                      | 本文；ARCHITECTURE.md §2（目录与归属）、§5（一致性）、§10（并行开发规则）                         |
| 接口、事件、WebSocket 帧                      | API.md §1（通用约定）和对应模块小节；`packages/shared/src`                                        |
| 任何界面                                      | STYLE.md 全文，交付前过一遍 §9 自查清单                                                           |
| agent 提示词、agent 工具                      | [apps/server/prompts/README.md](apps/server/prompts/README.md) §4（修改规则）、ARCHITECTURE.md §7 |
| `deploy/`、`docker-compose.yml`、`Dockerfile` | deploy/README.md、ARCHITECTURE.md §11                                                             |

## 1. 本地环境与启动

**版本**：Node ≥ 22.12（推荐 24，见 `.nvmrc`）；pnpm 11（`packageManager` 锁定版本，`corepack enable` 即可拿到同一版本）。本地**不需要** Docker 或 Postgres。

```bash
pnpm install
cp .env.example .env    # 按需填写，见下
pnpm dev                # 并行启动 server(:8787) 与 web(:5173)，web 代理 /api /ws /collab
```

打开 http://localhost:5173 。健康检查 `GET http://localhost:8787/api/health`。`DB_AUTO_MIGRATE=true` 时服务启动会自动执行迁移。

| 命令                                  | 作用                                        |
| ------------------------------------- | ------------------------------------------- |
| `pnpm dev` / `dev:server` / `dev:web` | 同时 / 单独启动后端与前端（热更新）         |
| `pnpm check`                          | `lint` + `typecheck` + `test`，开 PR 前必跑 |
| `pnpm format` / `format:check`        | Prettier 格式化 / 检查                      |
| `pnpm build`                          | 构建 shared、web、server                    |
| `pnpm db:generate --name <描述>`      | 改了 `db/schema/*.ts` 后生成迁移（§5.3）    |
| `pnpm db:migrate` / `db:studio`       | 手动迁移 / 打开 Drizzle Studio              |

**`.env`**（从 `.env.example` 复制；`.env` 已在 `.gitignore`，永远不要提交）：

- `DATABASE_URL` 留空 = 用嵌入式 PGlite，数据在 `apps/server/.data/pglite`。想从零开始就停掉服务删掉这个目录。填 `postgres://…` 则用真 Postgres。
- `LLM_API_KEY`：用你自己的 DeepSeek（或其他 OpenAI 兼容服务）key。不填也能启动，只是 agent 不会回复。
- 其余开关默认关，需要时再开：`AGENT_WEB`（联网搜索，ARCHITECTURE.md §12）、`GROBID_URL`（论文解析，本地可 `docker run --rm --init -p 8070:8070 grobid/grobid:0.9.1-crf`）、`KERNEL_MODE`（Notebook 内核）。每个变量的含义写在 `.env.example` 的注释里。
- 新增环境变量时，同一个 PR 里在 `.env.example` 加占位和注释；部署相关的再同步 deploy/README.md。

**Windows 用户注意编码**：仓库统一 UTF-8、LF（`.editorconfig`、`.gitattributes`）。Windows PowerShell 5 的 `Set-Content`、`Out-File`、`>` 默认不写 UTF-8，容易把中文写坏。用编辑器或 PowerShell 7 的 `-Encoding utf8NoBOM` 写文件；提交前看一眼 `git diff`。

## 2. Fork 与 PR 流程

1. 在 GitHub 上 fork 本仓库，克隆你的 fork，并添加上游：`git remote add upstream <本仓库地址>`。
2. 从最新的上游主分支拉分支：`git fetch upstream && git switch -c <类型>/<主题> upstream/main`。分支名全小写、短横线连接，例如 `feat/notebook-export`、`fix/auth-field-errors`。
3. 一个分支只做一件事。较大的改动建议先开 Issue 或 Draft PR 说明思路，避免和别人重复。
4. 推送前把最新上游合进来（`git rebase upstream/main` 或 `git merge upstream/main`），然后重跑 `pnpm check`。迁移和 lockfile 冲突按 §5.3、§5.4 处理。
5. 推到你的 fork，向本仓库 `main` 开 PR。描述按 [.github/pull_request_template.md](.github/pull_request_template.md) 填：背景、做法、影响面（契约 / 迁移 / 依赖 / 部署 / 安全）、验证、界面截图。
6. PR 只放和这件事有关的改动；临时脚本、测试数据、本地截图不要进仓库。PR 描述和评论里不要出现密钥或凭据。
7. 维护者 review 通过后合并。PR 提示有冲突时，请在自己分支里合进最新上游、解决冲突、重跑 `pnpm check` 再推。

## 3. Commit 规范

格式（Conventional Commits，摘要中英文均可）：

```
<类型>(<范围>): <摘要>
```

- **类型**：`feat`、`fix`、`docs`、`test`、`perf`、`refactor`、`chore`。
- **范围**：模块名或层，和目录对应，例如 `server`、`web`、`agents`、`collab`、`library`、`notebooks`、`deploy`。跨很多模块时可以省略。
- **摘要**：写用户能感知到的效果，而不是「修改了 xx 文件」。
- 不提交：`.env`、`.data/`、`dist/`、日志、大体积生成物。

## 4. 质量门：`pnpm check` 与测试

**开 PR 前本地必须通过** `pnpm check`（= `pnpm lint && pnpm typecheck && pnpm test`）。CI（`.github/workflows/ci.yml`）还会跑 `pnpm install --frozen-lockfile`、`pnpm format:check`、`pnpm build`，并构建 Docker 镜像冒烟测试 `/api/health`。完整的本地自查：

```bash
pnpm format:check && pnpm check && pnpm build
```

如果整仓 `format:check` 因历史文件失败，至少保证你改过的文件通过：`pnpm exec prettier --check <文件>`，不要在功能 PR 里格式化无关文件。

**测试要求**（vitest）：

| 改动                     | 要写的测试                                                                                     | 放哪里                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 新增或修改 REST 端点     | 用 `apps/server/src/app.ts` 组装的应用直接 `inject`（PGlite 建库），覆盖成功、无权限、校验失败 | `apps/server/test/<模块>/*.test.ts`                           |
| 修 bug                   | 先写能复现的回归测试，修完转绿                                                                 | 和被测代码同一处                                              |
| 纯函数、解析器、导入导出 | 单元测试，带小而真实的样例（放 `test/fixtures/`）                                              | 后端 `apps/server/test/`；前端与被测文件同目录 `*.test.ts(x)` |
| `packages/shared`        | schema 与工具函数的单元测试                                                                    | `packages/shared/test/`                                       |
| 界面                     | 逻辑抽到 `lib/` 写单元测试；界面按 STYLE.md §9 手动过一遍，并在 PR 里附截图                    | 与组件同目录                                                  |

- 不要为了让 CI 变绿而删测试、`skip` 测试或放宽断言。
- 需要真实网络或真实模型 key 的脚本（如 `pnpm --filter @srh/server e2e:agent`）不进 CI，改到相关功能时手动跑一次，把结论写进 PR。
- 个别前端测试在机器负载高时可能偶发超时，单独重跑确认即可，并在 PR 里注明。

## 5. 模块归属与避免冲突

### 5.1 谁改哪里

模块的目录与归属见 [ARCHITECTURE.md §2.1](ARCHITECTURE.md#21-并行开发的落点谁改哪里)。一个模块的典型形状是：`apps/server/src/modules/<名>`、`apps/server/src/db/schema/<名>.ts`、`packages/shared/src` 里的同名文件、`apps/web/src/features/<名>`。新增模块照这个形状建，不要往别的模块文件里塞代码；需要改其他模块时在 PR 里说明原因。

### 5.2 `packages/shared` 和共享登记文件

- `packages/shared` 是前后端的契约代码，**只追加，不改名、不删除**（ARCHITECTURE.md §10）。必须改已有字段时，在 PR 描述里列出所有受影响的调用方。
- 新模块新建自己的契约文件，再在 `index.ts` 末尾加一行导出。新增事件登记到自己模块的事件表，并同步 API.md §4。
- 共享登记文件（`modules/index.ts`、`app/router.tsx`、`db/schema/index.ts`、`packages/shared/src/index.ts`）只在末尾追加。

### 5.3 数据库迁移

迁移在 `apps/server/drizzle/`，由 drizzle-kit 维护 `meta/`。

1. 只改相关模块的 schema 文件，然后同步到最新上游，再 `pnpm db:generate --name <英文描述>`。不要手写编号或手改 `meta/`。
2. **已经合并的迁移文件永远不改**，要改表结构就生成新迁移。
3. 编号冲突时：删掉自己生成的迁移、对应 snapshot 和 `_journal.json` 条目，同步上游后重新生成。
4. 验证：删掉 `apps/server/.data/pglite` 从空库启动一次 `pnpm dev`，再在有旧数据的库上启动一次，两次都要迁移成功。

### 5.4 依赖与 `pnpm-lock.yaml`

- 加依赖：`pnpm --filter <包名> add <依赖>`（`@srh/server`、`@srh/web`、`@srh/shared`）。后端运行时要用的包必须放 `dependencies`，否则生产镜像里没有。
- lockfile 冲突不要手工合并：

  ```bash
  git checkout upstream/main -- pnpm-lock.yaml
  pnpm install
  git add pnpm-lock.yaml
  ```

## 6. 接口文档、国际化与界面规范

**接口变更必须同步 API.md**，和代码在同一个 PR 里（端点、事件、`/ws` 与 `/collab` 协议帧、错误码）。代码真相源是 `packages/shared`。架构层面的变化同步 ARCHITECTURE.md；提示词和 agent 工具名的改动按 apps/server/prompts/README.md §4 同步。

**国际化（中 / 英）**：源码里的用户可见文案写中文，并包在翻译函数里：

- 前端：`tr('中文文案')`，带变量用 `tr('已选 {count} 项', { count })`。英文译文写在 `apps/web/src/i18n/en/` 下对应的 JSON（`web.json`、`shared.json`、`server.json`），键就是中文原文。
- 后端：返回给用户的文案用 `trServer('中文')`（`@srh/shared`），英文同样登记在 `apps/web/src/i18n/en/server.json`。
- `apps/web/src/i18n/*.test.ts` 会检查缺失的译文；跑 `pnpm check` 时一并覆盖。

**界面必须遵守 [STYLE.md](STYLE.md)**，交付前逐条过 §9 自查清单：只用语义颜色 token、动画用 `lib/motion.ts` 预设并遵守 `prefers-reduced-motion`、复用 `components/ui`、处理空 / 加载 / 错误状态、360px 与桌面宽度及亮 / 暗色都看过。

## 7. 让 AI agent 参与

- [AGENTS.md](AGENTS.md) 是给 agent 的守则。Codex、Cursor 等会自动读取；Claude Code 读取 `CLAUDE.md`（内容是 `@AGENTS.md`）。
- 用不读这些文件的工具时，在第一条消息里要求它先读 AGENTS.md 和 CONTRIBUTING.md。
- 一个 agent 一个分支（或 worktree），只改任务相关的路径。
- PR 描述写明哪些部分是 agent 写的。**提交 PR 的人对全部内容负责**，自己读过 diff 再请别人 review。

## 8. Code review

Reviewer 主要看：

1. 改动是否聚焦，有没有夹带无关改动；
2. 契约是否同步：`packages/shared`、API.md、ARCHITECTURE.md、`.env.example`；
3. 测试是否覆盖新行为与修复的 bug，CI 是否通过；
4. 界面是否符合 STYLE.md；
5. 迁移能否在空库和旧库上执行；
6. 安全：没有密钥，没有绕过鉴权和网络守卫，外部内容被当作数据而不是指令。

涉及鉴权与会话（`modules/auth`、`realtime/access.ts`）、公网守卫（`websearch/net.ts`）、MCP 内网过滤、Notebook 内核隔离与防火墙脚本的改动，review 会更严格，请在 PR 里写清楚威胁模型和验证方式。

## 9. 安全

1. **任何 API key、密码、私钥只放 `.env`**（已 gitignore）。不进代码、测试、fixture、`.env.example`、commit、PR、Issue 或日志。万一泄露，请立刻到服务商处作废并换新——只删除 commit 不算处理完。
2. 自托管部署的 `SESSION_SECRET`、数据库密码等只放服务器上的 `.env`（权限 600）。
3. 发现安全漏洞请不要公开提 Issue，先私下联系维护者（如 GitHub 的 Security Advisory）。

## 附：开 PR 前自查

- [ ] 从最新上游主分支拉的分支，推送前又同步过一次
- [ ] `pnpm format:check && pnpm check && pnpm build` 通过（或改动文件格式化通过）
- [ ] 新行为有测试，修的 bug 有回归测试
- [ ] 接口改动已同步 API.md 和 `packages/shared`；新环境变量已加进 `.env.example`
- [ ] 新增文案已用 `tr` / `trServer` 包裹并补了英文
- [ ] 改了界面：过了 STYLE.md §9，附了截图
- [ ] 迁移是新生成的，空库和旧库都能迁移
- [ ] diff 里没有密钥、没有乱码、没有无关文件
