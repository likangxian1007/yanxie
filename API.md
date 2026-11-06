# API.md · 接口约定

> REST + WebSocket 契约。类型与校验的**代码真相源**是 [`packages/shared`](packages/shared/src)：实体形状看 `entities.ts`，请求体看 `api.ts`，事件看 `events.ts`，WS 帧看 `ws.ts`，错误码看 `errors.ts`。本文与代码不一致时以代码为准，并顺手修正本文。

## 1. 通用约定

| 项       | 约定                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前缀     | 业务接口 `/api/v1/...`；健康检查 `/api/health`（无版本）                                                                                                                                                                                                  |
| 格式     | JSON，UTF-8；字段 camelCase；时间 ISO 8601（UTC）；可空字段返回 `null` 不省略                                                                                                                                                                             |
| 鉴权     | 登录后服务端下发 `srh_session` Cookie（HttpOnly、SameSite=Lax、生产环境 Secure）；前端 `fetch` 一律 `credentials: 'include'`。未登录 → `401 unauthorized`                                                                                                 |
| 权限     | 项目内接口都在 `/projects/:projectId/...` 下，服务端先校验成员身份与角色（ARCHITECTURE.md §9），无权 → `403 forbidden`；不存在或不可见 → `404 not_found`（不泄露存在性）                                                                                  |
| 校验     | 请求体用 `@srh/shared` 的 zod schema（`parse(Schema, req.body)`）；失败 → `422 validation_failed`，`details.issues = [{path, message}]`；第一条原因是中文时 `message` 直接是它（多条时加「另有 N 处要修改」），前端应把 issues 按 path 显示到对应输入框下 |
| 成功响应 | 单个对象直接返回对象；创建返回 `201` + 对象；删除返回 `204`；列表返回 `Page<T>`                                                                                                                                                                           |
| 分页     | 游标分页：`?cursor=&limit=`（默认 50，最大 100）→ `{ items, nextCursor }`；`nextCursor=null` 表示没有更多。游标不透明，原样传回。时间线与消息默认**新到旧**，`?order=asc` 反向                                                                            |
| 乐观并发 | 可多人改的结构化对象（卡片、实验、汇报、记忆）写入带 `baseVersion`；过期 → `409 version_conflict`，`details.current` 为最新对象                                                                                                                           |
| 认领冲突 | agent 写入未认领或被他人独占的资源 → `409 claim_conflict`，`details.claims` 为冲突认领                                                                                                                                                                    |
| 错误体   | `{ "error": { "code": "not_found", "message": "中文可读说明", "details"?: {...} } }`                                                                                                                                                                      |
| 实时     | 所有写操作都会发布对应事件（§4）；前端写完**不需要**手动刷新列表，靠事件更新缓存（也可以乐观更新）                                                                                                                                                        |
| 幂等     | 反应 `PUT`、认领续期、`start_thread` 均幂等；创建接口可带 `Idempotency-Key` 头（后端线程实现）                                                                                                                                                            |

错误码（`ERROR_STATUS`）：`bad_request 400`、`unauthorized 401`、`forbidden 403`、`not_found 404`、`conflict 409`、`version_conflict 409`、`claim_conflict 409`、`validation_failed 422`、`rate_limited 429`、`internal 500`、`not_implemented 501`、`llm_unavailable 503`。

## 2. REST 端点

`P` = `/projects/:projectId`。请求体列为 `@srh/shared` 中的 schema 名；响应为 `entities.ts` 中的类型。**归属**：B = 后端与 agent 引擎线程，C = 协作功能线程，F = 脚手架（已实现）。

### 2.0 系统（F）

| 方法 | 路径          | 请求 | 响应                                 |
| ---- | ------------- | ---- | ------------------------------------ |
| GET  | `/api/health` | —    | `HealthResponse`；数据库不通返回 503 |

### 2.1 认证与用户（B · `modules/auth`）

| 方法  | 路径                           | 请求                                                                   | 响应                                                                                      |
| ----- | ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| POST  | `/auth/register`               | `RegisterInput`                                                        | `User`（并设置 Cookie）；带 `inviteToken` 时同时加入项目                                  |
| POST  | `/auth/login`                  | `LoginInput`                                                           | `User`                                                                                    |
| POST  | `/auth/logout`                 | —                                                                      | 204                                                                                       |
| POST  | `/auth/password/request-reset` | `PasswordResetRequestInput { email }`                                  | 202 `{ ok: true }`；邮箱是否注册都一样，注册过才发重置邮件（见 §6「找回密码」）           |
| POST  | `/auth/password/reset`         | `PasswordResetInput { token, password }`                               | `{ ok: true }`；令牌无效 / 过期 / 已用 400；成功后该用户所有会话失效                      |
| GET   | `/auth/me`                     | —                                                                      | `{ user: User, projects: (Project & { role })[] }`                                        |
| PATCH | `/auth/me`                     | `UpdateMeInput`                                                        | `User`                                                                                    |
| GET   | `/auth/me/pins`                | —                                                                      | `MyPins`（`{ [projectId]: id[] }`，我的置顶，跟账号走；只含我仍是成员的项目，空的不返回） |
| PUT   | `/auth/me/pins/:projectId`     | `PinsUpdateInput { ids }`（≤ 50 个，整组替换，越靠前越新，服务端去重） | `{ projectId, ids }`；要求是项目成员（含 guest），否则 404；只属于本人，不发事件          |

### 2.2 项目、成员、邀请（B · `modules/projects`）

| 方法                 | 路径                     | 请求                 | 响应                                                   |
| -------------------- | ------------------------ | -------------------- | ------------------------------------------------------ |
| GET                  | `/projects`              | —                    | `(Project & { role, unread })[]`                       |
| POST                 | `/projects`              | `ProjectCreateInput` | `Project`（同时创建协调者会话、默认看板、`MEMORY.md`） |
| GET / PATCH / DELETE | `P`                      | `ProjectUpdateInput` | `Project`                                              |
| GET                  | `P/members`              | —                    | `ProjectMember[]`                                      |
| PATCH / DELETE       | `P/members/:userId`      | `MemberUpdateInput`  | `ProjectMember` / 204                                  |
| GET / POST           | `P/invites`              | `InviteCreateInput`  | `Invite[]` / `Invite`（含链接 token）                  |
| DELETE               | `P/invites/:inviteId`    | —                    | 204（撤销邀请）                                        |
| POST                 | `/invites/:token/accept` | —                    | `Project`                                              |

### 2.3 时间线与消息（B · `modules/timeline`）

| 方法           | 路径                                     | 请求                 | 响应 / 说明                                                                         |
| -------------- | ---------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| GET            | `P/timeline`                             | `PageQuery`          | `Page<Message>`（顶层消息，含 `rootOfThreadId`；配合 `GET P/threads` 渲染线程卡片） |
| POST           | `P/timeline`                             | `MessageCreateInput` | `Message`；`agentVisible=true` 时唤醒协调者                                         |
| GET            | `P/messages/:messageId`                  | —                    | `Message`；站内引用 `#msg_…` 用它查消息在时间线还是哪个线程（别人的个人会话 → 404） |
| PATCH / DELETE | `P/messages/:messageId`                  | `MessageUpdateInput` | 只能改/删自己的                                                                     |
| PUT            | `P/messages/:messageId/reactions`        | `ReactionInput`      | `Message`                                                                           |
| DELETE         | `P/messages/:messageId/reactions/:emoji` | —                    | `Message`                                                                           |

### 2.4 线程、个人工作区、决策卡（B · `modules/threads`）

| 方法        | 路径                             | 请求                                                      | 响应 / 说明                                                                                                              |
| ----------- | -------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET         | `P/threads`                      | `?kind=project\|personal&bucket=&resolved=` + `PageQuery` | `Page<Thread>`；`kind=personal` 只返回自己的                                                                             |
| POST        | `P/threads`                      | `PersonalThreadCreateInput`                               | `Thread`（新建个人会话，唤醒个人 agent）；可带 `profile`（slug），建会话时一起写入，第一轮就按它跑；profile 不存在 → 422 |
| GET / PATCH | `P/threads/:threadId`            | `ThreadUpdateInput`                                       | `Thread`；`statusText` = 成员直接改计划（≤ 4000 字，guest 403），agent 下一轮在 session-context 里读到                   |
| GET         | `P/threads/:threadId/messages`   | `PageQuery`                                               | `Page<Message>`                                                                                                          |
| POST        | `P/threads/:threadId/messages`   | `MessageCreateInput`                                      | `Message`；唤醒该线程 agent                                                                                              |
| POST        | `P/threads/:threadId/forward`    | `ThreadForwardInput`                                      | `Message`（时间线上的 `kind=forward` 卡片）；唤醒协调者                                                                  |
| GET         | `P/decisions/:decisionId`        | —                                                         | `Decision`；站内引用 `#dec_…` 用它找到卡片所在的消息（`messageId` / `threadId`）                                         |
| POST        | `P/decisions/:decisionId/answer` | `DecisionAnswerInput`                                     | `Decision`；唤醒卡片所在线程                                                                                             |

### 2.5 Agent 透明度（B · `modules/agents`）

| 方法 | 路径                         | 请求                     | 响应 / 说明                                                                                                                 |
| ---- | ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET  | `P/agents`                   | —                        | `AgentSession[]`（协调者 + 各线程 agent 的状态、正在做什么、为谁工作）                                                      |
| GET  | `P/agents/:sessionId`        | —                        | `AgentSession`                                                                                                              |
| GET  | `P/agents/:sessionId/steps`  | `PageQuery` + `?turnId=` | `Page<AgentStep>`（导师查看“思路”）                                                                                         |
| POST | `P/agents/:sessionId/stop`   | —                        | `AgentStopResult` = `AgentSession & { stopped: 'turn' \| 'queued' \| 'none' }`（中止当前 turn，并取消排队、还没开始的唤醒） |
| POST | `P/agents/:sessionId/resume` | —                        | `AgentSession`（让停下或空闲的 agent 接着做，状态变 `queued`）                                                              |

### 2.6 记忆、认领、定时、文件、收件箱（B）

| 方法           | 路径                        | 请求                                                                | 响应 / 说明                                                      |
| -------------- | --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| GET            | `P/memory`                  | —                                                                   | `Omit<MemoryFile,'content'>[]`                                   |
| GET            | `P/memory/*`                | —                                                                   | `MemoryFile`                                                     |
| PUT            | `P/memory`                  | `MemoryWriteInput`                                                  | `MemoryFile`；`baseVersion` 过期 → 409                           |
| DELETE         | `P/memory/*`                | `?baseVersion=`                                                     | 204                                                              |
| GET            | `P/claims`                  | `ClaimListQuery`（`?status=&resourceKind=&resourceRef=&threadId=`） | `WorkClaim[]`                                                    |
| POST           | `P/claims`                  | `ClaimCreateInput`                                                  | `WorkClaim`；重叠 → 409 `claim_conflict` 并发布 `claim.conflict` |
| POST           | `P/claims/:claimId/renew`   | `{ ttlSec? }`                                                       | `WorkClaim`                                                      |
| DELETE         | `P/claims/:claimId`         | —                                                                   | 204（释放）                                                      |
| GET / POST     | `P/routines`                | `RoutineCreateInput`                                                | `Routine[]` / `Routine`                                          |
| PATCH / DELETE | `P/routines/:routineId`     | `RoutineUpdateInput`                                                | `Routine` / 204                                                  |
| POST           | `P/routines/:routineId/run` | —                                                                   | 202                                                              |
| GET            | `P/files`                   | `?dir=`                                                             | `FileObject[]`                                                   |
| POST           | `P/files`                   | `multipart/form-data`（`file`，可选 `path`）                        | `FileObject`                                                     |
| GET            | `P/files/:fileId`           | `?download=1`                                                       | 文件流                                                           |
| DELETE         | `P/files/:fileId`           | —                                                                   | 204                                                              |
| GET            | `P/outputs`                 | `?kind=` + `PageQuery`                                              | `Page<OutputRef & { threadId, messageId, createdAt }>`（资料库） |
| GET            | `/inbox`                    | `?projectId=&done=false`                                            | `InboxItem[]`（按优先级、时间排序）                              |
| PATCH          | `/inbox/:itemId`            | `{ read?: boolean, done?: boolean }`                                | `InboxItem`                                                      |
| GET            | `P/events`                  | `?afterSeq=&limit=`                                                 | `AnyProjectEvent[]`（WS 不可用时的补拉）                         |

### 2.7 协同文档（C · `modules/documents`）

协作模块（§2.7–§2.11）的“角色”列：`view` = 全部成员（含访客 guest）；`write` = owner / advisor / member（访客 → `403 forbidden`）；`manage` = owner / advisor。非成员或项目不存在 → `404 not_found`。

| 方法   | 路径                                        | 角色  | 请求                                                                                                                          | 响应 / 说明                                                                                                                                                                               |
| ------ | ------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/docs`                                    | view  | `?archived=true\|false\|1\|0&kind=&parentId=`                                                                                 | `DocumentMeta[]`，按 `updatedAt` 倒序；默认只列未归档；`parentId` 为等值过滤，树由前端按 `parentId` 组装                                                                                  |
| GET    | `P/docs/search`                             | view  | `?q=`（≤200 字）                                                                                                              | `DocumentSearchHit[]`：标题或正文快照包含 `q`（不区分大小写），不含归档，最多 20 条；`q` 为空返回 `[]`                                                                                    |
| POST   | `P/docs`                                    | write | `DocumentCreateInput`（`title` 默认“未命名文档”、`kind` 默认 `doc`、`parentId`、`icon`、`markdown?` 初始内容，规则见 §2.7.2） | `201 DocumentMeta`；`parentId` 不存在 → 404；发 `document.created`                                                                                                                        |
| POST   | `P/docs/import`                             | write | octet-stream Yjs 状态 + `DocumentImportQuery`（§2.7.6）                                                                       | `201 DocumentMeta`；从文件导入，文档与内容原子写入                                                                                                                                        |
| GET    | `P/docs/:docId`                             | view  | —                                                                                                                             | `DocumentMeta`                                                                                                                                                                            |
| PATCH  | `P/docs/:docId`                             | write | `DocumentUpdateInput`（`title` / `parentId` / `icon` / `archived`）                                                           | `DocumentMeta`；`archived` 写 / 清 `archivedAt` 并断开该文档的 `/collab` 连接（重连按新状态读写，§3.2）；空标题改回“未命名文档”；移到自己或子孙文档下 → 422；发 `document.updated`        |
| DELETE | `P/docs/:docId`                             | write | —                                                                                                                             | 204；先断开该文档全部 `/collab` 连接，子文档挂到上一级；发 `document.deleted`                                                                                                             |
| GET    | `P/docs/:docId/markdown`                    | view  | —                                                                                                                             | `DocumentContent { meta, markdown, outline }`（§2.7.2）；有人在线编辑时取内存里的最新状态                                                                                                 |
| POST   | `P/docs/:docId/edit`                        | write | `DocumentEdit`（§2.7.3）                                                                                                      | `{ meta, markdown }`（编辑后的全文）；作为一次服务端 Yjs 事务应用并立即落库，发 `document.updated`；已归档 → `409 conflict`；op 不支持该类型 → `400 bad_request`；标题 / 文本找不到 → 404 |
| POST   | `P/docs/:docId/ai`                          | write | `DocumentAiInput`                                                                                                             | `200 text/plain` 流（§2.7.4），不写文档                                                                                                                                                   |
| GET    | `P/docs/:docId/versions`                    | view  | —                                                                                                                             | `DocumentVersion[]`（新到旧）                                                                                                                                                             |
| POST   | `P/docs/:docId/versions`                    | write | `DocumentVersionCreateInput { label }`                                                                                        | `201 DocumentVersion`（快照当前在线状态）；发 `document.version_created`                                                                                                                  |
| GET    | `P/docs/:docId/versions/:versionId`         | view  | —                                                                                                                             | `{ version: DocumentVersion, markdown }`                                                                                                                                                  |
| POST   | `P/docs/:docId/versions/:versionId/restore` | write | —                                                                                                                             | `DocumentMeta`；先自动存一个“恢复「label」前自动保存”版本（`document.version_created`），再在服务端 Y.Doc 上整体替换正文（在线编辑者实时看到，`document.updated`）                        |

**行内评论与 @提及**（只用于 `kind = doc`）：

| 方法   | 路径                                | 角色  | 请求                                                                    | 响应 / 说明                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------- | ----- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/docs/:docId/comments`            | view  | —                                                                       | `DocComment[]`（旧到新，含回复；前端按 `parentId` 分串）                                                                                                                                                                                                                           |
| POST   | `P/docs/:docId/comments`            | write | `DocCommentCreateInput { body, parentId?, anchor?, quote?, mentions? }` | `201 DocComment`；`parentId` 指向回复时自动挂到首条；回复已解决的串会自动重新打开（再发一条 `document.comment_updated`）；`mentions` 只保留项目成员（去掉自己），每人一条 `mention` 收件箱项（`href = /p/:pid/docs/:docId?comment=<首条 id>`）；回复还会提醒首条作者；非 doc → 400 |
| PATCH  | `P/docs/:docId/comments/:commentId` | write | `DocCommentUpdateInput { body?, mentions?, resolved? }`                 | `DocComment`；改 `body` 只限作者（否则 403），新增的 @ 发提醒；`resolved` 只对首条（回复 → 422），解决后这串评论的收件箱项标记完成；发 `document.comment_updated`                                                                                                                  |
| DELETE | `P/docs/:docId/comments/:commentId` | write | —                                                                       | 204；作者或 owner / advisor（否则 403）；删首条连同回复；发 `document.comment_deleted { id, documentId }`                                                                                                                                                                          |
| POST   | `P/docs/:docId/mentions`            | write | `DocMentionInput { userIds, context? }`                                 | `{ notified: string[] }`：正文里插入 @提及节点后由前端调用，给成员发 `mention` 收件箱项（同一文档未处理的提醒合并成一条，`sourceId = <docId>:mention`）                                                                                                                            |

锚点 `DocCommentAnchor { start, end }` 是选区两端的 `Y.RelativePosition`（`Y.relativePositionToJSON`），不写进文档内容；各端按 Yjs 结构换算回当前位置，并发编辑后仍指向同一段文字，原文被删掉时前端把这串评论标成“原文已删除”。agent 用 `edit` 写进正文的 `[@名字](mention:<userId>)` 也会给新出现的成员发同样的提醒。访客可以看评论，不能写。暂不支持 @agent。

`DocumentMeta.excerpt` = 正文 markdown 去掉标记后的前 200 字。正文的实时编辑走 `/collab/:documentId`（§3.2）；agent 与脚本走 `edit`。

#### 2.7.1 Y.Doc 结构（`YDOC_FIELD`，`entities-collab.ts`）

| kind     | 字段                          | 结构                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doc`    | `default`                     | Y.XmlFragment（Tiptap Collaboration 默认字段）；节点集合见 `modules/documents/pm-schema.ts`（StarterKit、TaskList/TaskItem、Table、Highlight、TextAlign、InlineMath/BlockMath，以及 `pm-nodes.ts` 的 image / fileAttachment / docEmbed / mention，`pm-word.ts` 的 Word 式排版：标记 textStyle `{ color, fontFamily, fontSize }`、subscript、superscript、highlight `{ color }`；段落 / 标题属性 `lineHeight`（倍数字符串）、`spaceBefore` / `spaceAfter`（磅）、`textIndent`（字符，负数为悬挂缩进）、`indent`（左缩进级数，每级 2 字符）；列表 `listStyle`；单元格 `backgroundColor`；节点 pageBreak、tableOfContents `{ maxLevel }`、footnote `{ id, content }`（行内，纯文字）），与前端编辑器同步维护；另有 Y.Map `page`：页面设置 `{ size: A4\|A3\|A5\|B5\|Letter, orientation: portrait\|landscape, marginTop/Right/Bottom/Left（毫米） }`，缺省 A4 纵向，导出 Word / PDF 时使用，版本快照与恢复包含它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sheet`  | 工作簿 v2（`SHEET_YDOC`）     | 全部是根级类型（并发创建同名根类型会合并）：`sheetOrder` Y.Array<表 id>（读时去重）；`sheetInfo` Y.Map<表 id, `{ name, hidden?, color? }`>；`cellStyles` Y.Map<样式 id, CellStyle>（内容哈希 id，`b i u s fs ff fc bg ha va wrap nf bt br bb bl`，`nf` 为 Excel 数字格式代码）。每张表 `sheet:<id>:<part>`（`sheetTypeName()`）：`rows` / `cols` Y.Array<行 / 列 id>（读时去重，插行 = 插一个 id）；`cells` Y.Map<`"行id:列id"`, 原始输入>（`=` 开头为公式）；`fmt` Y.Map<`"行id:列id"`, 样式 id>；`rowp` / `colp` Y.Map<id, `{ h / w, hidden }`>；`merges` Y.Map<合并 id, `{ r0, c0, r1, c1 }`（行列 id）>；`view` Y.Map `{ frozenRows, frozenCols, filter }`；`cache` Y.Map<`"行id:列id"`, 导入时 Excel 算好的公式值>。新建 / 迁移 / 导入用确定 id（第一张表 `s1`、行 `r<i>`、列 `c<i>`），其余随机。默认 100 行 × 26 列，上限 `SHEET_LIMITS`（100 000 行 × 1 000 列）。旧结构（v1：根级 `cells` Y.Map<`"r:c"`> + `sheet` Y.Map `{ rows, cols, colWidths }` + `formats`）在服务端载入（`/collab` onLoadDocument、`edit`）时惰性迁移成表 `s1`“Sheet1”，迁移后清空旧键并写 `sheet.migrated = 2`；前端打开时也做同一迁移（确定 id，两边都做不会重复）；只读路径（`markdown`、版本快照）不迁移也能读。实现：服务端 `modules/documents/sheet-model.ts`，前端 `editors/sheet/model/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `slides` | `slides` + `slidesMeta`       | 自由版式（v2，`modules/documents/slides.ts` 与前端 `editors/slides/model/deck.ts` 同步维护）。`slides`：Y.Array<Y.Map>，每页 `{ id, order, v: 2, layout, elements: Y.Map<元素 id, Y.Map>, bg?, notes: Y.Text }`；**页顺序按 `order`**（fractional-indexing 键，字节序比较），数组下标无意义，拖动排序只改 `order`，所以移动时别人对这一页的编辑不丢；没有 `order` 的页排在数组里前一页之后。`layout` ∈ `title` / `content` / `two-column` / `section` / `title-only` / `image-text` / `blank`（只决定新建 / 换版式时生成哪些占位符）。`bg`：`{type:'color',color}` / `{type:'gradient',angle,stops}` / `{type:'image',src,fileId?}`。元素 Y.Map 公共字段 `{ id, type: text\|shape\|image\|line\|table, x, y, w, h, rot（度）, z（fractional 键，越大越上层）, group?, ph?（title\|subtitle\|body 占位符）, name?, flipH?, flipV? }`，单位 pt（默认页面 960×540 = 16:9）；`text` / `shape`：`text` 为 Y.XmlFragment（Tiptap 同格式：paragraph{textAlign,lineHeight} / bulletList / orderedList{start} / listItem / hardBreak，标记 bold / italic / underline / strike / code / link / textStyle{color,fontSize:'24pt',fontFamily,backgroundColor}），另有 `style {fontSize,color,fontFamily,bold?,align?,lineHeight?}`、`valign`、`fill`、`stroke {color,width,dash}`、`pad [l,t,r,b]`、`autofit`；shape 另有 `shape`（OOXML 预设名）与可选 `path` + `vb`；`image`：`src`、`fileId?`、`fit`、`crop {l,t,r,b}`（比例）、`geom`；`line`：`stroke`、`start` / `end`（none\|triangle\|arrow\|stealth\|oval\|diamond），翻转决定方向；`table`：`cells` Y.Array<Y.Array<Y.Map{ text: Y.Text, fill?, color?, bold?, colSpan?, rowSpan?, hidden? }>>、`colW[]`、`rowH[]`、`border`、`header`。颜色 / 字体可写主题令牌 `theme:fg` / `theme:muted` / `theme:accent` / `theme:title` / `theme:body`，按当前主题解析。`slidesMeta`：Y.Map `{ w, h, theme }`。**旧版页（v1）**：没有 `v` / `elements`，`{ id, layout, title, body（markdown）, notes }` 均为 Y.Text——服务端照常读写，编辑器以可编辑身份打开时迁移成 v2（元素 id 由页 id 推出，多人同时迁移结果一致） |
| `latex`  | `source` + `files` + `assets` | `source`：Y.Text，主文件 `main.tex`；`files`：Y.Map<路径, Y.Text>，其余文本文件（`.bib .tex .sty .cls .bst .txt .csv .dat`，如 `references.bib`）；`assets`：Y.Map<路径, `LatexAsset { fileId, mime, size }`>，图片（`.png .jpg .jpeg .pdf`，文件本身存在项目文件 `latex/<docId>/<路径>`）。路径规则 `latexFileKind()`：≤3 层目录、不含 `..`、≤120 字；上限 `LATEX_LIMITS`（60 个文件、单个文本 50 万字、图片 20 MB）。常量见 `LATEX_YDOC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

不带 `markdown` 新建时：doc 为空；latex 写入最小模板（`article` + `amsmath`、`\title{文档标题}`、`\maketitle`、`\section{Introduction}`）；sheet 建一张空表“Sheet1”；slides 一页 `title` 版式封面（标题 = 文档标题）。

#### 2.7.2 markdown 表示

`GET …/markdown`、agent `read`、`edit` 的返回值、审阅快照、`documents.content_text`（搜索与汇报用）都是这份表示；`DocumentCreateInput.markdown` 与 `append` / `replace_all` 的输入按同一规则解析。

- **doc**：标准 Markdown（markdown-it，不解析 HTML）。`$…$` ⇄ 行内公式；独占一行的 `$$`…`$$`（或单行 `$$…$$`）⇄ 块公式；一个列表的每一项都以 `[ ]` / `[x]` 开头时 ⇄ 任务列表；表格第一行为表头；`==高亮==` 只导出不解析。结构放不进 schema → 422。`outline` = 顶层标题。特殊块（常量见 `entities-collab.ts` 的 `DOC_EMBED_SCHEME` 等）：独占一段的 `![说明](地址 "图注")` ⇄ 图片块（`image { src, alt, caption, fileId, width, align }`；段落中间的图片拆成独立块，标题里的图片退回成链接；上传的图片地址是 `/api/v1/projects/:pid/files/:fileId`）；独占一段的 `[📎 文件名](地址)` ⇄ 附件块（`fileAttachment`）；独占一段的 `[嵌入表格：标题](doc:<docId>)`（表格 / 幻灯片 / 文档 / LaTeX 论文）⇄ 内嵌文档块（`docEmbed { docId, kind, title, height }`）；行内 `[@名字](mention:<userId>)` ⇄ 提及（`mention { id, label }`）。`replace_section` / `replace_all` 重写时，同一地址的图片 / 附件、同一文档的嵌入会带回 markdown 写不出的属性（宽度、对齐、高度、文件大小），所以读出来原样写回不丢东西。Word 式内容：独占一段的 `<!-- pagebreak -->` ⇄ 分页符，`<!-- toc -->` ⇄ 目录块（标题自动编号，前端按标题实时生成）；脚注导出为 `[^n]`（按出现顺序编号），定义 `[^n]: 内容` 列在文末，解析时同样识别（`replace_section` 只写了 `[^1]` 而没写定义时，沿用文档里原有的第 1 个脚注内容；都找不到时保留字面文字）；上下标导出为 `<sup>…</sup>` / `<sub>…</sub>` 并能解析回来；字体、字号、颜色、段落间距 / 缩进等 markdown 表达不了，读不出但 `replace_text` 这类按文字替换的编辑会保留所在文字和段落的格式。
- **sheet**：每张表导出为带行列号的 markdown 表格：表头 `|   | A | B | … |`，每行首格为 1 起的行号；每张表最多 200 行 × 26 列（超出时末尾附“（只显示了前 N 行、M 列）”）；单元格里的 `|` 转义、换行变空格；导出原始输入（公式保留 `=…`，不求值；样式、格式、合并不导出）；空表为 `（空表格）`。只有一张表时与此完全相同（与旧版一致）；多张表时每张前加一行 `## 工作表：名字`（隐藏的表名后加“（隐藏）”），表之间空一行。输入接受 markdown 表格（≥2 行 `|…|`，分隔行忽略；带行列号的表格——即本表示——会去掉行号列和列标题行，所以读出来原样写回不变）或 CSV / TSV（支持引号、`""` 转义、引号内换行，全空行丢弃），从 A1 写起；输入里有 `## 工作表：名字` 时按段写到对应的表（不存在则新建），没有时写第一张表。`outline`：多张表时为可见表名（level 1），否则为空。摘要（`excerpt`）取所有表的前 4 行数据。
- **slides**：按 `order` 排序，每页 `## 标题`（无标题时导出为 `## 第 n 页`）；版式是 `title` / `two-column` / `section` 时下一段为 `<!-- layout: x -->`；然后正文 markdown；备注每行加 `> `；段与页之间空行。v2 页的“标题”= 标题占位符的文字，没有标题占位符（例如导入的 PPT）时取第一个有字的文本框的第一行；“正文”= 其余文本框按层级顺序转成 markdown（段落、`- ` / `1. ` 多级列表、`**粗体**`、`` `代码` ``），表格转成 markdown 表格（表头以外的加粗单元格写成 `**…**`），图片（非 data URL）转成 `![名称](地址)`；位置 / 样式不出现在 markdown 里。写入（新建、`append`、`replace_all`、`append_slides`、`replace_slides`）一律生成 v2 页。Markdown → 页的规则在 `packages/shared/src/slides-collab.ts`（服务端写入与前端 AI 生成幻灯片共用）：**分页**——单独一行 `---`（Marp / Slidev）或 `#` / `##` 标题都开新页，当前页还没标题时标题归这一页（混用不产生空页），开头的 YAML front-matter 去掉，全文用 `---` 分页且每页以 `#` 开头时页内 `##` 只是小标题；**备注**——`> ` 行、非指令的 `<!-- … -->` 注释、`备注：` / `Note:` 开头的段落；**版式**——`<!-- layout: x -->` 显式指定（title / section 页内容过多时仍改为 `content`），否则推断：第一页无表格 / 图片 / 列表且正文 ≤4 行 → `title`，其他页只有一行短副标题 → `title`，无正文 → `section`，正文含独占一行的 `|||` / `::right::` → `two-column`（`---` 不再是两栏），否则 `content`；只有表格的页存为 `title-only`，图文页存为 `image-text`；**表格**——Markdown 表格变成 `table` 元素（去掉行内标记，含加粗的单元格整格加粗，表头加粗，按内容分列宽、按页高缩字号），数据行超过 12 行拆成「（续）」页并重复表头；**正文**——段落 / 多级列表 / 行内格式转成富文本，字号逐级缩小（最小 14pt），仍放不下按块拆成「（续）」页；**图片**——独占一行的 `![说明](地址)`：http(s) / 站内绝对路径 / data URL 生成 `image` 元素，其他地址（如相对文件名）生成虚线框占位说明，`![bg](地址)` 作背景。所有元素都在页面范围内。直接传 `SlideInput` 的 `two-column` 页正文里的 `---` 仍按旧规则当分栏。空幻灯片导出 `（空白幻灯片）`。`outline` = 每页标题（level 1）。
- **latex**：`main.tex` 源码原样。`outline` = `\section` / `\subsection` / `\subsubsection`（含星号形式，level 1–3；同一行 `%` 之后的跳过；标题里不支持嵌套花括号）。工程里还有其他文件时：`DocumentContent.files` 列出 `LatexProjectFile { name, kind: main|text|image, size }`，`markdown` 开头加一段 `% ---- 工程文件（研协附注…）----` 注释（每个文件一行，`.bib` 附上条目 key），以 `% ----` 结束；`edit` 的各 op 仍只作用于 `main.tex`（返回的 `markdown` 同样带这段附注）。版本快照与恢复包含 `files` / `assets`。

#### 2.7.3 结构化编辑 `DocumentEdit`

`heading` 按大纲里的标题原文匹配（去掉开头的 `#`、压缩空白后精确比较；doc 类型比不上时再按宽松规则比：忽略编号前后空白、全半角标点差异）；找不到 → 404（doc 类型 `details.headings` 列出全部顶层标题）。`find` 找不到 → 404。op 不适用于该类型 → `400 bad_request`（“<kind> 类型的文档不支持 <op> 操作”）。

| op                                                       | doc                                                                                | sheet                                                                                                                                                                                   | slides                                                                                            | latex                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `append { markdown }`                                    | 追加到末尾                                                                         | 按 `## 工作表：` 分段（没有则第一张表），从该表最后一个非空行的下一行、A 列写入                                                                                                         | 解析成页（§2.7.2）追加                                                                            | 插到 `\end{document}` 之前（没有则末尾），自动补空行               |
| `insert_after_heading { heading, markdown }`             | 插到该标题小节末尾（下一个同级或更高级标题之前）；内容以同名标题开头时去掉这一行   | 400                                                                                                                                                                                     | 400                                                                                               | 插到该小节末尾（下一个同级或更高级小节、或 `\end{document}` 之前） |
| `replace_section { heading, markdown }`                  | 替换小节正文，保留标题；内容以同名或同级标题开头时，把它当作这一节的新标题（见下） | 400                                                                                                                                                                                     | 400                                                                                               | 替换 `\section{…}` 命令之后到小节末尾的源码                        |
| `replace_text { find, replace, all=false, occurrence? }` | 按 read_document 读出的原文查找，可含标题行、跨段落；`replace=''` 删除整块（见下） | 400                                                                                                                                                                                     | 在各页文本框（沿用匹配处格式）、表格单元格与 `notes` 中替换（v1 页为 `title` / `body` / `notes`） | 源码替换                                                           |
| `replace_all { markdown }`                               | 整体替换                                                                           | 按段清空对应表的单元格后写入（保留行列、样式；不存在的表新建，未提到的表不动）                                                                                                          | 整体替换为解析结果                                                                                | 整体替换                                                           |
| `set_cells { cells: [{ ref, value }], sheet? }`          | 400                                                                                | A1 记法（`A1`…`ZZZ999999`）写单元格，`value=''` 清空；`sheet` 为表名（不区分大小写），缺省写第一张表，不存在则新建；超出当前尺寸时自动加行列；任一格超出 `SHEET_LIMITS` 整次拒绝（422） | 400                                                                                               | 400                                                                |
| `append_slides` / `replace_slides { slides }`            | 400                                                                                | 400                                                                                                                                                                                     | 追加 / 整体替换（`SlideInput`）                                                                   | 400                                                                |

`packages/shared` 里 `DocumentEdit` 各分支注释写的适用类型比实现窄，以本表为准。

doc 类型的 `replace_section` / `insert_after_heading`（实现见 `documents/ydoc.ts`）：

- 替换范围是该标题到下一个同级或更高级标题之前（含子标题）。`markdown` 以与目标同名的标题开头（任意级别，忽略编号前后空白和全半角标点差异）时，把它当作这一节的新标题，不再在原标题下面多写一个。名字只差空白或全半角时保留原文；以同级的另一个标题开头时视为改名：就地换文字，沿用原标题的字体和段落格式。标题级别始终沿用原标题（agent 常把一级标题写成 `##`）：开头标题和原标题级别不同时，`markdown` 里其余子标题按同样差值平移；`insert_after_heading` 同理，`replace_text` 把一个标题整块换成一个标题时也保留原级别。编辑接口不改标题级别。`markdown=''` 表示清空正文、保留标题。
- 目标标题前面紧挨着同名同级的空标题（以前的编辑留下的重复标题）时，定位到最后一个；`replace_section` 会顺带删掉前面这些空壳。

doc 类型的 `replace_text`（实现见 `documents/doc-edit.ts`）：

- **查找**：`find` 照抄 read_document 读出的 markdown 即可。按三档依次查找，前一档找不到才用下一档：
  1. 逐字匹配：可以跨格式 run、跨行内元素，块与块之间按空行算；
  2. 宽松匹配：去掉行首的 `#`、`\` 转义、`<sup>` / `<sub>`、`[^n]`、`==`；全半角统一（NFKC）；NBSP、全角空格当普通空格；空白只在两个西文词字符之间才算数，所以中文前后、标点前后多一个或少一个空格都能匹配上；
  3. 把 `find` 当 markdown 解析后取文字：`**粗体**`、链接、列表符号、表格竖线都去掉。

  `find` 以 `## ` 开头时只匹配从标题块开头开始的位置，不会把正文里同样的文字当成标题。`all=true` 替换全部命中（不重叠）；否则替换第 `occurrence` 处（1 起，默认 1），命中数不够时返回 404。

- **替换**：
  - 命中在同一块里、`replace` 是一句话：就地替换，新文字沿用命中处的格式（字体、颜色），`replace` 里的行内 markdown（`**粗体**`、`$公式$`、`[^1]`）会变成真正的格式。
  - `replace` 含空行或以 `#` 开头，或者命中跨了几块：`replace` 按 markdown 解析成块。第一块能接上原来那一块时并进去，保留原格式；其余块作为独立的新段落插在后面，使用正文默认样式，不继承上一段的字体字号；命中位置之后剩下的文字接到最后一块。
  - 跨了列表、表格、引用的边界时，只有整块都被覆盖才整体替换，否则返回 422。
- **删除整块**：`find` 正好是一整块（例如 `## 标题` 或标题的纯文字、`- 某一项`、一整个段落）且 `replace=''` 时，删掉这一块，不留空段落；列表项、引用变空时一并删掉，表格单元格里留一个空段落。整节原文（标题、正文、子标题、表格、图片）连起来作为 `find`、`replace=''`，就是删掉整节。多余的重复标题可以写 `{ find: "## 标题", replace: "", occurrence: 2 }` 删除。
- **找不到**：返回 404 `not_found`，`message` 里给出最接近的一段原文，`details.candidates` 最多列 3 段（标题写成 `## 标题` 形式），可以直接拿来当 `find`。

#### 2.7.4 文档内嵌 AI（`POST P/docs/:docId/ai`）

- 请求 `DocumentAiInput { action, selection = '', prompt = '' }`。改写类 action（`polish` `shorten` `expand` `translate_en` `translate_zh` `academic` `latex_fix`）`selection` 为空 → 422。
- 服务端先取到模型的第一块输出再发响应头，所以 LLM 未配置 / key 无效 / 余额不足 → `503 llm_unavailable`、限流 → `429 rate_limited`，都是普通 JSON 错误体。之后返回 `200`，`content-type: text/plain; charset=utf-8`、`cache-control: no-cache, no-transform`、`x-accel-buffering: no`，逐块写出模型输出；开头若有整体 ` ``` ` 围栏会去掉。中途出错或客户端断开时流直接结束，不再有错误体。
- 发给模型的上下文：文档标题、当前 markdown 的最后 12000 字（`<document>`）、`<selection>`、“用户的要求：prompt”。`table` 温度 0.2，其余 0.6；不用推理模型。
- 输出格式约定（前端编辑器按此插入，见 `apps/web/src/features/docs/editors/*`）：`action=table` → CSV（首行表头，逗号分隔，含逗号或换行的格用双引号）；`action=slides` → 每页 `## 页标题`、`- ` 要点、`> ` 备注的幻灯片 markdown，第一页为封面；其余 action 按文档类型：doc → Markdown 片段（可含 `$…$` / `$$…$$`），sheet → 纯文本，slides → Markdown，latex → LaTeX 片段（不含 `\documentclass`、导言区、`\begin{document}`）。`continue` 只输出续写部分；改写类只输出改写结果；`summarize` 先一句话概括再 3–6 条要点；`outline` 为二、三级标题加要点；`custom` 无选区时按指令生成新内容；`latex_section` 以 `\section{…}` 开头，引用写 `\cite{待补充}`。

#### 2.7.5 LaTeX 编译（`modules/documents/latex/*`）

| 方法 | 路径                             | 角色 | 请求                                  | 响应 / 说明                                                                                                                                                      |
| ---- | -------------------------------- | ---- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `P/docs/latex/capability`        | view | —                                     | `LatexCapability { available, engine: tectonic\|latexmk\|null, version, reason, limits { timeoutMs, maxSourceBytes, maxPdfBytes } }`（探测结果缓存 60 秒）       |
| POST | `P/docs/:docId/latex/compile`    | view | `LatexCompileInput { force = false }` | `LatexCompileResult`（见下）；非 latex 文档 → 400；服务器不能编译 → `501 not_implemented`；每项目每分钟超过 `LATEX_RATE_PER_MIN` 次真实编译 → `429 rate_limited` |
| GET  | `P/docs/:docId/latex/pdf/:pdfId` | view | `?download=1`（attachment）           | `application/pdf`；PDF 只存在服务端内存 LRU（256 MB，重启即失），过期 → `404`“PDF 已过期，请重新编译”                                                            |

- 编译用服务端 Y.Doc 的当前状态（有人在线时取内存里的最新状态）：`main.tex` + `files` 写入临时目录，`assets` 从项目文件复制进去。客户端应等本地修改同步后再请求（编辑器等待 `provider.unsyncedChanges` 归零，最多 4 秒）。
- `LatexCompileResult { status: success|error|timeout|rejected, pdfId, pdfBytes, engine, durationMs, log, logTruncated, cached, compiledAt }`。输入（全部文件内容 + 图片 id）没变时直接返回上次结果（`cached: true`，不计限流；超时的结果不复用），`force` 跳过缓存；同一输入的并发请求合并。`error` 时若 TeX 仍生成了 PDF，`pdfId` 照常给出（PDF 可能不完整）。`rejected`：源码超过 4 MB、或 `\input` / `\include` / `\includegraphics` / `\bibliography` 等引用了绝对路径、`..`、`~` → 不运行编译器，`log` 里是 `main.tex:行: 说明`。
- `log` = TeX 的 `main.log`，后接 `---- BibTeX（main.blg）----`、`---- 编译器输出（engine）----` 段，以及 `研协：` 开头的提示（缺图片、超时、PDF 过大）。前端解析见 `apps/web/src/features/docs/editors/latex/compile/texLog.ts`。
- 引擎：默认 Tectonic（XeTeX，自动跑 BibTeX 和重复编译，ctex / xeCJK 中文可用，`--untrusted` 关闭 shell-escape），备选 `latexmk -xelatex -bibtex`（`-no-shell-escape`）。环境变量（只在 `modules/documents/latex/config.ts` 读取）：`LATEX_COMPILER`（`auto` 默认 / `tectonic` / `latexmk` / `none`）、`TECTONIC_PATH`、`LATEXMK_PATH`、`LATEX_CACHE_DIR`（默认 `<STORAGE_DIR>/../latex-cache`，宏包缓存，需持久化）、`LATEX_TIMEOUT_MS`（90000，5000–600000）、`LATEX_MAX_CONCURRENCY`（2）、`LATEX_RATE_PER_MIN`（20）、`LATEX_OFFLINE=1`（`--only-cached`，不联网下载宏包）、`LATEX_SANDBOX`（`none` / `bwrap`）。子进程只拿到白名单环境变量、`openin_any=p` / `openout_any=p`，超时 SIGKILL 整个进程组，输出截断到 256 KB。

#### 2.7.6 从文件导入（`modules/documents/import.ts`）

| 方法 | 路径            | 角色  | 请求                                                                                                                            | 响应 / 说明                                                                                                                                                      |
| ---- | --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `P/docs/import` | write | 查询参数 `DocumentImportQuery { kind, title = 未命名文档, parentId?, importId? }`；请求体 `application/octet-stream` = Yjs 更新 | `201 DocumentMeta`；文档行与 Yjs 状态在同一个事务里写入并发 `document.created`（不会留下空文档）；同一 `importId` 15 分钟内重复提交 → `200` 返回第一次建好的文档 |

- 前端导入器（`apps/web/src/features/docs/import/*`：`.docx` → doc、`.xlsx/.xls/.csv` → sheet、`.pptx` → slides、`.tex` / 工程 `.zip` → latex、`.md/.txt/.html` → doc）把文件解析进一个空的 Y.Doc（结构见 §2.7.1），请求体就是 `Y.encodeStateAsUpdate(doc)`。文件里的图片先经 `POST P/files` 上传（路径 `imports/<文件名>-<id>/…`），文档里按文件 id / 地址引用；导入失败时前端删除这些文件。
- 校验：请求体为空或无法解析、更新依赖缺失（被截断）、按 `kind` 读不出 markdown → `422 validation_failed`；超过 `DOC_IMPORT_MAX_BYTES`（16 MB）→ `413`；不是 octet-stream → `400`；`parentId` 不存在 → 404。latex 额外检查 `LATEX_LIMITS`（含 main.tex 共 60 个文件、单个文本 50 万字）、`files` / `assets` 的路径规则（`latexFileKind`）、`LatexAsset` 结构，且图片 `fileId` 必须是本项目的文件，否则 422。
- `importId`（`[A-Za-z0-9_-]{8,64}`）是幂等键：前端在网络中断 / 5xx 后用同一个键重试，服务端（进程内，按项目 + 用户 + 键）返回第一次的结果；第一次失败的键不缓存；第一次建好的文档已被删除时按新导入处理。
- 原始文件大小由前端检查（`DOC_IMPORT_FILE_MAX_BYTES` 50 MB；`.tex` 4 MB；`.md/.txt/.html` 8 MB）。LaTeX 工程 `.zip`：以含 `\documentclass` + `\begin{document}` 的 `.tex`（`main.tex` 优先、目录越浅越优先）为主文件并以其目录为工程根，编译产物、`__MACOSX`、隐藏文件跳过，不合规的文件名 / 类型、超限文件跳过并提示；解压总量上限 200 MB。LaTeX 编辑器的导出菜单提供“下载工程 .zip”（main.tex + 文本文件 + 图片），可以原样再导入。

#### 2.7.7 表格（sheet）内核选型与前端实现

- **结论：保留自研的 Yjs 网格，公式 / 格式 / 文件读写全部用成熟的宽松许可库。** 评估过的整套内核：
  - **Univer**（Apache-2.0 开源部分）：多人协同（`@univerjs-pro/collaboration`）、打印、xlsx 导入导出是闭源付费的 Pro 包，需要 license 和它自己的 OT 协同服务器；与我们的 Hocuspocus / Yjs、服务端 agent 读写路径（§2.7.3、§2.12）冲突；包体也很大。
  - **FortuneSheet**（MIT）：数据模型是整张表的 JSON，协同 op 用数组下标路径，并发插删行列时会错位，不是 CRDT 安全的；协作者显示只有单格光标、没有选区；同样要维护第二份模型，服务端 markdown / agent 路径要重写。
  - **HyperFormula**：GPL-3.0 / 商业双许可，不可用。
- 采用的库：公式解析与内置函数 **fast-formula-parser**（MIT）+ 它没有的函数用 **@formulajs/formulajs**（MIT）补齐（`STDEV.S` 等带点的名字、旧名映射；`XLOOKUP` 两个库都没有，按 Excel 语义自写）；数字格式显示 **SSF**（Apache-2.0，与 Excel 同一套格式代码）；xlsx 读写 **ExcelJS**（MIT，动态加载）；PDF 走浏览器打印视图（分页、横向自动判断）。
- 前端：`apps/web/src/features/docs/editors/sheet/`。
  - `engine/`：惰性求值 + 依赖追踪（单元格变化只让依赖它的公式重算），支持跨表引用、区域、错误值、循环引用（`#CYCLE!`）。
  - `model/`：`Workbook` / `SheetModel` 读写 §2.7.1 的结构，所有结构操作在一个事务里，同时改写公式里的引用；插删行列、改表名、删表（引用变 `#REF!`）都会改写公式；合并、筛选、冻结随行列 id 走。
  - `SheetGrid`：按行高 / 列宽前缀和做二维虚拟化（只渲染可见格），支持冻结窗格、合并、隐藏行列、换行、边框、溢出文本；协作者的活动格和选区按其颜色显示，带名字标签；工作表标签上显示谁在这张表。
  - 撤销 / 重做：每人一个 `Y.UndoManager`，只追踪本人的 origin，新出现的表动态加入追踪。
  - 剪贴板：复制写 TSV + 带内联样式和合并的 HTML；粘贴优先解析 HTML（含 Excel 的 `<style>` 类样式与 `mso-number-format`），否则 TSV。
  - 导入：`features/docs/import/xlsx.ts` 的 `importXlsx(file, ydoc, ctx?)` 写入空 Y.Doc（新建文档用）；编辑器里“导入 Excel”把 xlsx / csv 作为新工作表追加。不支持 `.xls`（提示另存为 .xlsx），图片、数据验证、条件格式不导入（给出提示）。

### 2.8 看板与待办（C · `modules/boards`、`modules/todos`）

| 方法   | 路径                        | 角色  | 请求                                                                                      | 响应 / 说明                                                                                                                                                                                                        |
| ------ | --------------------------- | ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `P/boards`                  | view  | —                                                                                         | `Board[]`（按创建时间）；项目还没有看板时，能写的角色先建默认看板“研究看板”（列：想法 / 进行中 / 待审阅 / 完成）并发 `board.created`；访客不建，返回 `[]`                                                          |
| POST   | `P/boards`                  | write | `BoardCreateInput { name, columns? }`                                                     | `201 Board`；不传 `columns` 用默认四列，自定义列按色板序号 1,2,0,4,3,5,6,7 轮流取色；发 `board.created`                                                                                                            |
| GET    | `P/boards/:boardId`         | view  | —                                                                                         | `Board & { cards: Card[] }`（卡片按列、`position` 排序）                                                                                                                                                           |
| PATCH  | `P/boards/:boardId`         | write | `BoardUpdateInput { name }`                                                               | `Board`；发 `board.updated`                                                                                                                                                                                        |
| DELETE | `P/boards/:boardId`         | write | —                                                                                         | 204；列与卡片随之删除（不逐张发 `card.deleted`）；项目最后一个看板 → `409 conflict`；发 `board.deleted`                                                                                                            |
| POST   | `P/boards/:boardId/columns` | write | `ColumnUpsertInput { name, position?, color? }`                                           | `201 BoardColumn`；不传 `position` 排在最后；`position` 不是合法分数索引 → 422；发 `column.created`                                                                                                                |
| PATCH  | `P/columns/:columnId`       | write | `ColumnUpsertInput` 的任意子集                                                            | `BoardColumn`；发 `column.updated`                                                                                                                                                                                 |
| DELETE | `P/columns/:columnId`       | write | `?moveTo=<columnId>`                                                                      | 204；看板最后一列 → 409；列里有卡片且没给 `moveTo` → 409（`details.cardCount`）；`moveTo` 是自己或不在同一看板 → 422；卡片按原顺序移到 `moveTo` 列尾（每张 `version+1`、发 `card.updated`），再发 `column.deleted` |
| POST   | `P/boards/:boardId/cards`   | write | `CardCreateInput`（`columnId` 必须属于该看板；`afterCardId`：不传 = 列尾，`null` = 列首） | `201 Card`；发 `card.created`；指派通知见下                                                                                                                                                                        |
| PATCH  | `P/cards/:cardId`           | write | `CardUpdateInput`（必带 `baseVersion`）                                                   | `Card`（`version+1`）；版本过期 → `409 version_conflict`，`details.current` 为最新 `Card`；发 `card.updated`                                                                                                       |
| DELETE | `P/cards/:cardId`           | write | —                                                                                         | 204；发 `card.deleted`；以该卡为来源的收件箱项全部标记完成                                                                                                                                                         |
| GET    | `P/todos`                   | view  | `?scope=project\|mine&done=true\|false`                                                   | `Todo[]`：不传 `scope` = 共享 + 我的个人；`project` = 只共享；`mine` = 我的个人 + 指派给我的共享。未完成在前按 `position`，已完成按 `completedAt` 倒序                                                             |
| POST   | `P/todos`                   | write | `TodoCreateInput`（`personal`、`assigneeId`、`priority`、`dueAt`、`source`）              | `201 Todo`（放在最前）；发 `todo.created`                                                                                                                                                                          |
| PATCH  | `P/todos/:todoId`           | write | `TodoUpdateInput`（`done`、`afterTodoId`：`null` = 最前、`personal` 等）                  | `Todo`；`done` 切换写 / 清 `completedAt`，完成时以该待办为来源的收件箱项标记完成；发 `todo.updated`                                                                                                                |
| DELETE | `P/todos/:todoId`           | write | —                                                                                         | 204；发 `todo.deleted`；收件箱项标记完成                                                                                                                                                                           |

- 卡片移动 = 改 `columnId` 和 / 或给 `afterCardId`：只改列不给 `afterCardId` = 目标列尾；`afterCardId` 必须在目标列里，否则 422。`position` 是 fractional-indexing 字符串，按字节序（`COLLATE "C"`）比较。`dueAt` 为 ISO 时间，非法 → 422。卡片的 `threadId` 必须是本项目线程、`experimentId` 必须是本项目实验，否则 422（PATCH 只在值变化时校验）；关联个人线程的规则见 §2.9。卡片 PATCH 锁住卡片行再比对 `baseVersion`，并发的同版本修改只有一次成功，其余 409 `version_conflict`。
- 待办可见性：共享待办（`ownerUserId = null`）全员可见可改；个人待办（`personal = true` → `ownerUserId` = 操作者）只有主人能看、改、删，别人访问 → 404。agent / 系统调用时忽略 `personal`，一律建共享待办。个人待办只能指派给主人自己或 agent，否则 422。只有创建人能把共享待办改成个人待办（`PATCH personal=true`），其他人 → 403。

#### 指派约定（卡片 `assigneeIds`、待办 `assigneeId`）

- 取值：成员用户 id（`usr_…`）、`agent:coordinator`（协调者）、`agent:<threadId>`（某线程的 agent）。写入时去重、去空白；成员必须在本项目、线程必须属于本项目、`agent:` 后为空 → 422（`details.issues[].path` 为 `assigneeIds` / `assigneeId`）。
- 事件 `threadId`（路由器据此唤醒对应线程的 agent）：
  - `card.created` / `card.updated`：卡片自身的 `threadId` 优先；否则取**本次新增**指派里第一个 `agent:<threadId>`（创建时“新增” = 全部指派）；其余为 `null`。`card.deleted` 和删列时移动卡片的 `card.updated` 只用卡片自身的 `threadId`。
  - `todo.created` / `todo.updated`：本次新增的 `agent:<threadId>`，否则 `null`；`todo.deleted` 为 `null`。
  - `agent:coordinator` 与成员指派不产生 `threadId`。
- 收件箱：本次新增的成员指派（跳过 agent、跳过操作者本人）各生成一条 `InboxItem { kind: 'assignment', title: '「<标题>」指派给了你', href, sourceId }`（`inbox.created`），`href` 为卡片 `/p/:projectId/board?card=:cardId`、待办 `/p/:projectId/todos?todo=:todoId`，`sourceId` 为卡片 / 待办 id。卡片删除、待办完成或删除时，同 `sourceId` 的未完成项全部置 `done`（`inbox.updated`）；仅取消指派不会清理。

### 2.9 实验记录（C · `modules/experiments`）

| 方法   | 路径                               | 角色  | 请求                                                                                                                 | 响应 / 说明                                                                                                                                                                    |
| ------ | ---------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `P/experiments`                    | view  | `?status=&tag=&threadId=`                                                                                            | `Experiment[]`（按 `updatedAt` 倒序）                                                                                                                                          |
| POST   | `P/experiments`                    | write | `ExperimentCreateInput`（`title`、`hypothesis`、`setup`、`status = planned`、`params`、`tags`、`links`、`threadId`） | `201 Experiment`；`ownerUserId` = 创建人（agent 创建为 `null`）；发 `experiment.created`                                                                                       |
| GET    | `P/experiments/:experimentId`      | view  | —                                                                                                                    | `Experiment`（不含日志）                                                                                                                                                       |
| PATCH  | `P/experiments/:experimentId`      | write | `ExperimentUpdateInput`（必带 `baseVersion`；另可改 `metrics`、`conclusion`）                                        | `Experiment`（`version+1`）；过期 → `409 version_conflict` + `details.current`；发 `experiment.updated`                                                                        |
| DELETE | `P/experiments/:experimentId`      | write | —                                                                                                                    | 204；发 `experiment.deleted`                                                                                                                                                   |
| GET    | `P/experiments/:experimentId/logs` | view  | `PageQuery`                                                                                                          | `Page<ExperimentLog>`（新到旧；`nextCursor` 为本页最后一条的 id）                                                                                                              |
| POST   | `P/experiments/:experimentId/logs` | write | `ExperimentLogCreateInput { body, metrics, fileIds }`                                                                | `201 ExperimentLog`；`fileIds` 必须是本项目文件（否则 422），转成 `attachments`；刷新实验 `updatedAt`（不改 `version`）；依次发 `experiment.log_created`、`experiment.updated` |
| GET    | `P/experiment-logs/:logId`         | view  | —                                                                                                                    | `ExperimentLog`（按日志 id 找所属实验，供正文里的 `#elg_…` 链接跳转）；不在本项目 → 404                                                                                        |

- 校验（422，`details.issues[].path` 如 `links.0.ref`）：`links` 里 `thread` / `message` / `document` / `review` 必须在本项目存在，`url` 必须是 http(s)，`file` / `output` 不校验；`threadId` 必须是本项目线程（PATCH 只在值变化时校验）。
- **关联个人线程**（实验、审阅、看板卡片的 `threadId` 共用此规则）：`kind=personal` 的线程只有主人能关联——用户必须是 `ownerUserId`，agent 必须就住在这个线程里或它代表的成员（`workingForUserId`）是主人，否则 403 `forbidden`。
- 状态时间：改为 `running` 且从未开始 → 写 `startedAt`；改为 `done` / `failed` / `abandoned` → 写 `endedAt`，改回其他状态 → 清空 `endedAt`。日志里的 `metrics` 只存在日志上，不合并到实验的 `metrics`。
- 事件 `threadId` = 实验的 `threadId`。

### 2.10 审阅（C · `modules/reviews`）

| 方法  | 路径                                      | 角色  | 请求                                                                                       | 响应 / 说明                                                                                                                        |
| ----- | ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `P/reviews`                               | view  | `?status=&mine=1&targetKind=&targetId=`                                                    | `Review[]`（按 `updatedAt` 倒序）；`mine=1\|true` = 我发起的或我是审阅人的                                                         |
| POST  | `P/reviews`                               | write | `ReviewCreateInput { targetKind, targetId, title, summary, reviewerIds (1–10), threadId }` | `201 Review`（`open`，每位审阅人 `pending`，带 `snapshot`）；发 `review.created`；为每位审阅人（发起人本人除外）生成收件箱项       |
| GET   | `P/reviews/:reviewId`                     | view  | —                                                                                          | `Review & { comments: ReviewComment[] }`（评论时间正序）                                                                           |
| POST  | `P/reviews/:reviewId/verdict`             | write | `ReviewVerdictInput { verdict: lgtm\|changes_requested\|commented, comment? }`             | `Review`；规则见下                                                                                                                 |
| POST  | `P/reviews/:reviewId/comments`            | write | `ReviewCommentCreateInput { body, anchor }`                                                | `201 ReviewComment`；发 `review.comment_created` + `review.updated`（`commentCount`、`updatedAt`）；已关闭的审阅也可评论           |
| PATCH | `P/reviews/:reviewId/comments/:commentId` | write | `ReviewCommentUpdateInput { resolved }`                                                    | `ReviewComment`；发 `review.comment_updated`                                                                                       |
| POST  | `P/reviews/:reviewId/close`               | write | —                                                                                          | `Review`（`closed`、`closedAt`）；只有发起人或 manage 角色 → 否则 403；已关闭 → 409；发 `review.updated`；该审阅的收件箱项全部完成 |

- 发起校验（422）：审阅人必须是本项目成员且不是访客；`threadId` 必须是本项目线程，别人的个人线程 → 403（§2.9）。目标不存在 → 404。
- 结论：只有被邀请的审阅人（用户，agent 不行）可以给 → 否则 403；审阅已关闭 → 409 `conflict`（在锁住审阅行的事务里判断，与并发的关闭串行，关闭后到达的结论一律拒绝）。带 `comment` 或 `verdict ≠ commented` 时写一条结论评论（`comment` 为空时正文为“LGTM” / “需要修改”，发 `review.comment_created`）。然后按全部审阅人当前结论重算状态：任一 `changes_requested` → `changes_requested`；全部 `lgtm` → `approved`；否则 `open`（结论可改，`approved` 也会回退）。发 `review.updated`。`lgtm` / `changes_requested` 会把本人的收件箱项标记完成。
- **新一轮取代旧一轮**：发起审阅时，同一目标（`targetKind` + `targetId`）上、由同一发起方发起（同一用户；agent 按同一 `threadId`）且未关闭的旧审阅，在同一事务里改为 `closed`，`closedAt` = 现在，`supersededById` = 新审阅 id；先发旧审阅的 `review.updated`，再发新审阅的 `review.created`，旧审阅的收件箱项全部完成。别人对同一目标发起的审阅不受影响。前端用 `GET P/reviews?targetKind=&targetId=` 找 `supersededById` = 本审阅的那条作为上一轮，显示两轮快照的差异。
- 事件 `threadId` = 审阅的 `threadId`（发起审阅的线程）：结论、评论、关闭都会唤醒它。
- 收件箱项：`InboxItem { kind: 'review', title: '「<标题>」请你审阅', href: '/p/:projectId/reviews/:reviewId', sourceId: reviewId }`。

`snapshot`（发起时目标内容的 markdown，diff 基线）：

| targetKind         | targetId           | snapshot                                                                                                  |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `document`         | `doc_…`            | 文档 markdown（§2.7.2，取在线最新状态）                                                                   |
| `experiment`       | `exp_…`            | `experimentToMarkdown`（含最近 10 条日志）                                                                |
| `report`           | `rpt_…`            | 汇报正文                                                                                                  |
| `message` / `plan` | `msg_…` 或 `doc_…` | 消息正文 / 文档 markdown；其他前缀 → 404；消息必须 `agentVisible`（旁聊 → 404），在别人的个人线程里 → 404 |
| `thread`           | `thr_…`            | `# 线程：标题` + 状态清单 + 最近 20 条 `agentVisible` 消息；个人线程只有主人自己能拿来审阅（他人 → 404）  |
| `output`           | `out_…`            | 标题、类型、引用                                                                                          |

### 2.11 组会汇报（C · `modules/reports`）

| 方法   | 路径                             | 角色  | 请求                                                                                  | 响应 / 说明                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/reports`                      | view  | —                                                                                     | `Report[]`（新到旧）                                                                                                                                                                                                                                                                                                                          |
| POST   | `P/reports`                      | write | `ReportCreateInput { title?, periodStart, periodEnd, generate = true, instructions }` | `201 Report`；发 `report.created`；生成见下                                                                                                                                                                                                                                                                                                   |
| GET    | `P/reports/:reportId`            | view  | —                                                                                     | `Report`；另带 `outdatedBy[]`：汇报最后写入后又改过的文档（doc/latex/sheet）和实验记录，非空 = 可能过期                                                                                                                                                                                                                                       |
| PATCH  | `P/reports/:reportId`            | write | `ReportUpdateInput { title?, content?, status?: draft\|final, baseVersion? }`         | `Report`（`version+1`）；带 `baseVersion` 且过期 → `409 version_conflict` + `details.current`（不带 = 直接写，兼容 agent / 旧调用）；正在生成时改 `content` / `status` → 409（改标题可以）；空标题恢复默认标题；改 `content` 清空 `error`，卡在 `generating` 的汇报改正文自动回 `draft`；空 patch 原样返回、不发事件；否则发 `report.updated` |
| DELETE | `P/reports/:reportId`            | write | —                                                                                     | 204；发 `report.deleted`（生成中删除，生成结果丢弃）                                                                                                                                                                                                                                                                                          |
| POST   | `P/reports/:reportId/regenerate` | write | `ReportRegenerateInput { instructions }`                                              | `200 Report`；正在生成 → 409；已配置 LLM：置 `generating`、清 `error`、后台重新生成；未配置：状态不变（卡住的 `generating` 回 `draft`），`error` = 未配置提示；发 `report.updated`                                                                                                                                                            |
| POST   | `P/reports/:reportId/document`   | write | —                                                                                     | `201 { report, document }`：用正文新建 `kind=doc` 文档并写回 `documentId`（`document.created` + `report.updated`）；正在生成 → 409；已存过且文档还在 → 409（`details.documentId`）；并发重复保存只有一次写入 `documentId`，后到的删掉自己建的文档并 409；正文为空 → 400                                                                       |
| POST   | `P/reports/:reportId/todos`      | write | `ReportTodosInput { items: [{ title, assigneeId }] }`（1–50 条）                      | `201 Todo[]`：共享待办，`source = { kind: 'report', id: reportId }`，列表顺序同 `items`；逐条发 `todo.created`、走指派通知（§2.8）；先校验全部 `assigneeId`，有一个不合法 → 422（`details.issues[].path` 如 `items.1.assigneeId`），一条都不建                                                                                                |
| GET    | `P/reports/:reportId/plan-items` | view  | —                                                                                     | `{ items: string[] }`：正文“下期计划”条目（`extractPlanItems`），供拆待办对话框预填                                                                                                                                                                                                                                                           |

- **并发编辑**：`Report.version` 每次写入（PATCH、重新生成、生成写回、存为文档）都 +1。正文选的是「版本号 + 409 + 合并视图」而不是实时协同：汇报是一个人主写、偶尔有人补充的草稿，需要多人同时写时可「存为协同文档」。PATCH 用比较并交换写入，并发的同版本修改只有一次成功。
- **时间段**：`periodStart` / `periodEnd` 接受 `YYYY-MM-DD`（按北京时间，开始取 00:00、结束取 23:59:59.999）或完整 ISO 时间；非法或开始晚于结束 → 422。默认标题 `组会汇报 · 10月20日–10月26日`。
- **生成流程**：
  1. `POST`（`generate=true`）且已配置 LLM：插入 `status=generating`、`content=''`，立即返回 201，进程内后台任务开始生成。未配置 key：不报 503，直接 `status=draft`，`error` = “还没有配置大模型 API Key（LLM_API_KEY），暂时不能自动生成……”。`generate=false`：`draft`、`error=null`。
  2. 后台：`collectReportContext` → 读 `report.md` 填变量作 system → user 消息给出时间段、额外要求和 `<project-records>…</project-records>` → 推理模型（`reasoning: true`，最多 16000 tokens）→ 去掉整体代码围栏。
  3. 只在汇报仍为 `generating` 时写回（期间被删除或被改走则丢弃）：成功 → `draft` + `content` + `stats` + `error=null`；失败 → `draft`，**保留旧正文**，`error` 为中文原因（key 无效、余额不足、限流、模型空返回等 ApiError 原文；其他异常为“生成失败了，服务器出错。请稍后点“重新生成”再试”）。发 `report.updated`（actor 为系统）。
  4. 任务只存在进程内存：进程重启后汇报会卡在 `generating`，此时允许 PATCH 正文 / 状态和 `regenerate`（“正在生成”只认内存里的任务）。
- **上下文收集**（`context.ts`，纯读库，输出分节 Markdown，每个对象带 `（#id）` 供模型写 `[标题](#id)` 链接）：
  - 头部：项目名、时间段、成员（姓名 + 角色）、项目说明（≤2000 字）。
  - 线程：本期创建或有活动的**项目**线程（≤100），标签、状态桶、是否解决、发起人、为谁工作、最新进度清单（≤1500 字）。
  - 消息：本期时间线与项目线程里 `agentVisible`、未删除的消息（最近 200 条，每条压成一行 ≤400 字）；旁聊与个人工作区永远不进。
  - 实验：本期创建或更新的（≤60），假设、设置、参数、指标、结论，及本期日志（每个实验最近 10 条，每条 ≤300 字）。
  - 审阅：本期创建或更新的（≤60），目标、状态、各审阅人结论、说明、最近 3 条评论。
  - 决策卡：本期创建的 + 截至期末仍未回答的（≤30，不含个人线程的）。
  - 待办：本期新建或完成的**共享**待办（≤100）。
  - 文档：本期修改过的未归档文档（≤50），每篇摘录 ≤300 字。
  - 项目记忆：`MEMORY.md` 前 3000 字。
  - 总长预算 60000 字符；按优先级 **实验 > 审阅 > 线程 > 消息 > 决策 > 待办 > 文档 > 记忆** 依次分配剩余预算，放不下的条目省略并注明“另有 N 条因篇幅省略”（消息保留最近的，其余保留靠前的；一条都放不下时截断第一条）；展示顺序与优先级无关。记录里的 `<project-records>` 标签会被删掉，防止提前闭合。
  - `stats` = 各类收集到的条数（threads / messages / experiments / reviews / todos / documents）。
- **提示词**：按顺序找第一个存在的 `report.md`：`$PROMPTS_DIR/report.md` → `apps/server/prompts/report.md`（相对 `src/modules/reports`，tsx / vitest）→ `<dist>/../prompts/report.md`（tsup 构建；Docker 镜像为 `/app/prompts`，需要 Dockerfile 拷贝）→ `<cwd>/prompts/report.md` → `<cwd>/apps/server/prompts/report.md`；都没有或读失败时用内置 `FALLBACK_REPORT_PROMPT`。读入后去掉 BOM 和文件头的 `<!-- … -->` 注释；变量 `{{project_name}}` `{{period_start}}` `{{period_end}}` `{{instructions}}`（空为“无”）`{{now}}`（北京时间 ISO）`{{context_json}}`（固定为“见用户消息里的 <project-records>”），未知变量替换为空串。
- **`extractPlanItems`**：认任意级别、可带编号（`5.`、`四、`）的小节标题“下期计划 / 下周计划 / 下阶段计划 / 下一步… / Next step(s)”（不区分大小写）；小节到下一个同级或更高级标题为止；跳过代码围栏；只取列表项（`-` `*` `+` `1.` `1)` `1、`，可带 `[ ]` / `[x]`）；去掉行内 markdown 标记、开头的 `@某人`（可连续、可带冒号）、末尾的“（来源：…）”；每条最多 200 字，去重，最多 50 条。

### 2.12 agent 工具接入（`agents/tools/collab-port.ts`）

后端线程的 agent 工具通过 `collab('documents' | 'experiments' | 'boards' | 'todos' | 'reviews' | 'reports' | 'search')` 拿协作模块的实现；各协作模块在自己的 `register()` 里 `registerCollabPort({...})`。没注册的端口返回 `undefined`，对应工具不应出现在 `{{tool_list}}`。约定：`actor` 传 `{ kind: 'agent', id, name }`；实现内部自己用 zod 校验（失败 422）、写库、发事件，错误抛 `ApiError`（错误码同对应 REST 端点）；认领写入守卫（ARCHITECTURE.md §5.3.6）在工具层做，端口不检查认领；端口不做角色检查。

| 端口          | 方法                                               | 实现（`modules/…/service.ts`）                               | 说明                                                                                                                                                                                         |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`   | `list(ctx, projectId)`                             | `listDocuments`                                              | 未归档的全部类型文档，`DocumentMeta[]`                                                                                                                                                       |
| `documents`   | `read(ctx, projectId, docId)`                      | `readDocument`                                               | `DocumentContent { meta, markdown, outline }`（§2.7.2）                                                                                                                                      |
| `documents`   | `create(ctx, actor, projectId, input)`             | `createDocument`                                             | `DocumentCreateInput`（含 `kind` 与初始 `markdown`）                                                                                                                                         |
| `documents`   | `applyEdit(ctx, actor, projectId, docId, edit)`    | `applyDocumentEdit`                                          | 按完整 `DocumentEdit` 解析（§2.7.3，也接受 `replace_all`、`replace_text.all`、`SlideInput.notes`，端口类型 `AgentDocEdit` 里没列）；`set_cells.sheet` 指定工作表（缺省第一张，不存在则新建） |
| `search`      | `searchDocuments(ctx, projectId, q)`               | `searchDocuments`                                            | `DocumentSearchHit[]`，最多 20 条                                                                                                                                                            |
| `experiments` | `list(ctx, projectId)`                             | `listExperiments`                                            | 不带过滤                                                                                                                                                                                     |
| `experiments` | `get(ctx, projectId, id)`                          | `getExperiment`                                              | `Experiment & { logs }`，最近 50 条日志（新到旧）                                                                                                                                            |
| `experiments` | `create` / `update` / `log`                        | `createExperiment` / `updateExperiment` / `addExperimentLog` | 同 §2.9；`update` 需 `baseVersion`                                                                                                                                                           |
| `boards`      | `createCard(ctx, actor, projectId, input)`         | `createCardAuto`                                             | `input` = `CardCreateInput` 的子集 + `title` + `boardId?`：`boardId` 缺省 = 默认看板（没有就建），`columnId` 缺省 = 第一列                                                                   |
| `boards`      | `updateCard(ctx, actor, projectId, cardId, input)` | `updateCard`                                                 | `CardUpdateInput`，需 `baseVersion`                                                                                                                                                          |
| `boards`      | `ensureDefaultBoard(ctx, actor, projectId)`        | `ensureDefaultBoard`                                         | 幂等：返回最早建的看板，没有则建默认看板                                                                                                                                                     |
| `todos`       | `create(ctx, actor, projectId, input)`             | `createTodo`                                                 | agent 调用忽略 `personal`，建共享待办                                                                                                                                                        |
| `reviews`     | `create(ctx, actor, projectId, input)`             | `createReview`                                               | 传 `threadId` = 当前线程，结论与评论事件会唤醒它                                                                                                                                             |
| `reports`     | `draft(ctx, actor, projectId, input)`              | `draft` → `createReport`                                     | 立即返回（通常为 `generating`），生成完成推 `report.updated`                                                                                                                                 |

agent 作为 actor 的差异：文档编辑时在 awareness 里短暂显示（§3.2）；实验 `ownerUserId = null`；审阅结论只能由人给（端口也没有提供）。

### 2.13 Agent harness：模型、MCP、Skill、斜杠指令、Profile（`modules/harness`）

设计见 ARCHITECTURE.md §7.6，类型在 `packages/shared/src/harness.ts`。**作用域**：`scope = project | personal`；项目级的增删改要负责人 / 导师（`manage`），个人级任何可写成员都能建、只能改自己的；内置项（`scope = builtin`，id 形如 `builtin:<slug>`）只读，用同 slug 新建即覆盖，优先级 个人 > 项目 > 内置。个人项只返回给主人，也只对主人自己的个人会话生效。密钥（provider `apiKey`、MCP `env` / `headers` 的值）只写不读：响应只给 `hasApiKey` / `envKeys` / `headerKeys`；PATCH 时某个键传空字符串表示保留原值。

| 方法与路径                              | 权限                   | 说明                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET P/harness`                         | view                   | 输入框一次取齐：`HarnessSummary { catalog, commands, skills, profiles }`（合并后的、对我可见的）                                                                                                               |
| `GET P/models`                          | view                   | `ModelCatalog { providers: LlmProvider[], defaultModel }`；模型 id = `<provider>/<model>`，每个模型带 `efforts[]` 与 `defaultEffort`                                                                           |
| `POST P/providers`                      | manage                 | `ProviderCreateInput { name, baseUrl, apiKey, thinkingFormat: deepseek\|openai\|none, models[{ model, name?, efforts?, defaultEffort? }], enabled }` → 201 `LlmProvider`                                       |
| `PATCH` / `DELETE P/providers/:id`      | manage                 | 只能改设置页建的；`.env` 里的（`source = env`）只读                                                                                                                                                            |
| `POST P/providers/:id/test`             | manage                 | 用第一个模型发一个 8 token、关思考的请求 → `{ ok, message, latencyMs }`                                                                                                                                        |
| `GET P/mcp-servers`                     | view                   | `McpServer[]`（项目级 + 我的个人级），含 `state: idle\|connecting\|ready\|error`、`error`、`tools[{ name, exposedName, description, enabled }]`                                                                |
| `POST P/mcp-servers`                    | write（项目级 manage） | `McpServerCreateInput { scope, name, description, transport: stdio\|http\|sse, command, args, env, url, headers, enabled, roles? }`；创建后立即连接并列出工具 → 201。stdio 需 `MCP_ALLOW_STDIO=true` 且 manage |
| `PATCH` / `DELETE P/mcp-servers/:id`    | 同上                   | `disabledTools[]` 停用单个工具；`roles` 限定哪些会话（coordinator / thread / personal）能用项目级服务器                                                                                                        |
| `POST P/mcp-servers/:id/refresh`        | 同上                   | 断开重连、重新列工具 → `McpServer`                                                                                                                                                                             |
| `GET P/skills`                          | view                   | 内置 + 项目 + 我的个人，**不合并**（设置页要看到被覆盖的那条）                                                                                                                                                 |
| `POST P/skills`                         | write（项目级 manage） | `SkillCreateInput { scope, slug, name, description, body, attachments[{ path, content }], enabled, userInvocable, modelInvocable }`；同作用域同 slug → 409                                                     |
| `POST P/skills/import`                  | 同上                   | `{ scope, markdown, slug?, attachments }`：解析 `SKILL.md` frontmatter（`name`、`description` 必填；`disable-model-invocation`、`user-invocable`）                                                             |
| `PATCH` / `DELETE P/skills/:id`         | 同上                   | `SkillUpdateInput` 各字段可选                                                                                                                                                                                  |
| `GET P/commands`                        | view                   | `SlashCommand[]`：内置在前（goal、plan、skill、model、effort、profile、clear、compact、forward、stop、help），再是项目与我的自定义                                                                             |
| `POST P/commands`                       | write（项目级 manage） | `{ scope, name, description, argumentHint, template }`；`$ARGUMENTS` 替换为 `/name` 后面的文字；与内置同名 → 409                                                                                               |
| `PATCH` / `DELETE P/commands/:id`       | 同上                   |                                                                                                                                                                                                                |
| `POST P/commands/run`                   | write                  | 会话类指令：`{ threadId \| null, name: clear\|compact\|goal, args }` → `CommandRunResult { ok, text, messageId }`；`threadId = null` 指协调者；agent 正在跑时 `ok=false`                                       |
| `GET P/profiles`                        | view                   | 内置 11 个科研 profile + 项目 + 我的个人（不合并）                                                                                                                                                             |
| `POST` / `PATCH` / `DELETE P/profiles…` | write（项目级 manage） | `ProfileCreateInput { scope, slug, name, description, icon, prompt, skills[], starters[], effort }`                                                                                                            |
| `PATCH P/agents/:sessionId/settings`    | write，且能看到该会话  | `SessionSettingsInput { model?, effort?, profile? }`（`null` = 回到默认）→ `AgentSession`；模型或 profile 不存在 → 422；别人的个人会话 → 404                                                                   |

**指令怎么生效**：`prompt` 类（/goal、/plan、/skill、/<skill slug>、自定义）前端照原样作为消息发出，服务端在唤醒信封里该消息后追加 `<command-expansion>`；`session` 类（/clear、/compact、/goal clear）调 `commands/run`；`client` 类（/model、/effort、/profile、/forward、/stop、/help）前端自己处理（调会话设置、转发、停止等已有端点）。`AgentSession` 新增 `effort`、`profile`、`goal`。`agent_steps.data.model` / `effort` 记录每次调用实际走的路由。

环境变量（`.env.example`）：`LLM_MODELS`、`LLM_DEFAULT_MODEL`、`LLM_DEFAULT_EFFORT`、`LLM_PROVIDERS`（JSON：`[{ id, name, baseUrl, apiKey | apiKeyEnv, thinkingFormat?, models: ["m1", { model, name, efforts, defaultEffort }] }]`）、`MCP_ALLOW_STDIO`（默认 false）。

### 2.14 共享云电脑（`modules/desktops`，ARCHITECTURE.md §13）

类型在 `packages/shared/src/desktop.ts`。查看 = 所有成员（含访客）；其余写操作 = owner / advisor / member（访客 403）；非成员 404。`DESKTOP_ENABLED=false` 时 GET 返回 `status: 'disabled'`，写操作 501。

| 方法  | 路径                                    | 说明                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/projects/:projectId/desktop`          | `DesktopStateForMe`：`status`（disabled / unavailable / stopped / starting / running / stopping / error）、`message`、`mode`、`controller`（user 或 agent）、`pendingRequest`、`viewers[]`（含 `canInput`）、`limits`、`runningCount`、`sleepsAt`，以及 `me { role, canOperate, canInput }`。Docker 不可达或没有镜像时 `unavailable` + 中文原因 |
| PATCH | `/projects/:projectId/desktop`          | `{ mode: 'turns' \| 'free' }`（轮流操作 / 同时操作），校验失败 422                                                                                                                                                                                                                                                                              |
| POST  | `/projects/:projectId/desktop/start`    | 启动（等到 VNC 就绪才返回）。满额时自动休眠最久没用的空闲云电脑；都在用 → 409 `details.reason='capacity'`（「资源不足」）；启动失败 409 `reason='start_failed'`                                                                                                                                                                                 |
| POST  | `/projects/:projectId/desktop/stop`     | 休眠（容器停止，主目录保留），断开所有观看者（WS 4410）                                                                                                                                                                                                                                                                                         |
| POST  | `/projects/:projectId/desktop/control`  | `{ action: 'take' \| 'release' \| 'request' \| 'deny' \| 'handoff', userId? }`。不允许时 409 `reason='control'` + 中文原因（例如「某某正在操作，先申请控制…」）。没在运行 409                                                                                                                                                                   |
| POST  | `/projects/:projectId/desktop/type`     | `{ text (1–4000), enter? }`：服务端用 xdotool 在光标处输入（中文可用）。要求我当前 `canInput`，否则 403。成功 204                                                                                                                                                                                                                               |
| GET   | `/projects/:projectId/desktop/stats`    | `{ stats: { cpuPercent, memoryBytes, memoryLimitBytes, pids } \| null }`                                                                                                                                                                                                                                                                        |
| GET   | `/projects/:projectId/desktop/activity` | 最近 40 条 `DesktopActivity`（agent 的操作，旧到新）                                                                                                                                                                                                                                                                                            |

**VNC**：`WS /api/v1/projects/:projectId/desktop/vnc`，二进制帧，内容就是 RFB 3.8（noVNC 直接用）。Cookie 鉴权；关闭码 `4401` 未登录、`4403` 无权限（成员关系变化 / 连接数超过每人 5 条）、`4404` 非成员、`4409` 没在运行、`4400` 协议错误、`4410` 已休眠。服务端只转发控制者（或同时模式下的非访客）的键盘 / 鼠标 / 剪贴板消息，其余丢弃；SetDesktopSize 一律丢弃（分辨率固定为 `DESKTOP_RESOLUTION`）。

**瞬时事件**（`/ws` 的 `ephemeral` 帧，§3.1）：`desktop.updated`（payload = `DesktopState`，不含 `me`，前端按自己角色重算）与 `desktop.activity`（payload = `DesktopActivity`：`kind`、`summary`、坐标 `x/y`、`text`、截图 `fileId/filePath`、`actor { sessionId, name, threadId }`、`ok`、`at`）。

### 2.15 文献库（`modules/library`）

论文导入 → 获取元数据与开放获取 PDF → 版面解析 → 段落索引 → 阅读、检索、问答、引用。类型在 `@srh/shared` 的 `entities-library.ts` / `api-library.ts`。项目权限：成员都可读（含访客），并可修改论文标题、标签和现有笔记；导入、归档、删除、补传 PDF、重新解析、插入引用、问答（消耗模型额度）仍需要 `write`（owner / advisor / member）。后者对访客返回 403，非成员返回 404。这项文献编辑权限不改变其他模块的角色规则。

**个人库（L01）**：下表中 `P/library` 的路径同时提供 `/library` 版本（均位于 `/api/v1` 下），但个人库不提供 `/library/cite`。个人库所有接口要求登录，仅操作登录者自己的资料；不从请求体或查询参数接受所有者身份，未登录返回 401，其他人的论文 ID 返回 404。无需加入项目即可导入、查看、修改、下载、检索和问答。个人论文响应 `projectId: null, ownerUserId: <登录用户 ID>`；项目论文保留原 `projectId`，附带 `ownerUserId: null`。新增归属字段兼容旧客户端，`Paper.projectId` 类型扩为可空。

个人库列表、去重、引用键、解析任务及 BM25 缓存均按个人归属隔离；项目搜索与 Agent 的现有项目文献工具只读取项目库。私人 PDF 不出现在项目文件列表或通用项目文件下载接口。文献 PDF 响应使用 `Cache-Control: private, no-store`。私人论文的创建、更新、删除和解析进度不写入或广播项目事件；个人页面后续通过个人库接口刷新进度。`status.queue` 只统计请求者当前库的任务。

**个人库页面（L02）**：网页入口 `/library`，阅读页 `/library/:paperId`；无项目用户登录后进入个人库，项目侧栏也有个人库入口。网页上的所有新导入（包括项目页弹窗、参考文献中的 DOI/arXiv 导入）统一调用个人 `/library/papers`；项目页发起导入不会自动发布。个人解析中的列表和详情每 2 秒刷新，完成或失败后停止这类定时请求；回到窗口时重新检查个人数据。查询缓存按个人账号与项目分别隔离。个人阅读可使用现有单份笔记、问答和 BibTeX 导出，但不能直接插入项目文档引用。

旧项目导入 HTTP 接口和 Agent 的项目 `library_import` 工具暂时兼容保留，不在 L02 自动转移其归属；上述“先到个人库”约束针对网页入口。跨库发布为后续独立副本功能，个人页只展示尚未开放的发布入口，不能用个人 `/cite` 接口直接向项目写入私人资料。

**独立发布与团队更新（L07 / L11，2026-10-31 追加）**：以下更新取代上一段 L02 阶段“发布尚未开放”的说明。项目侧栏把“个人文献库”作为“我的工作区”下方的子入口；项目资源入口称为“项目文献库”。个人库路径与归属不变，不会因为入口嵌入项目侧栏而属于当前项目。

| 方法 | 路径                               | 权限与响应                                                                                                                                                                      |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/library/papers/:paperId/publish` | 登录用户只能发布自己的个人论文，且对目标项目具有 `write` 权限；新建返回 201，重复同次请求返回 200；响应 `{paper: Paper, replayed: boolean}`，`Cache-Control: private, no-store` |

发布请求使用 `PaperPublishInput`：`{projectId, requestId, sourceUpdatedAt}`，其中 `requestId` 为 UUID，`sourceUpdatedAt` 是预览时个人论文的 ISO 时间；拒绝未声明字段（422）。预览与提交间源记录变化返回 `409 version_conflict`，要求重新打开预览。源归档或处理中返回 409。未登录 401；非本人论文或非目标项目成员 404；访客向项目发布 403。曾成功完成的同次请求在个人原件删除后仍可重放；更换项目、源论文或源时间却复用请求编号返回 409；已删除的团队副本不会因重试被重新创建。

发布复制标题、作者、出版信息、标签、可用解析结构与段落，并为论文、段落和 PDF 分配项目独立标识与物理文件。项目内引用键冲突时生成新键。不复制私人笔记、高亮、批注、问答、临时译文、私人路径或后台任务错误。无 PDF 时明确发布元数据，状态为 `needs_pdf`；有 PDF 但无可用解析结果时为 `failed`，可在项目重新解析。源 DOI、arXiv、PDF hash、URL 或既往发布记录匹配项目论文时返回 `409 conflict`，`details = {existingPaperId, projectId}`，包括已归档候选；本轮不覆盖、追加或合并已有内容，完整去重发布流程留 L10。

数据库内使用事务保存项目文件行、论文、段落、发布凭据与事件；同项目发布通过项目行锁串行化，发布期间锁定源论文和成员关系。提交后广播 `file.created` / `paper.created` 并失效检索缓存。可捕获失败会回滚数据库并清理本次写入的独立文件，成员不会看到半成品；磁盘不属于数据库事务，进程被强制终止可能留下无数据库引用的孤立文件，后续需维护清理。发布凭据的私人来源 ID 仅服务端留存，不添加到项目 `Paper` DTO 或广播中。

**元数据版本扩展（L11）**：以下为原 PATCH 契约的追加字段。`Paper` 新增可选 `titleVersion`、`tagsVersion`（服务端与迁移默认 1，类型可选用于兼容旧缓存）；PATCH 接受 `baseTitleVersion?`、`baseTagsVersion?`。只在修改相应字段时比较版本，成功递增该字段版本；不同字段的并发保存可同时成立，同字段过期返回 `409 version_conflict` 与 `details.current: Paper`，整个 PATCH 不生效。新网页编辑器仅提交实际改动字段及其基线版本，实时事件不改写输入中的草稿；冲突后显示服务器值并保留草稿，由用户选择载入最新版本。旧调用可省略新增版本：服务端以本次读取的版本防写入竞态，但无法识别旧客户端早先打开的陈旧页面。原 `baseNoteVersion` 行为与笔记冲突详情保留。

**实时接入（L11）**：列表和阅读页接入论文创建、更新、删除事件；订阅成功及断线重连时重取当前列表和详情。事件到达时终止可能陈旧的在途 REST 请求并重新获取，避免旧快照覆盖新变更。`member.removed` 关闭该用户已订阅相关项目的 `/ws` 连接，项目归档关闭相关连接：先发 `forbidden` 错误，再以 4403 关闭；连接上的订阅和在线状态同时撤销。历史补发前与订阅确认前重新检查权限。客户端撤下缓存、在线状态并刷新 `/auth/me`；新连接仍需成员校验，移除后 HTTP 和重新订阅被拒绝。此变更不提供远程收回已经下载的资料，也不代表笔记正文已有 CRDT 共同编辑；新笔记、批注、问答目录将在对应实体任务完成后接入。

**PDF 选区与翻译（R01/R02）**：个人和项目阅读器均叠加 PDF.js 文本层，支持同一页内选词、选句与跨行选择。原文保留浏览器选区的换行；页面旋转和缩放通过 viewport 逆变换还原到原始 PDF 左上角坐标。账号、库、论文、文件版本切换后销毁选区与正在进行的翻译；阅读器缩放后需要重新选择，打开的翻译对话框在同一布局内保留文字快照。跨过 1024px 切换桌面／窄屏布局时阅读区重建，会清除选区与临时译文。跨页翻译提示分次选择；无文字页提示能力限制，不自动 OCR。明显跨栏选区保留原文并提示核对，不猜测阅读顺序。

**个人模型与翻译侧栏更新（2026-11-01，覆盖本节旧版的弹窗、布局重建与个人仅平台模型描述）**：翻译改为常驻阅读侧栏标签。默认自动翻译，选区稳定 500ms 后调用；关闭开关后手动调用。切换模型或语言时，自动模式重新翻译，手动模式等用户点击。切换侧栏标签或桌面/窄屏布局保留 PDF 与翻译组件；换账号、库、论文或 PDF 文件销毁请求。相同文字、页码、模型、语言不因普通重绘重复调用；修改选区、取消、关闭自动翻译会中止旧请求，旧响应不能覆盖新结果。开关/模型选择仅保留本次阅读，不保存原文或译文。

个人模型目录包含平台模型，以及当前账号在未归档项目中具有 owner/advisor/member 身份的已启用项目模型。`providerName` 显示“项目名 · 提供方名”。目录和每次调用分别检查最新成员关系，访客、已退出项目、归档项目、停用模型不允许借用。调用项目模型不会改变论文归属或发布个人内容，密钥始终留在服务端；费用和发送目标属于所选模型提供方。显式不可用模型仍返回 422，不静默切换。个人/项目文献 `/status` 的 `llm` 与 `/qa` 使用相应范围内的模型目录，关键词生成与问答不再仅依赖环境变量。未指定模型时仍按有效 `LLM_DEFAULT_MODEL`、首个可用模型的顺序选择。

个人会话 `POST P/threads` 追加可选 `model: string`（完整 `provider/model` ID，最长 240 字符），在发出第一条消息前保存到 agent 会话。显式模型必须属于当前项目的启用目录，否则 422；省略时采用该项目可用默认模型，无模型时保留旧接口允许建会话的行为，由运行时提示无法调用。运行时始终启动，在调用时读取目录；从设置页新增项目模型后无需重启运行时。

| 方法 | 路径（项目为 `P/library`，个人为 `/library`） | 权限与响应                                                                                                                       |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `P/library/translation-models`                | 个人要求登录，项目要求 view；返回 `LibraryTranslationModels`：`defaultModel` 与 `{id,name,providerName}[]`。不返回密钥或服务地址 |
| POST | `P/library/papers/:paperId/translate`         | 个人要求所有者，项目要求 write；请求 `LibraryTranslationInput`，返回 `LibraryTranslationResult`                                  |

翻译请求：`{text,fileId,page,targetLanguage?,modelId?}`；`text` 去除首尾空白后 1–4000 字符；`fileId` 必须等于论文当前 PDF 文件 ID；`page` 从 1 起；`targetLanguage` 为 `zh-CN`（默认）/ `en` / `ja` / `de` / `fr`。不接受其他字段。响应为 `{translation,targetLanguage,modelId,modelName}`，译文按纯文本展示。个人只列出平台级模型，项目可额外使用本项目已启用的模型；默认优先采用范围内有效的 `LLM_DEFAULT_MODEL`，否则首个可用模型。显式提交不可用 `modelId` 返回 422，不自动切换提供方。

该接口不要求结构解析完成。先检查论文归属、PDF 版本和页码，再使用既有 `agents/llm/registry` 的提供方和客户端发送一次无工具文本生成请求。只向模型发送选中文字与翻译要求，不附加论文全文、笔记、问答历史；不写团队事件、笔记或问答记录。项目访客不能发起消耗模型额度的翻译。两类接口均使用 `Cache-Control: private, no-store`。

错误：未登录 401；非成员／无权论文 404，项目访客 403；输入或模型无效 422；PDF 版本过期 409；同一用户并发超过 2 或单应用进程总并发超过 12 时 429。45 秒超时后中止上游并释放名额；客户端断开也传递取消信号。未配置、余额不足、鉴权失败、空结果、输出截断或上游不可用返回 503 的中文提示，模型限流返回 429；不透传上游错误正文。并发限制为进程内限制，多实例部署需要共享限流。真实提供方是否在取消后停止计费由其服务行为决定。

| 方法   | 路径                                | 说明                                                                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/library/status`                  | `LibraryStatus`：解析器（`grobid` / `mineru`）、是否可达、版本、队列、LLM 是否可用                                                                                                                                                                                                                                          |
| GET    | `P/library/papers`                  | `Paper[]`，`?q=&tag=&status=&archived=`；默认不含归档                                                                                                                                                                                                                                                                       |
| POST   | `P/library/papers`                  | JSON `{doi}` / `{arxiv}` / `{url}`（三选一，可带 `tags`），或 multipart `file`（PDF ≤ 100MB，可带 `tags=a,b`）。新建 201，已存在 200 + `duplicate: true`（按 DOI、arXiv 编号、URL、PDF sha256 去重；导入已归档的会恢复）。返回 `PaperImportResult`                                                                          |
| GET    | `P/library/papers/:paperId`         | `PaperDetail` = `Paper` + `structure`（页面尺寸、章节、段落、公式、图表、参考文献、KaTeX 宏）                                                                                                                                                                                                                               |
| PATCH  | `P/library/papers/:paperId`         | `{title?, tags?, note?, baseNoteVersion?, archived?}` → `Paper`；改 `note` 时 `noteVersion+1`。带 `baseNoteVersion` 且与当前 `noteVersion` 不一致 → `409 version_conflict`，整个 PATCH 不生效，`details` = `{ current: Paper, note, noteVersion }`（最新笔记供前端合并）；不带 = 直接覆盖（兼容旧调用）；不改 `note` 时忽略 |
| DELETE | `P/library/papers/:paperId`         | 204；同时删除 `library/` 下的 PDF                                                                                                                                                                                                                                                                                           |
| GET    | `P/library/papers/:paperId/pdf`     | PDF 流（鉴权）                                                                                                                                                                                                                                                                                                              |
| POST   | `P/library/papers/:paperId/pdf`     | multipart 补传 PDF（`needs_pdf` 时），随后自动解析                                                                                                                                                                                                                                                                          |
| POST   | `P/library/papers/:paperId/reparse` | 重新排队解析（例如 GROBID 恢复后）                                                                                                                                                                                                                                                                                          |
| GET    | `P/library/papers/:paperId/bibtex`  | `text/x-bibtex`                                                                                                                                                                                                                                                                                                             |
| POST   | `P/library/bibtex`                  | `{paperIds?}`：选中的，省略 = 全部                                                                                                                                                                                                                                                                                          |
| GET    | `P/library/search`                  | `?q=&paperId=&limit=` → `LibraryHit[]`（段落 + 页码 + 页内段号 + 坐标）                                                                                                                                                                                                                                                     |
| POST   | `P/library/qa`                      | `{question, paperId?, history?}` → `application/x-ndjson` 流：`sources` → `delta`×N → `done`（或 `error`）；没配 LLM 503 `llm_unavailable`                                                                                                                                                                                  |
| POST   | `P/library/cite`                    | `{docId, paperIds, bibFile?}`：把 BibTeX 合并进 LaTeX 文档工程的 `.bib`（默认 `references.bib`，已有键不重复写），返回 `{docId, bibFile, keys, added, cite: "\\cite{…}"}`                                                                                                                                                   |

- **状态机**：`queued → fetching → parsing → indexing → ready`；没有开放获取 PDF → `needs_pdf`（元数据已保存，等成员上传）；不可恢复的错误 → `failed`。每次变化都发 `paper.updated`（带 `progress` 0–100 和中文 `stage`）。后台队列并发 1，暂时性错误（网络、GROBID 503 / 超时）最多重试 3 次（30s、2min）。服务启动时把未完成的论文重新入队。
- **元数据**：arXiv API（arXiv 编号，或 DOI `10.48550/arXiv.*`）、Crossref（DOI）；PDF 来源依次是 arXiv、OpenAlex `best_oa_location`、Semantic Scholar `openAccessPdf`。请求带礼貌邮箱（`CROSSREF_MAILTO`，空时用 `RESEARCH_CONTACT_EMAIL`）；所有外部下载都经过 SSRF 检查（拒绝内网地址，逐跳检查重定向）。
- **解析**：`PAPER_PARSER=grobid`（默认）调用 GROBID `processFulltextDocument`（`teiCoordinates` 含段落、标题、图表、公式、参考文献、句子）→ TEI 转成 `PaperStructure`。arXiv 论文另外下载 e-print 源码，抽出行间公式（按 LaTeX 规则编号）和 `\newcommand` 宏，再按编号和文字签名匹配到 GROBID 识别出的公式上，前端用 KaTeX 显示；匹配不上的公式显示 PDF 原图区域。GROBID 不可达时降级为 pdf.js 逐页纯文本（`parser = 'pdf-text'`，`error` 写明原因），服务恢复后可以 `reparse`。`mineru` 只预留了接口，没有实现。
- **坐标**：`PdfBox {page, x, y, w, h}`，单位 pt，原点在页面左上角（与 GROBID 一致）。
- **索引与检索**：一段一个块（摘要、正文段落、公式、图注、表格、脚注），进程内 BM25（英文去停用词 + 词干，中文二元组），按项目缓存，变更时失效；不需要向量库，PGlite 与 PG16 都能用。中文问题先由 LLM 转成英文检索词（`sources.keywords`）。
- **引用格式**：问答与 agent 工具统一用 `[p.5 ¶3]`（单篇）或 `[citekey, p.5 ¶3]`（跨论文），`¶` 是该页内按阅读顺序的段号。`@srh/shared` 的 `parseCitationMarkers` / `splitByCitations` 负责解析；前端把它渲染成引用标签，点击跳到 PDF 对应位置并闪烁高亮。
- **引用键**：`姓 + 年 + 标题首个实词`（去重音、转 ASCII），如 `vaswani2017attention`；项目内重复时加 `b`、`c`…；拿到正式元数据或解析完成后固定，不再变化。
- **agent 工具**（`agents/tools/library.ts`）：`library_search`（检索段落，中文会先转英文检索词）、`library_read`（按论文 + 页码 / 小节读原文段落）、`library_import`（导入并等待解析，最多 150s）、`library_cite`（取 BibTeX，或写进 LaTeX 文档的 `.bib`）。工具结果要求模型用 `(citekey, p.N ¶M)` 引用。
- **事件**：项目库发布 `paper.created` / `paper.updated`（`Paper`）、`paper.deleted`（`{ id }`），`threadId` 恒为 `null`；个人库不发布项目事件。

### 2.16 实验 Notebook（`modules/notebooks`）

每个实验记录的主体是一本 Jupyter notebook。单元格内容走 `/collab/<notebookId>`（Yjs，多人同时编辑；按 id 前缀分到 notebooks 模块）；REST 只管元数据、导入导出和内核。请求体类型在 `@srh/shared` 的 `notebooks.ts`。

| 方法   | 路径                                   | 权限         | 说明                                                                                                                                      |
| ------ | -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/notebooks?experimentId=`            | view         | 列表                                                                                                                                      |
| POST   | `P/notebooks`                          | write        | `NotebookCreateInput {title?, experimentId?, ipynb?}` → 201 `Notebook`；带 `ipynb` 即从 .ipynb 新建                                       |
| GET    | `P/notebooks/:id`                      | view         | `Notebook` + `kernel.status`                                                                                                              |
| PATCH  | `P/notebooks/:id`                      | write        | `{title?}`                                                                                                                                |
| DELETE | `P/notebooks/:id`                      | write        | 先关内核，再删，204                                                                                                                       |
| POST   | `P/notebooks/:id/import`               | write        | `{ipynb}` 整体替换内容（≤64 MB）                                                                                                          |
| GET    | `P/notebooks/:id/export?format=`       | view         | `ipynb`（默认）/ `py` / `md` / `html` / `pdf` / `zip`；HTML 里单元格输出的 `text/html` 会先清洗（去掉脚本、事件属性、`javascript:` 链接） |
| POST   | `P/notebooks/:id/execute`              | write        | `{cellIds}`（空 = 全部代码单元格）按顺序排队 → `{runs}`；没配内核 501，容量满 429                                                         |
| POST   | `P/notebooks/:id/interrupt`            | write        | 中断；内核已经崩溃时直接重启                                                                                                              |
| POST   | `P/notebooks/:id/restart`              | write        | `{runAll?, clearOutputs?}` → `{ok, runs}`                                                                                                 |
| POST   | `P/notebooks/:id/shutdown`             | write        | 关内核                                                                                                                                    |
| GET    | `P/notebooks/:id/variables`            | view         | 变量面板 `NotebookVariable[]`                                                                                                             |
| POST   | `P/notebooks/:id/complete` · `inspect` | write · view | `{code, cursorPos}` 补全 / 查看文档                                                                                                       |

- **内核**：每本 notebook 一个 Python 内核，跑在项目自己的隔离容器里（`KERNEL_MEMORY_MB`，生产 2048），空闲一段时间自动回收。内核意外退出（含内存超限被杀）时：正在跑的单元格得到一条中文错误输出说明原因，排队的单元格全部失败而不是一直等，内核自动重启，下一次运行直接可用；状态变化随 `notebook.updated` 推送。`input()` 交互输入不支持，会给出中文提示。
- **指标**：代码里 `srh.log_param` / `srh.log_metric` / `srh.log` 输出 `application/vnd.srh.metrics+json`，服务端写进实验记录的 params / metrics。
- **项目删除**：归档项目时关掉它的内核和云电脑并删除容器；后台还会定期清掉已归档或已不存在项目的残留容器。
- **agent 工具**：`read_notebook`、`edit_notebook`、`run_notebook_cells`（画了图却没有图像输出时，该单元格的结果带 `warning`，提示去掉 `matplotlib.use("Agg")` 或调用 `plt.show()`）。
- **事件**：`notebook.created` / `notebook.updated`（`Notebook`）、`notebook.deleted`（`{ id }`）。

### 2.17 只给 agent 用的文档工具（`agents/tools`）

这些不是 REST 端点，前端无需对接，列在这里是为了说明 agent 能做什么：

- `edit_document` 新增 `delete_section {heading, occurrence?}`（删掉一整节，用来清理重复小节）；`replace_text` 的 `find` 可以跨段落、包含标题行，`occurrence` 指定第几处。
- `compile_latex {doc_id, force?}`：在平台里编译 LaTeX 文档，返回 `{status, ok, pages, errors, warnings, log_tail…}`，agent 据此确认编译通过后才说「已验证」。

### 2.18 版本管理与改动提案（C · `modules/versioning`）

契约在 `packages/shared/src/versioning.ts`。`VersionTargetKind = document | notebook | file`。

#### 2.18.1 历史版本

| 方法 | 路径                                       | 权限  | 请求                                                 | 响应                                                                                                                        |
| ---- | ------------------------------------------ | ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET  | `P/versions?targetKind=&targetId=`         | view  | —                                                    | `Version[]`，新的在前（最多 200）                                                                                           |
| POST | `P/versions`                               | write | `VersionCreateInput { targetKind, targetId, note? }` | `201 Version`（`kind: manual`）；发 `version.created`                                                                       |
| GET  | `P/versions/current?targetKind=&targetId=` | view  | —                                                    | `VersionContent`：当前内容的可读表示，和版本对比用                                                                          |
| GET  | `P/versions/:versionId`                    | view  | —                                                    | `VersionDetail { version, content: VersionContent }`                                                                        |
| POST | `P/versions/:versionId/restore`            | write | —                                                    | `VersionRestoreResult { backup, restored }`：先存 `pre_restore` 备份，再写回正文（在线编辑者实时看到），再存 `restore` 版本 |

- **存什么**：文档、notebook 存 Yjs 全量状态（`Y.encodeStateAsUpdate`）和一份可读内容 `content`；文件存原始字节（≤ 5 MB，更大的只记大小，不能回滚）。内容哈希和最新版本相同时自动快照跳过。
- **`VersionContent`**：`text { unit: block | line, language, text }`（富文本 / 幻灯片按块的 markdown，LaTeX 和文本文件按行）、`sheet { sheets: [{ name, cells: { A1: 原始值 } }] }`、`notebook { cells: [{ id, type, source }] }`、`binary { size, mime }`。前端用 shared 里的 `diffSeq` / `splitSegments` / `sheetCellChanges` / `notebookCellChanges` 做对比：文本逐段或逐行，表格逐单元格，notebook 按单元格 id 逐个。
- **`kind`**：`manual`（存为版本）、`auto`（自动快照：新建，以及编辑后距上一个版本超过 5 分钟；文件每次被覆盖）、`pre_restore` / `restore`、`pre_merge` / `merge`（合入改动提案前后）。
- **旧接口**：`P/docs/:docId/versions*`（§2.7）保留；旧表 `document_versions` 的记录在第一次列版本时搬进 `versions`（id 不变）。

#### 2.18.2 改动提案

| 方法  | 路径                                        | 权限  | 请求                                                                                  | 响应                                                                                                       |
| ----- | ------------------------------------------- | ----- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET   | `P/proposals?targetKind=&targetId=&status=` | view  | —                                                                                     | `ChangeProposal[]`（最多 100，按更新时间倒序）                                                             |
| GET   | `P/proposals/:proposalId`                   | view  | —                                                                                     | `ChangeProposal`，`conflicts` 是按正文当前状态算出的冲突改动块 id                                          |
| PATCH | `P/proposals/:proposalId/decisions`         | write | `ProposalDecisionsInput { decisions: { [hunkId]: accepted \| rejected \| pending } }` | `ChangeProposal`；发 `proposal.updated`                                                                    |
| POST  | `P/proposals/:proposalId/merge`             | write | `ProposalMergeInput { acceptPending?, skipConflicts?, lgtm? }`                        | `ChangeProposal`（`merged`）；有冲突且没 `skipConflicts` → `409 conflict`（`details.conflicts`），正文不动 |
| POST  | `P/proposals/:proposalId/close`             | write | —                                                                                     | `ChangeProposal`（`closed`），审阅一并关闭                                                                 |

- **何时生成**：agent 通过 `edit_document`（富文本、表格、LaTeX）或 `edit_notebook` 改一个**不是它自己新建**的对象、且项目设置 `agentDirectWrite = false`（默认）时，不写正文，而是在草稿 Y.Doc（正文状态的副本）上执行同样的修改。幻灯片不走提案（直接写，仍有版本历史）。同一 agent 线程对同一对象还开着的提案会叠加修改，已作出的逐条决定按改动块 id 保留。工具返回里多 `proposal_id` 和 `notice`。
- **改动块**（`ProposalHunk`）：`text`（富文本按顶层块、LaTeX 按行；`before` / `after` 各带 1 条上下文，`at` 是在提出时正文里的位置）、`cell`（表格单元格 `sheet!ref`：`old → new`）、`nb_cell`（notebook 单元格 `add / remove / modify`，按单元格 id）。
- **审阅**：新提案自动发起一条 `targetKind: 'proposal'` 的审阅，审阅人 = 负责人和导师（没有就请成员，最多 10 人），`threadId` = agent 所在线程，快照是改动列表的 markdown。全部审阅人 LGTM（`approved`）→ 自动整体合入（没决定的视为接受，冲突的跳过）；有人在审阅页关闭审阅 → 提案一并关闭。合入或关闭提案后审阅自动关闭。`lgtm: true` 的合入同时替当前用户给这条审阅 LGTM（只有他是审阅人时）。
- **合入与冲突**：三方合并。base = 提出时的正文，current = 正文现在的状态。文本块：base 里这几块在 current 里原样还在、位置能对上（或在 current 里唯一出现）才合入；纯插入要求前一块（或后一块）没被改过；current 已经和提案一样算合入。表格单元格：current 值等于 `old` 才写，等于 `new` 算已合入，否则冲突。notebook：按单元格 id，源码等于 `old` 才改 / 删，新增插在 `afterCellId` 之后。合入前存 `pre_merge`、合入后存 `merge` 版本，在线编辑者实时看到。

#### 2.18.3 设置与 GitHub

| 方法  | 路径                       | 权限   | 请求                                                                                      | 响应                                                   |
| ----- | -------------------------- | ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| GET   | `P/versioning/settings`    | view   | —                                                                                         | `VersioningSettings`（令牌只给 `githubTokenSet`）      |
| PATCH | `P/versioning/settings`    | manage | `VersioningSettingsInput { agentDirectWrite?, githubRepo?, githubBranch?, githubToken? }` | `VersioningSettings`；发 `versioning.settings_updated` |
| POST  | `P/versioning/github/test` | manage | —                                                                                         | `{ fullName, private, defaultBranch, url, canPush }`   |

- **agent 工具**：`github_read_file {path, ref?}`（读文件或列目录）、`github_open_pr {branch, title, body, files: [{path, content | null}]}`（基于目标分支建新分支、一次提交、开 PR，返回 PR 链接）。
- **边界（最小版本）**：只新建分支和开 PR，从不合并，不推送已有分支（分支名占用时加后缀）；每个文件整体覆盖或删除，不做行级补丁；一次最多 30 个文件、每个 ≤ 1 MB；不把仓库同步进项目文件，不跑 CI，评审和合并在 GitHub 上由人完成。令牌存在服务端数据库，只写不读，建议用只授权单个仓库 Contents / Pull requests 的 fine-grained token。只支持 github.com。

### 2.19 个人 / 团队空间与分享（`modules/sharing`）

文档和文献库的每一条记录都属于一个空间：`space = 'team' | 'personal'`。迁移前的数据全部是 `team`，行为不变；`personal` 的记录只有所有者（`ownerUserId`）和被分享的人能看到，课题负责人、导师也不例外。

| 方法   | 路径                                | 权限   | 请求体                         | 返回 / 说明                                                                                                               |
| ------ | ----------------------------------- | ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P/shares/:kind/:id`                | 所有者 | —                              | `ShareSettings`（链接 + 邀请名单）；`kind = document \| paper`；团队空间的资源 409                                        |
| PATCH  | `P/shares/:kind/:id/link`           | 所有者 | `{ scope?, level? }`           | `scope`：`invited`（关闭链接）/ `project`（课题成员）/ `anyone`（知道链接的研协用户）                                     |
| POST   | `P/shares/:kind/:id/link/reset`     | 所有者 | —                              | 换新 token，旧链接和靠旧链接获得的访问立即失效                                                                            |
| POST   | `P/shares/:kind/:id/grants`         | 所有者 | `{ userIds?, emails?, level }` | 按人邀请；`emails` 可以邀请课题外的研协账号                                                                               |
| PATCH  | `P/shares/:kind/:id/grants/:userId` | 所有者 | `{ level }`                    | 改级别                                                                                                                    |
| DELETE | `P/shares/:kind/:id/grants/:userId` | 所有者 | —                              | 移除                                                                                                                      |
| POST   | `/share/:token`                     | 登录   | —                              | 打开链接 → `ShareResolveResult { projectId, resourceKind, resourceId, level }`；链接关闭 / 范围不符 403，token 不存在 404 |
| POST   | `P/docs/:docId/move`                | 见下   | `{ space }`                    | 子文档跟着移动                                                                                                            |
| POST   | `P/library/papers/:paperId/move`    | 见下   | `{ space }`                    | 团队库已有同一篇（去重 / citekey 冲突）时 409                                                                             |

- **级别**：`view`（可阅读）< `comment`（可评论，只对富文本生效）< `edit`（可编辑，不能删除）< `manage`（所有者）。列表和详情返回 `access`（当前用户的级别），个人资源还带 `shared`。
- **列表**：`GET P/docs?space=team|personal|shared`、`GET P/library/papers?space=…`；不带参数时等于 `team`，旧客户端不受影响。`shared` = 别人分享给我的（被邀请，或打开过仍有效的链接）。
- **链接**：「知道链接的人」仍要求登录研协；课题外的人只能读到只读详情页。链接访问 = 用当前 token 打开过的记录；重置会清掉这些记录，关闭链接等于 `scope = invited`。
- **移动**：移进团队空间只有所有者能做，会清空链接和邀请；移进个人空间需要创建者、课题负责人或导师。
- **状态码**：看不到 → 404（不暴露存在与否）；级别不够 → 403；对团队资源做分享操作 → 409。
- **协同**：`/collab` 握手按同一套权限判定，`view` / `comment` 只读；分享设置变化时服务端断开该文档的全部连接（4205），客户端按新权限重连。
- **agent**：工具按发起人的权限读写；协调者和团队线程只看团队空间；个人工作区能看到本人个人空间和分享给本人的内容。改动提案的审阅人对个人文档是其所有者；组会汇报只取团队文档。
- **文件**：个人文献的 PDF 存在 `STORAGE_DIR/_private/<projectId>/`，不进项目文件；个人资源的 PDF 响应 `Cache-Control: private, no-store`。

### 2.20 研究计划与团队依据（`modules/plans`）

每个项目一份团队正式方案（`kind = official`），只有负责人（owner / advisor）采纳提案才会出新的正式版本；成员可以从当前正式版本分叉探索副本（`kind = exploration`），随意修改，不影响正式方案。个人工作记忆按项目、按人保存；关键数据、实验结果和结论通过提案进入团队依据（团队记忆副本）。类型与输入 schema 见 `@srh/shared` 的 `plans.ts`。

| 方法   | 路径                                     | 权限            | 请求体                                   | 返回 / 说明                                                                                     |
| ------ | ---------------------------------------- | --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `P/plans`                                | view            | —                                        | `PlansOverview { official, explorations, proposals, basis, canManage }`                         |
| POST   | `P/plans/official`                       | manage          | `OfficialPlanInit`                       | 201 `Plan`（第 1 版）；已有正式方案 409                                                         |
| POST   | `P/plans/explorations`                   | write           | `ExplorationCreate`                      | 201 `Plan`：复制当前正式正文，`forkedFromVersion` = 当前正式版本                                |
| GET    | `P/plans/:planId`                        | view            | —                                        | `Plan`                                                                                          |
| PATCH  | `P/plans/:planId`                        | 建立者 / 负责人 | `ExplorationPatch`                       | `Plan`；正式方案只有负责人能改标题                                                              |
| POST   | `P/plans/:planId/archive`                | 建立者 / 负责人 | —                                        | `Plan`（`archived`）；正式方案不能归档（409）                                                   |
| PUT    | `P/plans/:planId/content`                | 建立者 / 负责人 | `PlanContentInput`                       | `Plan`，并追加一条 `PlanVersion`；正式方案、非进行中的副本 409；版本不符 409 `version_conflict` |
| GET    | `P/plans/:planId/versions`               | view            | —                                        | `PlanVersion[]`（新到旧）                                                                       |
| GET    | `P/plans/:planId/versions/:version`      | view            | —                                        | `PlanVersion`；版本号不是整数 422                                                               |
| GET    | `P/plans/proposals?status=`              | view            | —                                        | `BasisProposal[]`（草稿只返回自己的）                                                           |
| POST   | `P/plans/proposals`                      | write           | `BasisProposalCreate`                    | 201 `BasisProposal`；`submit: true` 直接提交，否则存草稿                                        |
| GET    | `P/plans/proposals/:proposalId`          | view            | —                                        | `BasisProposal`；别人的草稿 404                                                                 |
| PATCH  | `P/plans/proposals/:proposalId`          | 提出者          | `BasisProposalPatch`                     | `BasisProposal`；只能改草稿 / 待审批的；已撤回的可再提交                                        |
| DELETE | `P/plans/proposals/:proposalId`          | 提出者          | —                                        | 204；只能删草稿 / 已撤回的                                                                      |
| POST   | `P/plans/proposals/:proposalId/submit`   | 提出者          | —                                        | `BasisProposal`（`submitted`）；给负责人发 `review` 待办                                        |
| POST   | `P/plans/proposals/:proposalId/withdraw` | 提出者          | —                                        | `BasisProposal`（`withdrawn`）；审批待办标为完成                                                |
| POST   | `P/plans/proposals/:proposalId/decide`   | manage          | `BasisProposalDecision`                  | `BasisProposal`（`accepted` / `rejected`）；只能审批待审批的                                    |
| GET    | `P/plans/memory?userId=`                 | 本人 / 负责人   | —                                        | `PersonalMemory[]`；不带 `userId` = 自己的                                                      |
| POST   | `P/plans/memory`                         | write           | `PersonalMemoryInput`（`baseVersion` 0） | 201 `PersonalMemory`                                                                            |
| PUT    | `P/plans/memory/:memoryId`               | 本人            | `PersonalMemoryInput`                    | `PersonalMemory`；版本不符 409 `version_conflict`                                               |
| DELETE | `P/plans/memory/:memoryId`               | 本人            | —                                        | 204                                                                                             |
| GET    | `P/plans/basis?status=`                  | view            | —                                        | `TeamBasis[]`                                                                                   |
| GET    | `P/plans/basis/:basisId`                 | view            | —                                        | `TeamBasis`                                                                                     |
| POST   | `P/plans/basis/:basisId/review`          | manage          | `TeamBasisReview`                        | `TeamBasis`；`confirm` 只对待复核，`retire` 只对有效 / 待复核，否则 409                         |

- **提交校验**（422）：`plan_change` 要求项目已有正式方案；不填 `content` 时取 `sourcePlanId` 指向的副本全文，不填 `basePlanVersion` 时取当前正式版本。`team_basis` 要求 `content` 和 `claimType`（`hypothesis` 假设 / `observation` 实验观察 / `decision` 正式决定）。
- **采纳 `plan_change`**：`basePlanVersion` 不等于当前正式版本时返回 409 `version_conflict`，`details.current` 为最新正式 `Plan`；提出者改 `basePlanVersion`（必要时更新正文）后再提交审批。采纳后正式方案写入新版本（`PlanVersion.proposalId`、`approvedBy` = 审批人、`createdBy` = 起草者），来源副本标为 `merged`，提案记录 `resultPlanVersion`。
- **采纳 `team_basis`**：新建一条 `TeamBasis`，记录 `proposerId` / `proposer`（提出者）、`approvedBy`（审批人）、`conditions`、`claimType`、`planVersion`（采纳时的正式版本）；证据按采纳时的版本冻结（`plan_version` 填正式版本号、`personal_memory` / `team_basis` 填当时的 `version`，已填的保留）。带 `supersedesBasisId` 时被替代的依据改为 `superseded` 并记录 `supersededBy`；它已经不是有效 / 待复核状态时 409。
- **复核**：正式方案出新版本时，`planVersion` 小于新版本的有效依据改为 `needs_review`；依据被替代时，证据里引用它（`kind = team_basis`）的有效依据也改为 `needs_review`。`reviewReason` 写明原因，并给依据的提出者和全部负责人发 `recheck` 待办。负责人 `confirm` 后回到 `active`、清空原因、`planVersion` 跟上当前正式版本；`retire` 停用，`note` 写入 `reviewReason`。
- **待办**：提交时给负责人（不含提出者本人）发 `review`；审批、撤回后对应待办标为完成；复核后该依据的 `recheck` 待办标为完成。
- **个人工作记忆**：只有本人能写，本人和负责人能读。负责人读别人的记忆用 `?userId=`；其他成员读别人的 403。负责人改或删别人的记忆 403，其他成员 404。个人记忆不发事件。
- **状态码**：未登录 401；不是成员 404；角色不够、不是建立者 / 提出者 403；状态不允许 409；校验失败 422。
- **事件**：`plan.created` / `plan.updated` / `plan.version_created`、`basis_proposal.created` / `updated` / `deleted`、`team_basis.created` / `updated`（见 §4），`threadId` 恒为 `null`。草稿也会广播，前端按 `authorId` 过滤。

### 2.21 接入：API 令牌（B · `modules/integrations`）

契约在 `packages/shared/src/integrations.ts`。给外部 agent / 脚本用的「门禁卡」，**默认关闭**（`API_TOKENS_ENABLED=false`）。

| 方法   | 路径                       | 权限             | 请求                                                                               | 响应                                                                    |
| ------ | -------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/auth/me/tokens`          | 网页登录         | —                                                                                  | `ApiTokenList { enabled, tokens: ApiToken[] }`（只回 `hint`，不回原文） |
| POST   | `/auth/me/tokens`          | 网页登录         | `ApiTokenCreateInput { name, scopes: read\|write[], projectIds?, expiresInDays? }` | `201 ApiTokenCreated { token, apiToken }`：**原文只在这里出现一次**     |
| DELETE | `/auth/me/tokens/:tokenId` | 网页登录（本人） | —                                                                                  | `204`；已撤销再撤一次同样 204（幂等）；不存在 404                       |

- **怎么用**：`Authorization: Bearer srh_pat_…`，效果与本人用 Cookie 登录相同——角色、项目成员、认领、逐条过滤全部照旧，不额外放大权限。`/ws` 握手与 `/collab` 握手同样认这个头。
- **原文与哈希**：原文 `srh_pat_<43 位 base64url>`，库里只存 SHA-256；`hint` 是原文随机部分的前 8 位，列表靠它认人。
- **`scopes`**：`read` 只能 `GET/HEAD/OPTIONS`；非安全方法需要 `write`，否则 `403 forbidden`。默认 `['read']`。
- **`projectIds`**：空数组 = 该账号能访问的全部项目；非空时，范围外的项目按「不是成员」处理（项目接口 `404`，`GET /projects`、`GET /auth/me`、`GET /inbox` 也只返回这几张项目）。
- **`expiresInDays`**：1–365，`null` = 永不过期；过期后调用一律 `401`。
- **撤销 / 关闭开关**：撤销即时生效；`API_TOKENS_ENABLED=false` 时所有令牌立刻 `401`，网页登录不受影响。关闭状态下 GET / DELETE 仍可用（方便收拾残局），POST 返回 `403`。
- **限流**：每张令牌每分钟 `API_TOKENS_RATE_PER_MINUTE`（默认 120）次，超了 `429 rate_limited` + `Retry-After`。
- **不能自己续命**：三个管理接口只认网页登录会话，用令牌调用返回 `403`；令牌也不能拿来创建新令牌。
- **`last_used_at`**：每次调用更新，最多每 60 秒写一次库，列表里显示「最后使用」。
- **错误**：无效 / 已撤销 / 已过期统一 `401 unauthorized`，文案不区分原因（避免探测令牌是否存在）；参数问题 `422 validation_failed`；最多同时保留 20 个未撤销令牌，超出 `409 conflict`。

### 2.22 接入：入站 MCP（B · `modules/mcp`）

让外部 agent（dots、Cursor、Claude 这类支持 MCP 的客户端）用**同一张 API 令牌**直接接进来。默认关闭（`MCP_ENABLED=false`，且需要 `API_TOKENS_ENABLED=true`）。

**与「出站 MCP」的区别**：`gh`/harness 里的 `mcp_servers`（§2.13）是我们去连**别人的** MCP 服务器；这一节是别人来接**我们**。

| 方法   | 路径   | 权限                    | 说明                                                                            |
| ------ | ------ | ----------------------- | ------------------------------------------------------------------------------- |
| POST   | `/mcp` | `Authorization: Bearer` | JSON-RPC（`initialize` / `tools/list` / `tools/call`），返回 `application/json` |
| GET    | `/mcp` | 同上                    | 不开 SSE，按规范返回 `405`                                                      |
| DELETE | `/mcp` | 同上                    | 不管理会话，返回 `405`                                                          |

- **只认 Bearer，不认 Cookie**：MCP 是机器入口，浏览器登录态在这里不被顺带使用（缩小 CSRF 面）。身份链与 REST 完全同一套：未撤销 → 未过期 → 每令牌每分钟限流 → 记 `last_used_at`。
- **每次请求校验 `Origin`**（规范 MUST，防 DNS rebinding），规则与 `/ws`、`/collab` 相同；命令行客户端不带 `Origin` 时放行。
- **无会话**：不签发 `Mcp-Session-Id`（stateless），每个请求独立，避免多一层状态被人拿来串号。
- **`401` 一律带 `WWW-Authenticate: Bearer realm="srh"`**（令牌坏了再加 `error="invalid_token"`），符合 MCP 规范；`MCP_ENABLED=false` 时返回 `403`。
- **工具白名单**（`tools/list` 就按令牌 `scopes` 裁剪，只读令牌**看不到**写工具）：

  | 工具              | 需要    | 作用                                                      |
  | ----------------- | ------- | --------------------------------------------------------- |
  | `list_projects`   | `read`  | 我参与的项目（已按 `projectIds` 过滤）                    |
  | `get_project`     | `read`  | 项目概况、成员、文档清单、最近线程（拿 docId / threadId） |
  | `get_timeline`    | `read`  | 时间线顶层消息（游标分页）                                |
  | `get_thread`      | `read`  | 线程详情 + 消息（个人线程只有主人能读）                   |
  | `read_document`   | `read`  | 文档正文的 markdown 表示（只读，超 2 万字截断并注明）     |
  | `list_inbox`      | `read`  | 我的待办收件箱（按优先级排序）                            |
  | `post_message`    | `write` | 以本人身份发消息（时间线或线程）                          |
  | `create_todo`     | `write` | 建待办（默认共享，不是个人待办）                          |
  | `mark_inbox_done` | `write` | 标记收件箱条目已处理                                      |

- **越权防线**：工具内部一律走既有 service / 成员校验——限项目令牌范围外一律「不存在」（`404` 语义），访客不能写，别人的个人线程与收件箱拿不到。**没有**「改项目设置 / 改成员 / 删项目 / 改文档正文」这类工具。
- **「来自令牌」标记**：`post_message` 发的消息会在 `meta.viaToken = { id, name, hint }` 留痕，界面上显示「来自令牌「名字」」，出事能认出来、能按时间清理。
- **每日写上限**：每张令牌每天 `MCP_WRITE_PER_DAY`（默认 200）次写操作（发消息 / 建待办 / 标完成），超了返回工具级错误（含中文提示），读操作不占额度。计数在进程内存，重启归零。
- **审计**：每次工具调用打一条结构化日志（令牌 id、用户 id、工具名、耗时、成败），便于排查。
- **工具级错误**：权限 / 参数 / 限流问题一律返回 `isError` 的工具结果（一句中文），不返回 500。

## 3. 实时通道

### 3.1 `/ws` 应用事件

连接：`new WebSocket((location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/ws')`，浏览器自动带 Cookie。

```
客户端                                   服务端
  │  ── (握手，Cookie 鉴权) ──────────────▶ │
  │  ◀───────────── {op:'ready', userId, serverTime}
  │  {op:'subscribe', projectId, afterSeq, replay?} ▶│  afterSeq=本地已处理的最大 seq；首次用 me 的 eventSeq + replay:true
  │  ◀── {op:'event', event} × N          │  补发 seq > afterSeq（≤1000 条）
  │  ◀── {op:'resync', projectId, latestSeq}│  缺口 > 1000：改为 REST 整体重拉
  │  ◀── {op:'subscribed', projectId, latestSeq}
  │  ◀── {op:'presence', projectId, members}
  │  ◀── {op:'event', event}              │  之后实时推送
  │  ◀── {op:'ephemeral', projectId, type:'agent.delta', payload}
  │  {op:'presence', projectId, view, objectId, activity} ▶  切页面/开始输入/编辑时发
  │  {op:'ping'} ▶ 每 25s     ◀ {op:'pong'}
  │  {op:'unsubscribe', projectId} ▶
```

- seq 为项目内连续序号，服务端保证同一项目按 seq 递增推送；客户端按 `event.seq` 去重并记录最大值，收到 `subscribed` 时取 `max(本地, latestSeq)`；断线指数退避重连（上限 10s），重连后用最大 seq 重新 `subscribe`。
- **补发下界**：`subscribe` 可带 `replay: true`，表示 `afterSeq` 是客户端数据的下界，即使为 0 也补发 `seq > afterSeq` 的事件（缺口 > 1000 同样发 `resync`）；不带时 `afterSeq=0` 只推订阅之后的实时事件。前端首次进入项目时用 `/auth/me` 里该项目的 `eventSeq` 当下界（项目页的 REST 数据都在 me 返回之后才拉），所以 REST 返回到订阅建立之间的事件不会丢；离开项目再回来时，从上次处理到的 seq 补发（取两者较小值）。补发里可能有 REST 已包含的事件，前端按 id 整体替换，重复应用无副作用。
- 关闭码：`4401` 未登录、`4403` 无权限、`4501` 未实现、`4503` 服务关闭。
- 错误帧：`{op:'error', code, message}`（如 `bad_frame`、`forbidden`）。

### 3.2 `/collab/:documentId` 协同文档

Hocuspocus（Yjs）协议。前端 `@hocuspocus/provider`：`url = ws(s)://<host>/collab/<documentId>`，`name = documentId`，`token` 随便填（协议要求有，鉴权实际走 Cookie）。实现：`apps/server/src/realtime/collab.ts`（存储由 documents 模块注入）；前端 `features/docs/collab/useCollabDoc.ts`。Y.Doc 结构见 §2.7.1。

- **握手鉴权**（交给 Hocuspocus 之前，期间到达的消息先排队）：`Origin` 不是 `PUBLIC_URL` 也不与 Host 同源 → 关闭码 `4403`；未登录 → `4401`；文档不存在或用户不是其所属项目的成员 → `4404`；内部错误 → `1011`。一条连接只能打开 URL 里那篇文档。
- **权限**：访客（guest）连接、已归档文档的连接只读（`readOnly`，写入被丢弃）；owner / advisor / member 可写。读写权限在握手时决定，所以权限变化时服务端主动断开相关连接（关闭事件 `4205 Reset Connection`），客户端重连时按新状态重新鉴权：文档归档 / 恢复 → 断开该文档全部连接；成员被移出（`member.removed`）或角色变化（`member.updated`）→ 断开该用户在这个项目里的全部连接（被移出的重连得到 `4404`，降为访客的重连只读）。
- **前端**：收到 `4401` / `4403` / `4404` 时 `useCollabDoc` 调 `provider.disconnect()` 停止自动重连，状态停在 `denied`，之后的 `status` 事件不再覆盖；`4403` / `4404` 同时删除这篇文档的本机缓存（`4401` 登录过期保留，重新登录后补发）。
- **本机缓存与离线**（`features/docs/collab/localCache.ts`、`syncState.ts`）：每篇文档的 Y.Doc 用 y-indexeddb 存在浏览器 IndexedDB（库名 `srh-doc:<userId>:<docId>`），断网时的修改在刷新 / 关闭后仍在，重新连上后由 Yjs 补发合并。同步徽标看浏览器 `online` / `offline` 事件、连接状态和 `provider.unsyncedChanges`：离线 / 正在重连 / 有未同步的修改（修改 1.5s 未被服务端确认）/ 已同步；连着但 6s 没有确认时视为连接失效，主动断开重连。还有未确认的修改时，离开页面弹出浏览器的确认提示。
- **REALTIME_DEV_ANON**：匿名身份（`usr_anonymous`）只用于 `/ws` 调试；`/collab` 握手返回 `4401`，协作模块的 REST 返回 `401`，不再被当成项目负责人。
- **落库**：`onLoadDocument` 读 `documents.ydoc_state`；`onStoreDocument` 防抖 2s、最长 10s，内容哈希没变就跳过；写回 `ydoc_state`、`content_text`（§2.7.2 的 markdown）、`updatedBy`（触发保存的连接用户），并发 `document.updated`。服务关闭时先断开连接、冲刷待保存的文档。文档被删除时服务端断开它的全部连接。
- **agent / REST 编辑**（`POST …/edit`、版本恢复、agent `applyEdit`）：在服务端的同一个 Y.Doc 上开一次 Yjs 事务（没人在线时临时从库里加载），在线编辑者实时看到、与人的编辑按 CRDT 合并；事务结束立即落库并发 `document.updated`。actor 是 agent 时，服务端 awareness 写入 `user: { id: 'agent:<actor.id>', name: '<代表成员>的 agent'（会话没有代表成员时用 actor.name）, color: '#7c5cfa', colorIndex: 0, kind: 'agent' }` 与 `cursor: { anchor, head }`（本次写入的最后一个字之后，Y.RelativePosition JSON，y-prosemirror / y-codemirror 可直接画光标），最后一次写入后停留 6s 再清除；前端据此在成员头像里显示 agent、在正文里显示它的光标，文档页顶部显示“某某的 agent 正在编辑这篇文档”。文档页同时列出落在这篇文档上的有效认领（`doc_xxx` / `doc_xxx#章节`，显示为可读的章节名）。
- **awareness 字段**：`user: { id, name, color: '#rrggbb', colorIndex, kind: 'user' | 'agent' }`（color 是色板 --palette-n 的十六进制值，y-prosemirror / y-codemirror 只认这种格式；界面按 colorIndex / kind 取 CSS 变量）；`cursor` / `selection` 由 y-prosemirror（doc）、y-codemirror（latex）绑定写入；表格写 `sheet: <表 id>`（正在看的工作表）、`cell: '行id:列id'`（活动格）、`range: ['行id:列id', '行id:列id'] | null`（多选时选区的两个角；用行列 id，别人插删行列后仍指向同一格；旧客户端写的 `'r:c'` 下标也能显示，缺 `sheet` 视为第一张表），幻灯片写 `slide: <slideId>`（正在看 / 编辑的页）与 `sel: string[] | null`（这一页上选中的元素 id，别人看到带名字的彩色框），文本框里的光标是 y-prosemirror 写的 `cursor`（相对位置落在哪个文本框的 Y.XmlFragment 里就画在哪个文本框）。同一用户开多个标签页时前端只显示一次。

## 4. 项目事件表

事件形状 `ProjectEvent { seq, projectId, threadId, type, payload, actor, createdAt }`；payload 为变更后的完整对象，删除类只带 `{ id }`。

| 事件                                                               | payload                                                               | 发布者                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| `project.updated`                                                  | `Project`                                                             | projects                                       |
| `member.joined` / `member.updated`                                 | `ProjectMember`                                                       | projects                                       |
| `member.removed`                                                   | `{ userId }`                                                          | projects                                       |
| `message.created` / `message.updated`                              | `Message`                                                             | timeline、threads、agent 工具                  |
| `message.deleted`                                                  | `{ id }`                                                              | timeline                                       |
| `thread.deleted`（个人会话被主人删除，只推给主人）                 | `{ id }`                                                              | threads                                        |
| `thread.created` / `thread.updated`                                | `Thread`（标题、状态清单、分栏、resolved 变化都发 updated）           | threads、agent 运行时                          |
| `decision.created` / `decision.updated`                            | `Decision`                                                            | threads、agent 工具                            |
| `agent.updated`                                                    | `AgentSession`（状态、activity 变化）                                 | agent 运行时                                   |
| `agent.step`                                                       | `AgentStep`                                                           | agent 运行时                                   |
| `memory.updated`                                                   | `MemoryFile`                                                          | memory                                         |
| `memory.deleted`                                                   | `{ path }`                                                            | memory                                         |
| `claim.created` / `claim.updated`                                  | `WorkClaim`                                                           | claims                                         |
| `claim.conflict`                                                   | `{ claim, conflictsWith: WorkClaim[] }`                               | claims                                         |
| `routine.created` / `routine.updated` / `routine.deleted`          | `Routine` / `{ id }`                                                  | routines                                       |
| `file.created` / `file.updated` / `file.deleted`                   | `FileObject` / `{ id }`                                               | files、agent 工具                              |
| `inbox.created` / `inbox.updated`                                  | `InboxItem`（只推给对应用户）                                         | inbox；协作模块（指派、审阅）                  |
| `document.created` / `document.updated`                            | `DocumentMeta`                                                        | documents、collab、reports                     |
| `document.deleted`                                                 | `{ id }`                                                              | documents                                      |
| `document.version_created`                                         | `DocumentVersion`                                                     | documents                                      |
| `document.comment_created` / `document.comment_updated`            | `DocComment`                                                          | documents（行内评论）                          |
| `document.comment_deleted`                                         | `{ id, documentId }`                                                  | documents                                      |
| `board.created` / `board.updated` / `board.deleted`                | `Board` / `{ id }`                                                    | boards                                         |
| `column.created` / `column.updated` / `column.deleted`             | `BoardColumn` / `{ id }`                                              | boards                                         |
| `card.created` / `card.updated` / `card.deleted`                   | `Card` / `{ id }`                                                     | boards                                         |
| `todo.created` / `todo.updated` / `todo.deleted`                   | `Todo` / `{ id }`                                                     | todos                                          |
| `experiment.created` / `experiment.updated` / `experiment.deleted` | `Experiment` / `{ id }`                                               | experiments                                    |
| `experiment.log_created`                                           | `ExperimentLog`                                                       | experiments                                    |
| `review.created` / `review.updated`                                | `Review`                                                              | reviews                                        |
| `review.comment_created` / `review.comment_updated`                | `ReviewComment`                                                       | reviews                                        |
| `report.created` / `report.updated` / `report.deleted`             | `Report` / `{ id }`                                                   | reports                                        |
| `provider.updated` / `provider.deleted`                            | `LlmProvider` / `{ id }`                                              | harness（只发项目级）                          |
| `mcp.updated` / `mcp.deleted`                                      | `McpServer` / `{ id }`                                                | harness（只发项目级）                          |
| `skill.updated` / `skill.deleted`                                  | `Skill` / `{ id }`                                                    | harness（只发项目级）                          |
| `command.updated` / `command.deleted`                              | `SlashCommand` / `{ id }`                                             | harness（只发项目级）                          |
| `profile.updated` / `profile.deleted`                              | `AgentProfile` / `{ id }`                                             | harness（只发项目级）                          |
| `paper.created` / `paper.updated` / `paper.deleted`                | `Paper` / `{ id }`                                                    | library（§2.15）                               |
| `share.updated`                                                    | `{ resourceKind, resourceId, reason: 'link' \| 'grants' \| 'space' }` | sharing（§2.19）；客户端收到后重新拉列表和详情 |
| `version.created`                                                  | `Version`                                                             | versioning（§2.18）                            |
| `proposal.created` / `proposal.updated`                            | `ChangeProposal`（threadId = agent 所在线程）                         | versioning                                     |
| `versioning.settings_updated`                                      | `VersioningSettings`                                                  | versioning                                     |
| `plan.created` / `plan.updated`                                    | `Plan`                                                                | plans（§2.20）                                 |
| `plan.version_created`                                             | `PlanVersion`                                                         | plans                                          |
| `basis_proposal.created` / `basis_proposal.updated`                | `BasisProposal`                                                       | plans                                          |
| `basis_proposal.deleted`                                           | `{ id }`                                                              | plans                                          |
| `team_basis.created` / `team_basis.updated`                        | `TeamBasis`（采纳、替代、待复核、复核都发 updated）                   | plans                                          |

协作事件的 `threadId`（路由器据此唤醒线程 agent）：`card.*` / `todo.*` 见 §2.8 指派约定；`experiment.*` = 实验的 `threadId`；`review.*` = 发起审阅的线程；`document.*`、`board.*`、`column.*`、`report.*` 恒为 `null`。`report.updated` 由后台生成写回时 actor 为系统（`{ kind: 'system', id: null, name: '研协' }`）；`/collab` 自动保存的 `document.updated` actor 为触发保存的连接用户。

瞬时事件（不落库、无 seq）：`agent.delta { sessionId, threadId, turnId, delta }`。

**可见性过滤**（后端线程实现 `apps/server/src/realtime/access.ts` 的 `canSeeEvent`，`/ws` 推送前逐条调用）：个人线程相关事件只推给主人；`inbox.*` 只推给对应用户；`agent_visible=false` 的消息照常推给人。

## 5. 在代码里怎么用

服务端（模块内）：

```ts
import { MessageCreateInput, newId } from '@srh/shared';
import { parse } from '../../lib/http';

app.post('/projects/:projectId/timeline', async (req, reply) => {
  const input = parse(MessageCreateInput, req.body);
  const { db, bus } = app.ctx;
  // …写 messages 表（id: newId('message')）…
  await bus.publish({
    projectId,
    threadId: null,
    type: 'message.created',
    payload: message,
    actor,
  });
  return reply.status(201).send(message);
});
```

前端：

```ts
import type { Message, Page } from '@srh/shared';
import { api } from '@/lib/api';

const page = await api.get<Page<Message>>(`/projects/${projectId}/timeline`);
realtime.subscribe(projectId, lastSeq);
realtime.on('event', ({ event }) => { if (event.type === 'message.created') … });
```

## 6. 后端实现细节（前端需要知道的）

查询参数与组合类型都在 `@srh/shared`：`MessageListQuery`、`ThreadListQuery`、`ClaimListQuery`、`AgentStepsQuery`、`OutputListQuery`、`InboxQuery`、`InboxUpdateInput`、`EventsQuery`、`FileListQuery`、`ClaimRenewInput`；`ProjectWithRole`、`MeResponse`、`OutputItem`、`DecisionMessageMeta`、`ForwardMessageMeta`。

- **登录**：`POST /auth/register` 返回 201；Cookie `srh_session` 有效期 30 天。`GET /auth/me` → `MeResponse`，每个项目条目带 `role`、`unread` 和 `eventSeq`（读取时该项目最新的事件 seq，前端订阅 `/ws` 时当补发下界，见 §3.1）。邮箱先去掉首尾空格和零宽字符再校验，不分大小写；姓名 1–40 字，任何文字都可以；注册密码至少 8 位，且不能全是数字或同一个字符（422，每个字段给出中文原因；规则文案 `PASSWORD_RULE_HINT` 与检查函数 `passwordProblem` 在 `@srh/shared`，前端提交前用同一份检查）。
- **限流**：按「规范化邮箱 + IP」计，15 分钟内登录失败 5 次后，这个邮箱从这个 IP 再登录（即使密码正确）→ `429 rate_limited`（同一 NAT 后的其他人、别的 IP 上的同一账号不受影响）；另有防撒网上限：同一 IP（所有邮箱合计）15 分钟内失败 100 次 → 该 IP 全部 429。中文提示写明要等多久（“登录尝试过多，请 3 分钟后再试”，不到 1 分钟按秒），`details.retryAfterSec`（同值的 `details.retryAfter`）与 `Retry-After` 头给出秒数；登录成功清零该邮箱 + IP 的计数。同一 IP 每小时最多注册 50 次，超出同样 429（“注册太频繁，请 N 分钟后再试”）。计数在进程内存里，重启清零。
- **找回密码**：`POST /auth/password/request-reset { email }` 一律回 `202 { ok: true }`（邮箱未注册也一样，不暴露账号是否存在），邮件在后台发送；链接是 `${PUBLIC_URL}/reset-password?token=…`（前端路由 `/reset-password`、入口 `/forgot-password`）。令牌 32 字节随机，库里只存 SHA-256 与用户 id，30 分钟有效、一次性；同一用户再次申请会作废之前的令牌。限流：同一规范化邮箱 15 分钟 3 次（未注册邮箱同样计数）、同一 IP 15 分钟 20 次，超出 `429 rate_limited`「重置请求太频繁，请 N 分钟后再试」并带 `Retry-After`。`POST /auth/password/reset { token, password }`：密码规则与注册相同（422）；令牌无效、过期或已用 → `400 bad_request`「重置链接无效或已过期」；成功后删除令牌和该用户全部会话（含当前浏览器，清除 Cookie），需要用新密码重新登录。发信配置见 `deploy/README.md`「邮件（找回密码）」。
- **来源校验（CSRF）**：所有写请求（非 GET / HEAD / OPTIONS，含登录、注册、登出）带了 `Origin` 时，必须是 `PUBLIC_URL` 的源或与请求 Host 同源，否则 `403 forbidden`「请求来源不被允许」；没有 `Origin` 但 `Sec-Fetch-Site: cross-site` 也 403。两者都没有（服务端调用、命令行）放行。
- **删除项目** = 归档：之后对成员 404，`/ws` 订阅被拒。advisor 不能改或移除 owner；最后一位 owner 不能降级或离开（409）。成员可以 `DELETE P/members/:自己` 退出。
- **邀请**：`POST P/invites` 返回含 `token` 的 `Invite`，链接由前端拼；带 `email` 的邀请只能被该邮箱接受、用一次；7 天过期。owner / advisor 可以 `DELETE P/invites/:inviteId` 撤销（204，不是本项目的邀请 404），撤销后链接 404「邀请链接无效」。邀请创建之后被移出（或自己退出）项目的人，不能再用这个旧链接回来 → 403「你已被移出这个项目，请向管理员要新的邀请链接」；移出之后新建的邀请可以用。
- **时间线 / 线程消息**：游标是消息 id（`nextCursor`），`?order=asc` 时游标向新方向翻。`agentVisible=false` 即旁聊，任何 agent 都收不到。正文里 `@成员名` 会给该成员生成 `mention` 收件箱项（个人会话除外）。`fileIds` 先用 `POST P/files` 上传拿 id，消息上会出现 `outputs`（kind=file）并进资料库。有线程的根消息不能删（409）。
- **线程卡片**：根消息的 `rootOfThreadId` 在线程创建时随 `message.updated` 推送；线程的 `statusBucket` 由服务端计算（working / blocked（有未答决策卡或未结束的审阅）/ review_ready（最后一条是 agent 的交付消息；个人会话不算，agent 最后一句是问成员的问题时算 blocked）/ idle / completed / failed），`statusText` 是 agent 的进度清单原文。成员在已解决的线程里发言会自动重开。
- **个人工作区**：`POST P/threads { body, title? }` 新建会话并唤醒个人 agent，`body` 作为第一条消息（在线程里，不上时间线）；`GET P/threads?kind=personal` 只返回自己的；别人的个人会话一律 404，相关事件不推给别人。删除 `DELETE P/threads/:id` 只对自己的个人会话（204；agent 正在回复 409；项目线程 403，只能归档=解决），发 `thread.deleted { id }`（只推给主人）。转发 `POST P/threads/:id/forward { note }` → 时间线上 `kind=forward` 的消息，`meta: ForwardMessageMeta`，线程 `forwardedAt` 随 `thread.updated` 更新。
- **决策卡**：`kind=decision` 的消息，`meta.decision` 是完整 `Decision`；`POST P/decisions/:id/answer { chosen }`，已回答再答 → 409（`details.current`），并发回答时只有一个成功（原子更新）。同时推 `decision.updated` 和 `message.updated`。
- **agent 透明度**：`GET P/agents` 含协调者、各线程 agent，以及**自己的**个人 agent；`activity` 取自进度清单里 ✱ 那一行。`steps` 默认 `order=asc`，可 `?turnId=` 过滤；`kind=note,name=wake` 的步骤是这一轮 agent 收到的输入。流式文字走 `agent.delta { sessionId, threadId, turnId, delta }`，每轮结束后的完整文字在 `agent.step(kind=text)`。`POST P/agents/:id/stop` 中止当前 turn 并丢弃排队的唤醒（agent 还显示空闲、但成员刚发的消息已经排上队时也能停），有东西可停时状态变 `stopped`；返回的 `stopped` 说明停掉了什么：`turn` = 在跑的一轮，`queued` = 排队中的一轮，`none` = 本来就没事（状态不变）。
- **agent 停工要如实可见**：一轮最多 24 步；用满还没结束会自动续跑（最多 2 次，每次在 steps 里记一条 `kind=note,name=round_limit`）。续跑也用满时会话停下（`status=idle`，不算失败；线程 agent 每 8 步还会收到一条带任务目标的提醒，`name=goal_reminder`）；出错（`name=error`）时会话 `status=failed`（随 `agent.updated` 推送）、线程 `statusBucket=failed`。两种情况都在线程（协调者则在时间线）里发一条作者为系统的消息，`meta.agentStopped = { sessionId }`，前端可据此显示「继续」按钮。`POST P/agents/:id/resume`（write 权限；访客 403；线程已解决 409）把会话置为 `queued` 并给它一条“成员让你继续”的唤醒；成员在线程里发言同样会唤醒它。`tokenUsage` 每次模型调用后就更新并推 `agent.updated`，不再等一轮结束。
- **agent 的认领**：一轮结束（做完、出错或被中止）时运行时放开该线程全部认领，不会残留到 TTL 过期；自动续跑时续期。认领放开或过期时，24 小时内撞上过它、没认领成功的 agent 会被唤醒去并入草稿。
- **agent 的隐私边界**：旁聊（`agentVisible=false`）不进任何 agent 的读工具、搜索和唤醒信封；协调者读不到个人会话（转发后也一样），只看转发卡片里的附言和摘要（摘要只取 agent 可见的消息）。
- **记忆**：`PUT P/memory` 只有 owner / advisor（成员 403）；`MEMORY.md` 不能删。版本冲突 409 `version_conflict`，`details.current` 是最新文件。
- **认领**：成员也可以手动认领（`onBehalfOfUserId` = 自己）。冲突 409 `claim_conflict`，`details.claims` 为冲突认领，同时推 `claim.conflict` 并给双方发起人生成 `conflict` 收件箱项（`sourceId` = 对方认领 id，`href` 指向对方线程）。持有人、代表的成员、owner / advisor 可续期和释放。
- **定时任务**：`schedule` 支持 5 段 cron（按 Asia/Shanghai 解释）、`every:<毫秒>`（≥ 60000）、`at:<ISO 时间>`；`nextRunAt` 由服务端算。`POST …/run` 返回 202 `{ accepted: true }`。
- **文件**：上传字段名 `file`，可选 `path`（不传则存为 `uploads/<原文件名>`，重名自动加 ` (1)`；传了同名路径则覆盖并推 `file.updated`）。单文件 ≤ 20 MB。路径不分大小写：与已有文件只差大小写时视为同一个文件，原地覆盖并沿用原路径（默认路径的 ` (1)` 后缀也按不分大小写判断）。路径里含 `<>:"|?*` 或控制字符、某段以点或空格结尾、或是 Windows 保留名（CON、PRN、AUX、NUL、COM1–9、LPT1–9，带不带扩展名都算）→ 400；不传 `path` 时这些字符会在文件名里换成 `_`。`GET P/files/:id?download=1` 以附件下载；不带时只有白名单类型内联打开：png / jpeg / gif / webp、pdf，以及 text/plain、text/markdown、text/csv（以 `text/plain; charset=utf-8` 返回），其他一律按附件返回。文件内容响应都带 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`（内联 PDF 除外，否则 Chrome 无法显示）。
- **资料库**：`GET P/outputs` → `Page<OutputItem>`，按时间新到旧；同一对象（kind+ref）只出现一次。
- **收件箱**：`GET /inbox?done=false` 只返回仍是成员的项目里的条目，按优先级再按时间排序；`PATCH /inbox/:id { read?, done? }`。决策卡被回答后对应条目自动 done。
- **事件补拉**：`GET P/events?afterSeq=&limit=` 与 `/ws` 使用同一可见性过滤（个人线程事件只给主人、`inbox.*` 只给本人、个人待办只给主人）。被移出项目的成员立刻收不到该项目的任何事件。
- **本地调试**：`REALTIME_DEV_ANON=true`（仅非生产）时，只有没有 Cookie 的 `/ws` 握手以匿名访客放行；匿名访客看不到个人线程、个人待办和收件箱事件。REST 与 `/collab` 不受这个开关影响，未登录一律 401。带了有效 Cookie 的连接照常按成员身份过滤。
- **消息频道分页**：`GET P/timeline` 和 `GET P/threads/:threadId/messages` 的 `MessageListQuery` 可带 `channel=all|agent|team`，默认 `all`；`agent` 仅返回 `agentVisible=true`，`team` 仅返回 `agentVisible=false`。先筛频道再按 `order`、`cursor`、`limit` 分页；权限与原接口相同，无效频道返回 422。
- **个人会话首轮设置**：`POST P/threads` 可同时传 `model`、`effort`、`profile`（字段校验与 `SessionSettingsInput` 一致）。模型须是本项目启用的完整模型 id；显式选择的强度优先于 profile 建议强度，之后使用系统默认强度，并按模型支持的档位适配。`null` 模型回到项目默认，`null` 强度保留 profile / 默认回退。配置无效返回 422，且不创建线程；设置在首轮唤醒前写入会话。

# 通用科研工作流（追加契约）

`P=/api/v1/projects/:projectId`。方法 `general/computational/experimental/observational/qualitative/literature/theoretical`，中文标签见 `RESEARCH_METHOD_LABEL`。所有列表均为 `{items,nextCursor}`，支持 `cursor/limit`。创建类支持 `Idempotency-Key` 或 JSON `idempotencyKey`（项目、操作者、动作内生效）；同键不同内容返回 `409 conflict`。更新带 `baseVersion`，过期返回 `409 version_conflict`。科研对象只在所属项目可见；访客可读不可写。

| 方法        | 路径                                                             | 请求与响应                                                                                                                                             |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET / POST  | `P/research/templates`                                           | `Page<ResearchTemplate>` / `ResearchTemplatePublishInput` → 201；预置模板全局只读，项目模板只追加发布版本                                              |
| GET         | `P/research/templates/:templateId/versions/:version`             | 固定发布版本 `ResearchTemplate`                                                                                                                        |
| GET         | `P/research`                                                     | `Page<ResearchListItem>`：新研究记录与旧实验统一列表；旧实验 method 为 null，详情仍走旧 `/experiments/:id`                                             |
| GET         | `P/research/search?q=关键词`                                     | `Page<{kind,id,projectId,recordId,title,snippet,href}>`；q 为 1–200 字符，检索记录问题、来源书目及结论；href 对应前端页面                              |
| GET / POST  | `P/research/records`                                             | `Page<ResearchRecord>`（可按 method/status 过滤） / `ResearchRecordCreateInput` → 201                                                                  |
| GET / PATCH | `P/research/records/:recordId`                                   | `ResearchRecordDetail {record,template,logs,sources}` / `ResearchRecordUpdateInput` → `ResearchRecord`；显式 `migrateTemplateVersion` 保留旧字段与修订 |
| GET         | `P/research/records/:recordId/revisions`                         | `Page<ResearchRecordRevision>`；完整旧版本不可变                                                                                                       |
| GET / POST  | `P/research/records/:recordId/logs`                              | `Page<ResearchLog>` / `ResearchLogCreateInput` → 201，日志追加不可改                                                                                   |
| GET / POST  | `P/research/sources`                                             | `Page<ResearchSource>`（`?recordId` 过滤关联） / `ResearchSourceCreateInput` → 201；项目级共享来源由 record.sourceIds 关联                             |
| GET / POST  | `P/research/records/:recordId/sources`                           | `Page<ResearchSource>` / 同上 → 201，创建时自动关联记录                                                                                                |
| PATCH       | `P/research/sources/:sourceId`                                   | `ResearchSourceUpdateInput` → `ResearchSource`；更新/归档触发相关发现待复核                                                                            |
| GET         | `P/research/sources/:sourceId/availability`                      | 原件可用性、缺失原因及 Notebook 所属实验；原件删除后保留来源与历史快照                                                                                 |
| GET / POST  | `P/research/sources/:sourceId/snapshots`                         | `Page<ResearchSnapshot>` / `ResearchSnapshotCreateInput` → 201                                                                                         |
| GET         | `P/research/snapshots/:snapshotId`                               | 固定快照元数据，含创建时的 `sourceVersion/sourceMetadata`                                                                                              |
| GET         | `P/research/snapshots/:snapshotId/download`                      | 授权下载原始快照字节；路径由服务端确定，删除原资源不影响历史快照                                                                                       |
| GET / POST  | `P/research/records/:recordId/excerpts`                          | `Page<EvidenceExcerpt>` / `EvidenceExcerptCreateInput` → 201                                                                                           |
| GET / POST  | `P/research/records/:recordId/codes`                             | `Page<ResearchCode>` / `ResearchCodeCreateInput` → 201                                                                                                 |
| PATCH       | `P/research/codes/:codeId`                                       | `ResearchCodeUpdateInput` → `ResearchCode`                                                                                                             |
| GET / POST  | `P/research/records/:recordId/codings`                           | `Page<ResearchCoding>`（`?caseId` 按对象筛选） / `ResearchCodingCreateInput` → 201                                                                     |
| GET / POST  | `P/research/records/:recordId/findings`                          | `Page<ResearchFinding>` / `ResearchFindingCreateInput` → 201                                                                                           |
| GET / PATCH | `P/research/findings/:findingId`                                 | `ResearchFinding` / `ResearchFindingUpdateInput` → `ResearchFinding`；仅用户可 `resolveReview:true` 清待复核，AI 不能设置 `humanConfirmed`             |
| GET         | `P/research/records/:recordId/export?format=json\|markdown\|csv` | 完整 provenance；CSV 防公式注入                                                                                                                        |

来源可指向同项目文件、团队空间文档或论文、Notebook，或手工书目、URL；`originalSourceId` 连接转写/导入结果与原件。科研记录、来源和快照在项目内共享，因此个人空间文档或论文即使由操作者本人创建或分享给操作者，也不能关联到研究记录的 `resources`（含模板 resource 字段）、创建或更新为来源、或生成新快照；须先将原件转到团队空间，服务端返回 422 与中文提示。团队原件转入个人空间后，来源 `availability` 返回 `available:false,reason:missing`，不再读取新原件或生成任何覆盖类型的新快照；已创建的不可变快照及其下载仍保留当时团队共享的历史证据。快照 `coverage=complete/excerpt/external`，`complete` 仅保存本地原件完整字节，文件超过 5 MB 仍从实际文件复制；`external` 只保留链接，绝不宣称完整。`sha256` 是保存字节的摘要，`sourceVersion/sourceMetadata` 固定创建时的书目与原件关联信息，后续编辑不会改写旧证据。摘录固定快照、原文、定位与来源类型；只有服务端能核对完整快照的文本段落原文才标 `verified`，PDF 页、表格范围、摘录快照均为 `unverified`。AI 摘录只可标 `ai_extraction/tool_result`；发现区分支持、反例、背景摘录与局限。步骤勾选保留报告人、来源与 `unverified` 状态，不代表独立核验。审阅 `research_record/research_finding` 的快照写入修订号，旧审阅仍读原快照。`Project` 的 `researchDomains/preferredResearchMethods` 为可选设置，默认空列表，不影响会话模型、effort、profile。

研究写入事件（项目内连续 seq、业务写与事件同事务）：`research.template.published`、`research.record.created/updated`、`research.log.created`、`research.source.created/updated`、`research.snapshot.created`、`research.excerpt.created`、`research.code.created/updated`、`research.coding.created`、`research.finding.created/updated`。agent 工具固定 `research_list/read/create/update/log/snapshot/excerpt/code/finding/export`；写工具共享服务层、项目范围及认领守卫，`research_create` 以 `kind=record/source` 判别。

## 7. 自由研究工作空间与局部执行（2026-10-28）

本节追加研究空间能力，旧研究记录、模板、来源、摘录、编码、发现及实验端点保持兼容。以下 `R = /api/v1/projects/:projectId/research`，`W = R/records/:recordId`。

| 方法           | 路径                                     | 输入 / 输出                                                                            |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| POST           | `R/workspaces`                           | `ResearchWorkspaceCreateInput` → `ResearchRecord`，名称和问题可选，内部采用通用配置    |
| GET            | `W/workspace`                            | `ResearchWorkspace`，含记录及已分页的条目摘要、普通关系                                |
| GET / POST     | `W/items`                                | `PageQuery` → `Page<ResearchItemSummary>` / `ResearchItemCreateInput` → `ResearchItem` |
| GET            | `R/items/:itemId`                        | 返回同项目条目，用于稳定产出链接定位                                                   |
| GET / PATCH    | `W/items/:itemId`                        | `ResearchItem` / `ResearchItemUpdateInput`（`baseVersion`）→ 更新条目                  |
| PATCH          | `W/items/:itemId/position`               | `ResearchItemPositionInput`（`basePositionVersion`）→ 条目；位置版本不覆盖正文版本     |
| DELETE         | `W/items/:itemId?baseVersion=N`          | 归档条目，返回 204；不会删除原资源                                                     |
| GET            | `W/items/:itemId/content?offset=&limit=` | `ResearchItemContent`，按需正文、读取版本、原资源入口和不可用原因                      |
| GET / POST     | `W/relations`                            | `Page<ResearchRelation>` / `ResearchRelationCreateInput` → 普通关系                    |
| PATCH / DELETE | `W/relations/:relationId`                | 更新标签带 `baseVersion`；归档时在 query 传 `baseVersion`                              |
| GET / POST     | `W/runs`                                 | 分页运行列表 / `ResearchRunCreateInput` → 新运行，创建必须带幂等键                     |
| GET            | `W/runs/:runId`                          | `ResearchRun`，冻结定义、输入、逐次尝试、实际产物及人工检查                            |
| GET            | `W/runs/:runId/staleness`                | 当前输入复核状态：未变化、已变化或不可用；不改写历史运行                               |
| POST           | `W/runs/:runId/cancel`                   | 请求停止；实际执行未停下前保持停止中                                                   |
| POST           | `W/runs/:runId/retry`                    | 保留成功尝试并重试失败或中断部分；输入变更需重新启动                                   |
| POST           | `W/runs/:runId/steps/:stepId/confirm`    | `ResearchRunConfirmInput` → 运行；仅成员可确认人工检查                                 |
| GET / POST     | `W/recipes`                              | 分页方案 / `ResearchRecipePublishInput` → 新的不可变版本                               |
| GET            | `W/recipes/:recipeId/versions/:version`  | 固定版本 `ResearchRecipe`                                                              |
| POST           | `W/recipes/:recipeId/instantiate`        | `ResearchRecipeInstantiateInput`，固定版本、替换输入及幂等键 → 新运行                  |

所有读写沿用项目权限、中文错误体、认领与事务事件。条目创建及关系创建支持幂等键；正文、位置和运行分别处理并发，过期版本返回 409，不静默覆盖。只能关联本项目可共享的资源，同项目来源可以由多项研究引用，不能用引用绕过个人空间权限。

`ResearchItem.origin` 记录选中文本的原条目、版本、字符位置及固定摘录。创建摘录同时建立标为“仅摘录”的来源快照和正式 `EvidenceExcerpt`，返回条目通过 `evidenceRef` 关联；后续可用于编码、支持依据及反例。文本位置不宣称是 PDF 页码，自动匹配不代表人工核验。

`ResearchRelation` 只表达普通研究关系。执行步骤通过 `dependsOn` 明确声明依赖，运行前检查输入、可用模型或内核及无环性；支持 AI、Notebook、人工检查，普通画线或资料变化不触发运行。运行固定模型、强度及 profile；Notebook 使用运行副本及冻结代码。输出保留作者、来源、正文、版本及摘要，AI 不能代签人工检查或把计划写成已执行结果。

新增事件：`research.item.created/updated/archived`（`ResearchItem`）、`research.relation.created/updated/archived`（`ResearchRelation`）、`research.recipe.published`（`ResearchRecipeNotice`）、`research.run.created/updated`（`ResearchRunNotice`）。运行与方案通知只传身份、状态及版本时间，冻结输入和产物按权限单独读取，避免在每次状态变化时广播大正文。事件使用既有 `/ws` 订阅，不逐步写入主讨论。

原 `W/export?format=json|markdown|csv` 三种格式均以附件下载返回（JSON 正文结构保持兼容），追加工作空间、固定版本及依据清单；JSON 保留完整布局、方案和运行。研究审阅追加正文和证据闭包快照；既有审阅不漂移。布局变化不改变正文摘要。`R/search` 追加 `kind=item`，其返回类型为新增的 `ResearchUnifiedSearchHit`；稳定条目链接 `/p/:projectId/research-items/:itemId` 解析后进入原研究的 `?item=:itemId` 聚焦视图。

### 研究空间入口兼容说明（2026-10-28）

正常创建使用 `POST R/workspaces`（AI 为 `research_workspace` 的 `workspace_create`）。模板管理与旧字段编辑退出产品界面；原模板、记录及修订 API 保留兼容，现有 ID、引用、审阅与导出不变。前端列表仅显示研究空间；旧实验可由实验模块或材料关联访问，原统一列表 API 仍保留实验适配项。旧 `/research-templates` 页面重定向到研究空间列表；旧详情的 `section` 参数在工作空间按需打开依据或只读历史。

### 可组合研究内容与布局（2026-10-28，追加）

`ResearchItemKind` 追加 `draft/table/figure`；可选 `payload` 分别保存混合素材块、表格元数据与图像配置，原 kind、ID 和调用保持兼容。`table` 创建输入可携带 `ResearchTableSeed`，实际单元格存现有协作工作簿。`ResearchAction` 追加 `operation`、具名 `inputs`、类型化 `outputs` 及 `transform/chart`；输入为具体 item（可限定草稿 blockIds）或上游 stepId/outputKey。旧 inputItemIds 继续有效。普通研究关系不承担执行语义。

| 方法  | 路径                               | 契约                                                                                                                                                                                           |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH | `W/layout`                         | `ResearchLayoutUpdateInput {moves:[{itemId,basePositionVersion,position}],idempotencyKey}` → `{items:ResearchItem[]}`，批量整体事务，重复 ID/非法坐标拒绝；409 的 details.current 返回当前条目 |
| GET   | `W/items/:itemId/table`            | `sheetId/cursor/limit` → `ResearchStructuredTable`，稳定行列 ID、完整指定数据及版本摘要，不经 Markdown 截断                                                                                    |
| GET   | `W/items/:itemId/artifacts`        | `PageQuery` → `Page<ResearchArtifactVersion>`；内容条目查询其版本，处理步骤查询其实际产物                                                                                                      |
| GET   | `R/artifacts/:artifactId`          | 固定版本元数据                                                                                                                                                                                 |
| GET   | `R/artifacts/:artifactId/download` | 固定内容或图像字节，按项目权限下载                                                                                                                                                             |

`ResearchRunOutput` 追加 `artifact/outputKey`，保留文本字段；真实文件／结构化内容的摘要独立保存。`ResearchRunConfirmInput` 追加可选 `itemIds`：只能确认本运行该人工步骤的上游候选内容，固定修改后的版本供下游使用，仅成员可操作。所有新读写沿用项目权限、认领、错误体及事务事件；未运行、未确认和已完成分别表达。

`inputs` 出现时（包括 `[]`）优先于旧 `inputItemIds`。上游输出绑定可追加 `artifactVersionId` 固定历史版本；未固定的输出在所选无环流程中使用本次上游成功产物，单步缺少可用上游时明确拒绝。默认旧行动输出槽为 `result/note`。摘要追加 `actionInputs/actionOutputs/producerStepId/producerOutputKey/previewImageFileId/runStatus`，供数据流展示与产物聚合；不要求读取全部正文。

下载 `?inline=1` 仅用于安全图像预览并设置内容安全策略；默认附件下载。大型原文和图像写入项目隔离文件存储，数据库保存索引、摘要与内容哈希。AI 工具 `research_workspace` 追加 `table`（结构化分页）、`artifacts`、`artifact_read`（固定版本、显式文本覆盖范围）及 `layout`（同批量事务）；写入仍要求认领，未增加 AI 人工确认能力。

`GET W/items/:itemId/table/export?sheetId=` 下载完整 CSV，包含稳定行列标识、单位与缺失值空格，转义电子表格公式注入。研究总导出包含表格 CSV 入口、结构化元数据和固定产物清单；固定图像及输入快照继续通过版本下载地址读取。内容条目的历史包含运行输入快照，处理步骤只展示已成功发布的输出。

## 8. 功能退役与聊天成员提及（2026-11-01）

本节取代前文关于实验、云电脑及课题常用研究方法的运行时约定。

- 实验、实验日志、云电脑 REST/WS 业务端点已移除，返回 404；对应 AI 工具不再注册。Notebook 继续独立提供原有接口，`experimentId` 兼容响应始终为 null；非空的实验关联创建／筛选返回 422。
- 课题创建／更新中的 `preferredResearchMethods` 仅兼容解析，不持久化；课题 DTO 中始终返回空数组。共享包旧声明与事件类型仅供历史数据兼容，不代表可用功能。
- 时间线／线程消息 POST 与消息 PATCH 追加可选 `mentions: { userId, label, start, end }[]`（最多 100 项）。范围针对 trim 后正文，使用 UTF-16 下标 `[start,end)`；正文片段必须等于 `@${label}`，label 必须匹配当前项目成员姓名，范围不得重叠。消息 `meta.mentions` 保存有效范围；不提供时视为无选定提及，不按纯文本姓名猜测。
- 私有会话带非空提及返回 422；访客发言仍返回 403。跨项目成员、无效范围或已退出成员返回 422。提及不会改变消息的 `agentVisible`。
- 同一消息／成员只生成一次提醒；编辑只提醒新增对象，自提及不提醒。完成提醒后再次加入同一对象也不重新通知。服务端在消息行锁保护下记录累计通知对象。
- 提醒链接使用消息锚点 `#msg_…`；团队讨论链接同时包含 `?discussion=project` 或 `?discussion=<threadId>`，沿用原有历史消息定位能力。
- “任务”只合并界面入口，boards／todos 数据与 API 保持独立。成员查看复用现有 members API 与 presence 事件。

### 研究空间统一 AI 处理（2026-11-01，追加）

`ResearchAction.processing` 为可选配置：`mode=auto|fixed`、`expectedOutputs`（`note/table/figure`，空数组表示自动决定）、`locks.transform/chart`（复用原有计算与绘图配置）。旧行动未设置此字段时保留原执行方式；新界面创建自动处理步骤。`outputs` 的既有具名槽仍是硬约束，不因重新规划改变类型；`figure` 只表示现有柱状、折线及散点数据图。

`ResearchExecutionSettings.replan` 可选，传入启动运行或实例化方案时要求重新规划；不传时，仅目标、输出、锁定配置和输入结构一致的成功方案可以复用。每次仍固定新输入。自动处理保存于原运行 JSONB，`attempt.processing` 包含版本、内部方案、实际进度、是否复用、澄清问答及中间快照。`step.waitingFor.kind=clarification` 表示需补充信息，不等同于人工检查或批准。

新增 `POST W/runs/:runId/steps/:stepId/answer`：`ResearchRunAnswerInput {questionId, answer, baseVersion, idempotencyKey}` → `ResearchRun`。`baseVersion` 对应当前 `attempt.processing.version`；仅有项目写权限的成员本人可回答。重复相同幂等键及内容不重复恢复，冲突或过期问题返回 409，非法输入返回 422，越权拒绝。恢复同一运行及尝试，保留原输入和所有问答；原 `/confirm` 仍只处理人工检查。

自动处理内部步骤不创建可见画布节点；仅执行既有整理、提表、表格计算和数据绘图。中间材料先固定，再用于实际计算；成功产物引用的完整依据链进入审阅与导出。失败或等待中的中间材料不作为正式成功产物进入画布、搜索和审阅成果。

## 9. 个人 Agent 完整接入（2026-11-01，追加）

本节细化并更新 §2.21/§2.22 的接入范围、权限与额度；操作目录和客户端示例见 [个人 Agent 接入说明](docs/agent-integration.md)。现有 REST 路径、Cookie 会话和九个兼容 MCP 工具保留。

### 9.1 操作发现与调用

`GET /api/v1/integrations/operations` 返回 `{items: Operation[], coverage}`。每项包含稳定 `id`（如 `POST /projects/:projectId/todos`，不含 API 前缀）、`method/path/domain/access/effect/description/input/response/pagination/conditions`。真实注册路由与经过审阅的显式清单对照，未登记路由默认禁止令牌访问；人工确认和凭证管理接口不在开放清单中。

MCP 追加 `list_operations({domain?,keyword?,effect?,offset?,limit?})`（返回 `operations/nextOffset/total`）、`describe_operation({operationId})`、`read_operation`、`write_operation`。后两者接受 `{operationId,params?,query?,body?,idempotencyKey?,transfer?}`，只调用登记路由；成功返回 `{status,data,replayed?,segmented?,continuation?}`，失败是 `isError` 且文本 JSON 为 `{error:{code,message,details?}}`。兼容工具保留原文本格式，并追加结构化错误。只读令牌不显示写入工具或写操作；Notebook `complete/inspect` 等语义读取的 POST 可用。

通用调用经过与 REST 相同的鉴权、资源守卫、校验和业务服务，不使用站内 Agent 身份。只接受明确的路径参数和标量查询参数，不允许任意 URL 或额外 HTTP 头。文档导入可传 `transfer:{encoding:'base64',base64|fileId}`（内容必须为 Yjs 更新）；文件和论文上传可传 `transfer:{encoding:'multipart',file:{filename,mimeType?,base64|fileId},fields?}`。`fileId` 必须属于本人可访问的同一项目；大文件先分块上传再引用。

### 9.2 权限、限流与重试

可写令牌允许业务内容读写和执行，仍受成员角色、项目围栏及个人资源分享权限限制。项目删除／归档、成员与邀请管理、身份／令牌管理、模型凭证／外部连接配置和明确要求人工决定的审批只认网页会话，REST 与 MCP 一致拒绝。令牌撤销或过期会关闭已经建立的 `/ws` 与 `/collab`；归档、成员和分享变化同样收回持续连接权限。

`MCP_WRITE_PER_DAY`（默认 200）现在是 REST 与 MCP 共用的每令牌 UTC 日写额度，持久化保存，重启不清零。临时传输的开始／分块／取消不占业务写额度，完成发布占一次；每分钟请求上限照旧，同一 MCP 业务调用不因内部转发重复计数。

有副作用的令牌请求可传 `Idempotency-Key`（8–128 位字母、数字、下划线、短横线；业务原有更严格限制继续执行）。同一令牌、操作 ID 和键下，相同路径参数、查询和正文重放原结果，响应带 `Idempotency-Replayed:true`，不再占写额度；参数不同返回 409。重放前重新检查当前项目／资源权限，并复查业务守卫记录的实际资源及所需访问级别；无关查询参数不能替换业务正文中的目标。业务执行前登记 pending，完成后保存响应；进程在两者间中断时保留 pending 并返回明确的 `pending_or_unknown` 冲突，要求查询目标状态，不能自动重新执行或换键重试。幂等不是跨任意外部副作用的分布式事务。

持久审计只记录关联请求 ID、令牌／用户 ID、操作模板、非凭证目标标识、结果状态、错误码及耗时，不记录请求正文和令牌原文；审计保留 30 天。幂等响应属于权限保护下的重试记录，可能包含业务返回内容。

### 9.3 分段结果、文件与 Notebook

通用结果超过 64 KiB 时返回 `segmented:true`，`data` 含 `resultId/mimeType/encoding:'base64'/size/offset/base64/nextOffset/expiresAt`。使用 `read_operation` 调用 `GET /integrations/results/:resultId/chunks?offset=&limit=` 续读，默认 16 KiB、最大 256 KiB。片段按字节拼接再解析原始格式；结果只对原令牌可见，续读检查当前权限。缓存总量 64 MiB、最长 15 分钟，容量不足可提前淘汰；成员、角色、分享及归档等权限变化会清空快照，失效后重新读取。事件补拉使用 REST 响应头 `X-Next-Event-Seq`，或 MCP `continuation.afterSeq` 作为下一次 `afterSeq`，即使本页可见事件为空也可继续扫描。

| 方法   | 路径                                                   | 约定                                                                                          |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| POST   | `/integrations/transfers`                              | `{projectId,path,size,sha256}` → `{transferId,chunkSize,expiresInSeconds}`，最大 20 MiB       |
| PUT    | `/integrations/transfers/:transferId/chunks`           | `{offset,base64}`，单块最大 256 KiB；相同块可重试，不同块冲突                                 |
| POST   | `/integrations/transfers/:transferId/complete`         | 校验长度与 SHA-256 后发布文件；可用幂等键                                                     |
| DELETE | `/integrations/transfers/:transferId`                  | 取消暂存，204                                                                                 |
| GET    | `/projects/:projectId/files/:fileId/chunks`            | `offset/limit` → `{fileId,size,sha256,offset,base64,nextOffset}`                              |
| GET    | `/projects/:projectId/notebooks/:notebookId/contents`  | `offset/limit/contentHash` → Notebook JSON 的 UTF-16 字符片段                                 |
| GET    | `/projects/:projectId/notebooks/:notebookId/execution` | 同上，内容为内核、运行队列与各单元格输出                                                      |
| POST   | `/projects/:projectId/notebooks/:notebookId/cells`     | `{contentHash,operations}`；数组操作为 insert、replace、delete；先验证整批再编辑实时 Yjs 文档 |

上传暂存与用户、令牌和项目绑定，尚未完成的文件不进入业务列表；每用户最多 8 个未完成上传、声明总量不超过 64 MiB；同一路径的并发发布只允许首个成功，其余返回 409，不自动覆盖；闲置 24 小时后清理，实例重启需重新开始未完成上传。下载每次重新检查权限。Notebook 续读必须带首次哈希，版本变化返回 409；结构化编辑同样拒绝旧哈希，避免覆盖他人在线修改。执行、状态和取消复用既有 Notebook、研究流程及 Agent API；人工步骤仍由网页确认。`ResearchRun` 和 `AgentSession` 追加可选 `webUrl`；运行等待人工检查时链接聚焦待确认步骤，REST 与 MCP 使用相同位置。

研究运行的业务澄清 `POST W/runs/:runId/steps/:stepId/answer` 对可写令牌开放，继续校验问题 ID、状态版本和幂等键；它不等同于人工检查。`/confirm` 和审批结论仍只允许网页会话。澄清等待时的 `webUrl` 同样聚焦当前步骤。

### 2.23 接入：通知订阅（群机器人 · `modules/notify`）

用户在「设置 → 通知」里粘贴一个群机器人 webhook 地址，项目里发生事情时平台推一条**纯文本**消息到群里。默认关闭（`NOTIFY_ENABLED=false`）。

| 方法   | 路径                             | 权限     | 说明                                                          |
| ------ | -------------------------------- | -------- | ------------------------------------------------------------- |
| GET    | `/auth/me/notify`                | 网页登录 | `NotifyOverview { enabled, subscriptions[] }`，地址只回打码版 |
| POST   | `/auth/me/notify`                | 网页登录 | 新建 → 201；地址必须是三家官方域名之一                        |
| PATCH  | `/auth/me/notify/:id`            | 本人     | 改名 / 改地址 / 改事件 / 开关                                 |
| DELETE | `/auth/me/notify/:id`            | 本人     | 删除 → 204                                                    |
| POST   | `/auth/me/notify/:id/test`       | 本人     | 立刻发一条测试消息，返回 `{ ok, message }`                    |
| GET    | `/auth/me/notify/:id/deliveries` | 本人     | 最近 50 条投递记录                                            |

- **支持范围（本版明确限定）**：只支持**自定义机器人（群 Webhook）**，即"往机器人所在的那一个群推送"。
  **不支持**应用机器人（企业自建应用）：单聊、按 `open_id` / `chat_id` 定向发送、`app_id` + `app_secret`
  换 `tenant_access_token` 另需实现。**按当前范围不做**。三家平台的首批支持情况：飞书 / 企业微信 / 钉钉
  的自定义机器人都支持；应用机器人、单聊、邮件通知**均未实现**。
- **只支持三家官方域名**（`NOTIFY_PROVIDERS`）：`open.feishu.cn/open-apis/bot/v2/hook/`、`qyapi.weixin.qq.com/cgi-bin/webhook/send`、`oapi.dingtalk.com/robot/send`。必须是 `https`。**第一版不做通用 webhook**，这样"填内网地址让服务器去打"的 SSRF 面直接消失。
- **地址含密钥**（飞书 hook id / 企微 key）：只写不读，接口只返回 `urlHint`，日志里也不打印完整地址。
  打码按 provider 的凭证位置处理（飞书＝路径最后一段，企微/钉钉＝`key` / `access_token`），
  并同时遮蔽其它敏感查询参数（`token` / `sign` / `signature` / `secret` 等），**不做 early return**。
- **消息内容**：只有「【研协】+ 事件说明 + 链接」。**不发正文片段、不发收件箱标题**——
  `timeline` 生成的 @ 提醒标题里嵌着原文前 40 字，直接用会把旁聊内容带到群里，所以按收件箱 `kind`
  使用固定文案（决策卡/审阅/@/冲突/指派/完成/复核）。
- **消息格式按平台适配**：飞书 `{msg_type,content}`、企微/钉钉 `{msgtype,text.content}`。
- **成功判定**：HTTP 2xx **且** body 能解析成 JSON **且** 平台返回码为 0（飞书 `code` / `StatusCode`，
  企微钉钉 `errcode`）。空响应、被网关替换成 HTML、缺返回码一律按失败处理并继续重试——三家在
  "参数错/被限流/关键词不匹配/签名不通过"时同样返回 HTTP 200，只看状态码会误报成功。
- **事件**：`inbox.created`（默认）、`message.created`、`thread.updated`、`decision.updated`、`review.updated`、`claim.conflict`、`report.updated`。
- **隐私**：旁聊（`agentVisible=false`）一律不发——包括旁聊里的 @ 提醒（`inbox.created` 会按 `sourceId`
  回查来源消息与线程）；个人线程只发线程主人；收件箱事件只发该条目主人；
  **发送前**重新核验项目成员身份与项目是否归档，已失权的待发记录直接 `dropped`，不再重试。
- **重试**：10 秒超时，失败按 `1m / 5m / 30m / 2h / 6h` 重试，5 次后 `dropped`；订阅连续失败 20 次自动停用并写 `disabledReason`，同时在主人收件箱留一条提醒。幂等靠唯一索引 `(subscription_id, project_id, event_seq)`，同一条事件不会重复发。
- **上限**：每人最多 `NOTIFY_MAX_PER_USER`（默认 3）个订阅。
- **平台安全设置**：自定义关键词请填 `研协`（消息前缀是「【研协】」）；IP 白名单填**服务器出站公网 IP**；
  **签名校验本版未实现**，开启后会全部失败，请改用关键词或 IP 白名单。
- **验证状态**：仅**飞书**做过真机验证（真实接口返回 `19001` 证明请求格式被接受、失败判定生效）；
  **企业微信、钉钉未做真机验证**（缺可用 webhook 凭据），其实现按官方文档的请求格式与返回码编写。

## 文献独立笔记与协同补充（L03 / L06 / L08 笔记部分 / L12，2026-11-01）

本节补充 §2.15；取代旧阶段“仅单份笔记、发布不包含任何笔记”的描述。高亮、批注、持久问答的选择发布见后续补充。个人库仍为账号级，网页保留项目导航不改变数据归属。

下表的 B 为个人 `/library/papers/:paperId/notes` 或项目 `P/library/papers/:paperId/notes`。个人接口从登录会话取所有者，不接受客户端指定归属；项目所有现存成员（含 guest）可编辑笔记。论文已归档时只读。

| 方法   | 路径                 | 输入与行为                                                                             |
| ------ | -------------------- | -------------------------------------------------------------------------------------- |
| GET    | B                    | 返回 `PaperNote[]`，不含已删除项                                                       |
| POST   | B                    | `PaperNoteCreateInput`：title、kind（note/brief，默认 note）、body（默认空）；返回 201 |
| PATCH  | B/:noteId            | title、baseVersion；版本不符 409，保留用户草稿                                         |
| DELETE | B/:noteId            | 软删除并关闭协同连接，204；迟到保存不重建记录                                          |
| POST   | B/:noteId/flush      | 确认当前已到达服务器的协同正文写入数据库，返回最新 PaperNote                           |
| POST   | 个人 B/:noteId/brief | title、sourceVersion；复制当前正文到新的私人说明稿；版本变化 409                       |

输入 strict 校验；标题 1—160 字符，正文最多 100000 字符。未登录 401，不属于当前个人论文／项目或记录已删除 404，输入不合法 422。创建、改名、删除归档论文的笔记返回 409。GET/flush 使用 private, no-store。

`PaperNote` 包含独立 id、paperId、title、kind、body、version、createdBy、updatedBy、createdAt、updatedAt，以及可空的 publishedFrom。归属通过所属论文继承。publishedFrom 只返回原作者、发布者、发布时间、来源版本号；不返回私人论文／笔记 ID，不提供私人编辑历史。原 `Paper.note` 和 PATCH note 契约兼容保留；新网页将旧正文只读展示，用户可以复制成独立笔记，未自动迁移或清空原文。

**发布扩展**：`PaperPublishInput` 增加可选 `notes: [{id, version}]`，最多 50 条、不得重复，未提供即空选择。前端默认全不选，选择后逐条 flush 并预览实际全文，随后发送预览版本。正文中普通文本原样复制；本轮不解析或复制附件、批注和问答引用。预览后已保存或已到服务端的正文发生变化返回 409；选择其他论文的笔记或已删除笔记返回 404。尚在其他设备离线缓存中的内容不属于服务端预览，应先在该设备同步。

复制论文／PDF／所有选中笔记／发布凭据处于同一数据库事务内；笔记获得新 ID，并仅以当前正文初始化新 Y.Doc，不复制含私人删除历史的 CRDT 状态。凭据保存排序后的选择与版本用于重试比对。相同 UUID 改选笔记返回 409；相同请求重试不重复复制。已存在同论文仍按 L07 返回 409 和 existingPaperId，追加或替换由 L10 处理。

**实时**：新增项目事件 `paper.notes.changed {paperId, noteId, deleted}`。私人笔记不发项目事件；个人多标签页列表每 5 秒检查，正文仍实时同步。项目列表收到事件或重新订阅后重取。

**正文共同编辑**：`/collab/lnt_<ULID>` 使用现有 Hocuspocus/Yjs 协议，正文为 Y.Text('body')。以资源权限检查本人／成员身份；guest 只在文献笔记上可写，普通文档权限不变。服务端逐消息复核权限并限制正文长度；成员移出、笔记或论文删除后关闭连接。持久化只更新存活记录。客户端复用按账号与文档 ID 隔离的 IndexedDB 缓存，断线修改恢复后合并；显示“已保存到服务器”之前还会调用 flush。

## 文献高亮、批注与选择发布补充（L04 / L08 / L13，2026-11-01）

本节扩展前述笔记发布规则：高亮、批注现已可以分别选择发布；持久问答选择发布见 L05 / L09 / L14 补充。个人库为账号级，项目成员均可维护项目标注（含 guest）；发布论文仍要求非 guest 的项目写入权限。

B 为个人 `/library/papers/:paperId/annotations` 或项目 `P/library/papers/:paperId/annotations`；实际请求带 `/api/v1` 前缀。

| 方法  | 路径                    | 输入与行为                                                                           |
| ----- | ----------------------- | ------------------------------------------------------------------------------------ |
| GET   | B                       | `includeDeleted=true/false`，默认 false；返回 `PaperAnnotation[]`，private, no-store |
| POST  | B                       | `PaperAnnotationCreateInput`；返回 201 和记录                                        |
| PATCH | B/:annotationId         | color、label、baseMetadataVersion；修改颜色/说明                                     |
| POST  | B/:annotationId/flush   | 持久化当前已到达服务器的批注正文，返回最新记录；高亮直接返回当前记录                 |
| POST  | B/:annotationId/trash   | baseVersion；软删除并关闭协同连接，返回 204                                          |
| POST  | B/:annotationId/restore | baseVersion；从已保存内容恢复为新 ID，返回新记录；同一次恢复可重试                   |

创建输入：kind 为 highlight/comment；color 为 yellow/green/blue/pink（默认 yellow）；label 可选、最多 160 字符；body 默认空、最多 100000 字符，高亮的 body 必须为空。fileId 必填且必须与当前论文一致；quote 为 1–12000 字符；page 为正整数且不超过已知页数；boxes 含 1–300 个同页矩形，每个有 page、x、y、w、h，坐标有限且非负，宽高必须大于零。输入 strict 校验，不接受额外归属字段。

`PaperAnnotation` 返回 id、paperId、kind、color、label、fileId、pdfSha256、page、quote、boxes、body、version、metadataVersion、createdBy、updatedBy、createdAt、updatedAt、deletedAt、restoredToId、publishedFrom、anchorStatus。Yjs 二进制状态不通过 REST 返回。publishedFrom 只包含来源作者、发布者、发布时间、来源版本号，不返回私人标注或论文 ID。

位置以未旋转 PDF 的用户空间保存：相对于 crop box 左上角，x 向右、y 向下，单位为 PDF 用户坐标。显示时通过 PDF.js viewport 恢复裁切原点、旋转与缩放，不直接保存屏幕像素。创建时由服务端保存当前 pdfSha256，返回时以文件 ID 和 hash 核对；不匹配返回 `anchorStatus: mismatch`，客户端保留文字记录、显示“原文版本不同／定位待确认”，隐藏当前 PDF 上的标记并禁止定位/发布。坐标和原文是创建时的快照，本轮不提供自动重新定位或移动锚点。

未登录 401；跨账号、非成员、论文/标注不属于路径、已删除记录 404；非法输入 422；文件变化、颜色/说明版本冲突、删除前记录变化返回 409。metadataVersion 仅在颜色/说明改变时增加，避免正文输入造成无关冲突；version 在正文、元数据、删除/恢复状态改变时增加，用于发布预览和删除确认。元数据/删除冲突的 `details.current` 返回可核对的最新记录。已归档论文禁止创建、改色、删除和恢复，正文只读。

**发布**：`PaperPublishInput.annotations?: [{id, version}]`，最多 200 条、不得重复。默认空选择；按高亮/批注分别勾选，flush 后展示原文、颜色、说明及当前正文全文，随后提交预览版本。后端再次核对归属、存活状态、PDF 身份、持久化版本及已到达服务器的实时正文。过期返回 409，已删除/跨论文返回 404。复制所选记录与论文、PDF、所选笔记及发布凭据在同一事务提交；标注指向新团队 PDF，使用新 ID 和仅由当前正文初始化的 Y.Doc，不复制私人协同历史。只选高亮不携带任何相邻批注；只选批注携带自身原文定位，不创建额外高亮。相同请求的重试比较规范排序后的 annotations 与 notes；内容变化的同 UUID 请求返回 409。已有团队论文时可按 L10 规则追加所选资料，不覆盖团队现有内容。

**实时**：`paper.annotations.changed {paperId, annotationId, deleted}` 与标注修改在同一事务登记，提交后广播。个人标注不发项目事件；个人多标签页的目录每 5 秒检查，正文仍实时同步。项目页面收到事件及重新订阅后重新读取；删除记录可按需保留在列表中供恢复。

**正文协作**：`/collab/lan_<ULID>` 仅用于 comment 的 `Y.Text('body')`，复用 Hocuspocus/Yjs 与按账号、记录隔离的 IndexedDB。普通文档权限不受影响。服务端逐消息复核资源访问权限、限制合并后正文长度，记录实际编辑者；存储仅更新未删除记录。成员移出、批注/论文删除后关闭连接。客户端显示连接/保存状态；收到服务端持久化确认后才标为已保存。删除/撤权后本机草稿保留可读可复制，不能继续提交；恢复创建新 ID 和新 Y.Doc，旧连接或旧离线编辑不能复活记录或进入恢复后的正文。其他设备尚未同步的内容不属于发布/恢复快照。

## 文献持久问答与选择发布补充（L05 / L09 / L14，2026-11-02）

本节补充 §2.15，取代早期“问答仅临时保存在网页、问答不参与发布”的阶段说明。旧 `POST B/library/qa` NDJSON 接口保留兼容；阅读页改用下列持久任务接口。

以下 Q 为 `/library/papers/:paperId/qa` 或 `P/library/papers/:paperId/qa`。个人归属从登录身份推导，不能指定其他所有者；项目历史和已完成正文允许全部成员访问/维护，模型生成仍要求非 guest 的项目写权限。归档论文只读。

| 方法       | 路径                        | 输入与行为                                                                                                |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET / POST | Q/sessions                  | GET → `PaperQaSession[]`；POST `{title}`，1–160 字，返回 201                                              |
| PATCH      | Q/sessions/:sessionId       | `{title,baseVersion}`，过期 409；不改问答正文                                                             |
| POST       | Q/sessions/:sessionId/trash | `{baseVersion}`，软删除会话、停止任务并关闭协作连接，返回 204                                             |
| GET        | Q/sessions/:sessionId/turns | 按创建时间、ID 排序的 `PaperQaTurn[]`，含保存的来源与上下文快照                                           |
| POST       | Q/sessions/:sessionId/turns | `PaperQaAskInput`，返回 202 与已保存轮次；任务继续在后端运行                                              |
| POST       | Q/turns/:turnId/stop        | 停止生成并保存部分内容，返回轮次；已完成时不改输出                                                        |
| POST       | Q/turns/:turnId/flush       | 确认协同正文持久化，返回当前轮次与版本                                                                    |
| GET        | Q/turns/:turnId/revisions   | 可带 `before` 版本号；按版本降序返回至多 50 条修订                                                        |
| POST       | 个人 Q/turns/:turnId/brief  | `{title,sourceVersion}`，复制已完成正文为独立个人说明稿，保留作者、时间、版本及来源文字；不带整段私人历史 |
| POST       | 个人 Q/publication-preview  | `{projectId,selections}`，校验项目写权限；返回完整公开正文、来源、漏选上下文和 `previewHash`              |

**提交任务**：`{requestId: UUID, question: 1..2000字, modelId?, searchScope?: 'paper'|'all', contextTurnIds?: string[]}`。默认只检索本篇、不带前文；网页可开启携带最近三条已完成问答。上下文最多三条，须属于同一会话且已完成，保存实际使用的版本与问题/回答前 1500 字快照。`searchScope: all` 只搜索当前个人库或当前项目库，不跨隐私边界。模型目录复用 translation-models，显式模型失效返回 422。

请求按 `(sessionId, requestedByUserId, requestId)` 幂等，同编号不同内容 409；同内容重试返回原轮次而不重复调用模型。任务有独立 `generationId`，后端并发上限为每个用户 2 个、进程内合计 8 个，超限 429。默认最长 120 秒，浏览器断开不取消任务；主动停止为 cancelled，失败/超时为 failed，后端重启遗留任务为 interrupted。保留部分回答和错误说明，不自动付费重试。无检索结果时保存明确说明，不编造回答。

**保存记录**：轮次包含当前 question/answer、originalQuestion/originalAnswer、status、模型名称、检索范围、sources、context、版本、署名与时间。每条 source 保存引用片段、页/段/坐标及 PDF 身份；当前来源删除、变更或未共享时分别标明 missing/changed/unshared，前端禁止错误跳转。Y.Doc 和幂等签名不通过 REST 暴露。原始输出保持不变，人工修订按持久化快照记录，非逐键审计；一个合并快照的 actor 是最后参与该次保存的编辑者。

**发布**：`PaperPublishInput.qa?: [{id,version,unsharedSources?: 'mark'|'remove',allowMissingContext?:boolean,previewHash?}]`，最多 50 条、不得重复。默认不选；实际发布所选问答必须携带服务端预览返回的 hash，缺失/不匹配为 409。服务端重新核对正文、版本、引用映射和上下文，预览之后变化需重新预览。前文缺失/版本不同且未明确确认时 422；用户可补选前文、制作独立说明稿，或按上下文不完整发布。

只复制所选当前正文、其中使用的引用和安全署名；不复制私人原始输出、旧修订、Yjs 历史或未选检索上下文。同篇引用映射到新团队 PDF；其他个人论文已单独发布且 PDF 身份与段落文本匹配时，映射到已有团队资料，否则按选择清除引用标记，或保留“来源未共享”文字并清除私人 ID、文件/段落链接、坐标和来源全文。已知私人资源链接清理不等于完整语义脱敏，正文必须由用户核对。团队副本使用新会话、轮次、引用 ID，原始版本为此次公开起点；选中且版本匹配的上下文改用团队 ID 和公开正文快照。旧发布凭据 qaSelection 默认为 `[]`。论文/PDF/笔记/标注/问答及凭据在同一事务提交，同请求重试可复用结果。已有同论文仍拒绝追加/覆盖，待 L10。

**实时与协作**：`paper.qa.changed {paperId,sessionId,turnId:string|null,deleted:boolean}` 与变更同事务记录，提交后广播，事件不含问答正文；个人问答不发项目事件。生成约每 250ms 检查点保存，网页生成时约 750ms 补拉，项目事件触发立即重取，目录/静态记录另有 5 秒检查。完成后的 `/collab/lqt_<ULID>` 使用同一 Y.Doc 的 `Y.Text('question')` / `Y.Text('answer')`，分别限制 8000 / 100000 字；queued/retrieving/generating/failed/cancelled/interrupted 均不开放正文协作。成员撤权关闭连接，生成者移出/改角色会停止任务；删除会话或论文后迟到保存不能复活。短暂离线修改复用按账号/文档隔离的 IndexedDB，恢复权限后同步；切换阅读栏目保留已打开编辑会话。

未登录 401；跨个人所有者、非项目成员、资源不属于路径或会话删除 404；guest 发起模型调用 403；非法字段 422；版本过期/资源变化 409。没有可用模型仍可读取和维护已完成的历史问答。

### 同论文追加发布、标注说明稿与选句问答（2026-11-02）

本节补充并覆盖之前“发现同论文即停止发布”的阶段性约束；旧请求字段保持兼容。路径均含 `/api/v1` 前缀。

`GET /library/papers/:paperId/publish-targets?projectId=:projectId` 返回 `PaperPublicationTarget<Paper>[]` 数组。要求当前账号拥有个人原件且具有目标项目写入权限。候选按 DOI、arXiv 编号、PDF 指纹、来源 URL 或本原件的历史发布凭据寻找，不按标题相似度自动合并。每个候选包含 `paper`、`reasons`、`samePdf` 和 `published: { notes, annotations, qa }`；三个数组均为本个人原件已向该目标发布的 `{ id, version }`。URL 相同只是人工核对线索。`samePdf` 要求两侧有文件且 PDF 指纹相同。

`POST /library/papers/:paperId/publish` 追加两个可选字段：`targetPaperId` 和 `targetUpdatedAt`（ISO 时间）。两者必须同时提供。省略时继续创建独立项目论文；存在候选时返回 409，要求明确选择目标。提供时目标必须仍在候选内、未归档且时间与预览一致；仅追加所选新记录，不替换团队 PDF、解析结果、标题、标签或已有阅读记录。追加至少选择一条笔记、标注或问答。

同一目标内按个人来源记录 ID 与版本核对发布历史：已发布版本跳过，个人新版本创建另一条独立团队记录；团队后续编辑或删除旧副本不会使该版本被重新发布或复活。不同人的独立记录不会按文字相同去重。只有同 PDF 的新标注可追加，不同 PDF 时整次事务失败并提示可整理说明稿；笔记可以独立追加。项目行锁串行化并发发布，原有源版本核对、事务回滚、请求 ID 幂等仍生效。

返回结果追加可选 `summary`：

```ts
{
  mode: 'created' | 'appended';
  added: {
    notes: number;
    annotations: number;
    qa: number;
  }
  skipped: {
    notes: number;
    annotations: number;
    qa: number;
  }
}
```

同请求重试返回凭据中保存的统计，`replayed: true`；旧凭据可能没有 `summary`。新目标字段属于请求身份，同一请求 ID 更换目标或预览时间会返回 409。新增记录使用既有 `paper.notes.changed`、`paper.annotations.changed`、`paper.qa.changed` 事件，同时记录 `paper.updated`；事件与复制同事务提交，之后广播。事件不包含个人正文或私人资源 ID。

`POST /library/papers/:paperId/qa/publication-preview` 增加可选 `targetPaperId`。预览指纹包含目标、最终引用、选句快照和缺失前文提示；发布时重新核对。同 PDF、相同解析段落才能映射定位。不能映射的来源遵循每轮 `unsharedSources: 'mark' | 'remove'`；mark 去掉私人文件 ID／指纹、标为未共享，remove 移除该来源。已发布前文不重新复制：若新轮次依赖未随本次公开的冻结前文，仍须确认缺上下文或改成独立说明稿，不能把团队后来改写的版本当作模型当时依据。

`POST /library/papers/:paperId/annotations/:annotationId/brief` 接受 `{ title, sourceVersion }`，返回新建的 `PaperNote`（201）。仅个人路径开放，标题 1—160 字符，版本为正整数。保存并核对当前批注正文后创建 `kind: 'brief'` 的独立私人笔记，包含所选原文、说明／正文、论文题名、页码、作者、时间、版本与 PDF 指纹。PDF 已变化时保留历史文字并标注定位待复核。新建 Y.Doc，不复制私人协作历史；整理后的正文超过 100000 字符返回 422，源版本已变返回 409。制作说明稿不会调用模型或自动发布。

个人与项目的 `POST .../qa/sessions/:sessionId/turns` 在 `PaperQaAskInput` 中增加可选 `selection: { fileId, page, text }`，当前仅支持一页，文字 1—4000 字符。服务端校验当前文件身份及已知页码，单独保存 `PaperQaSelection`：`{ fileId, pdfSha256, page, text, status }`；status 为 `available | unshared | changed | missing`，文件 ID 和指纹可为空。旧轮次 `selection` 为 null。不接受客户端自报 PDF 指纹或来源状态。

选句与问题分别传入模型，明确为用户提供的资料，不作为指令或解析器已验证的论文片段。没有解析正文但提供有效选句时允许解释该句；两者都没有时仍拒绝普通单篇问答。点击网页“引用到问答”本身不创建任务，点击“发送问题”后才调用问答模型并保存。历史卡显示当时选句与页码，当前 PDF 身份一致才允许定位；只支持跳到页，未保存问答选句的矩形位置。发布全文预览包括选句，同 PDF 时改为团队文件身份；版本不符时按来源策略标记／移除。问答转说明稿同步包含该选句文字。

### 文献问答：单篇概览、追问检索与缺资料状态（2026-11-02）

本节补充上述问答接口，不新增请求字段、端点或事件。

`searchScope: 'paper'` 的持久问答以及旧流接口带 `paperId` 的请求，检索时优先取最多 6 条相关段落，再补充最多 6 条当前论文的概览节选并按 `chunkId` 去重；没有关键词命中时直接选取最多 12 条概览节选。概览只来自当前归属范围内、未归档的指定论文，选择摘要、正文首尾、主要章节及按位置分布的段落，排除章节名明确标记为参考文献的段落。保留原始段落、页码和引用定位。概览不是全文；模型每段最多收到 1800 字符，不保证覆盖所有结果、表格和公式。旧流接口返回的概览来源 `score` 为 0，表示不是关键词命中分数。

检索额外使用明确带入的历史中最近两条用户问题，每条最多 1500 字符；持久问答读取生成时冻结的 `contextTurnIds` 快照，旧接口读取请求的 `history`。不读取未选择的会话，也不把历史答案用作新的检索证据。全库模式 `searchScope: 'all'` 继续按相关性检索最多 8 条、每篇最多 4 条，不以任意论文概览补足空结果。

持久问答在没有来源且没有主动选句时，任务终态改为 `failed`，`answer` 为空，`error` 区分“当前论文缺少可用正文”和“全库没有命中”；不会调用回答生成模型。关键词提取可能已经调用过模型。单篇尚未解析且没有选句仍在提交时按既有约定返回 409。旧 NDJSON 接口保留 `sources → delta → done` 帧兼容，只更新缺资料提示。已保存的旧问答不自动修改；修复后需要重新发送问题。

### 章节正文与显式选句入口补充（2026-11-02）

本节更新前一节的单篇上下文策略，接口字段和路径保持兼容。短问题明确要求概括、总结、解释某章节时，服务端先匹配当前论文已解析的章节标题或章节编号，支持 Introduction／引言等常见中英标题对应，以及“第 1 节”“section 2.1”等写法。匹配唯一章节时只提供该章及其子节的正文候选，按原顺序保留，不混入全篇结论；明确携带该章节前文的“再详细一点”等简短追问可沿用章节。未识别或存在多个匹配时回到普通问答策略，不宣称已定位章节。

已定位章节最多提供 24 个原始段落，每段最多 6000 字符，总正文预算 24000 字符；超出则截取，不保证完整覆盖。全篇概括直接选代表性正文，普通单篇问答仍使用相关段落加概览，均最多 12 段、每段 1800 字符、总预算 21600 字符。送入模型的文本与保存的 `PaperQaSource.quote` 一致；旧流接口的 `LibraryHit.text` 同样表示本次实际提供的节选。超过预算不改变原始 `chunkId`、页码或段号。

仅问答取材排除独立页码、明确期刊页眉及跨至少三页重复的短文字；概括优先选择有句子或列表条目的正文候选，避免图片标签占满材料。原始解析记录和普通全文检索不删除这些文字。该规则是启发式筛选，不构成正文完整性验证。发布引用按保存片段的实际长度核对目标原段落前缀，继续兼容旧 1800 字符快照；空引用不能据此映射为可用来源。

网页选词后的浮动菜单增加有文字的“引用到问答”；阅读器工具条也显示同名文字按钮。点击只将选句放入问答待发送区，不自动调用问答模型，发问权限仍沿用原角色检查。高亮、批注与翻译行为保持各自入口，选句仍沿用单页、最多 4000 字符的限制。

### 上游空间与账号个人库共存（2026-11-02）

以上 `/library` 个人接口指账号级个人库，只按当前登录用户确定范围。`P/library` 同时保留上游的 `team/personal/shared` 列表范围以及分享、移动接口。对于项目内个人论文，读取和编辑笔记、标注、问答必须满足该论文的资源分享权限；“全部项目成员可维护”只适用于团队论文，不能解释为对私人论文授权。撤销分享或移动空间会断开该论文的协作子文档连接，重连重新鉴权。

账号个人库导入和项目 PDF 导入均限制 100 MB。原作者项目私人 PDF 的 `Paper.fileId` 可以是 `private:<hash>` 定位标识，不代表项目文件库授权；PDF 内容仍经对应论文的 `/pdf` 接口读取。团队持久问答不检索提问者的私人论文；账号个人问答仅使用该账号个人库，项目私人问答只用团队材料和当前私人论文。

选择发布只创建或追加团队副本，发布候选不会返回项目内个人论文。发布后的源账号记录与目标团队记录分别维护。账号库和新增阅读协作路由已逐条登记为接入目录的 `interactive` 操作；API 令牌调用返回 403“这个操作需要在网页中完成”，没有放宽上游既有令牌权限。

## 反馈中心与运维后台（`modules/feedback`、`modules/admin`，2026-11-04）

契约在 `@srh/shared` 的 `feedback.ts`。工单编号对外显示为 `YX-<no>`（`ticketCode` / `parseTicketCode`），路径里的 `:no` 接受 `12` 或 `YX-12`。以下路由全部只认网页会话：已在接入目录逐条登记为 `interactive`（`catalog-feedback-interactive.ts`），API 令牌调用返回 403。`/admin/*`、更新日志写操作只限管理员（`users.is_admin`），其他人 403。

| 方法           | 路径                                         | 请求 → 响应                                                                                                                  |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| POST           | `/feedback/tickets`                          | `CreateTicketInput`（JSON 或 multipart：截图字段 `files` ≤5×8MB，日志字段 `logs` ≤3×1MB 纯文本）→ 201 `TicketDetail`         |
| GET            | `/feedback/tickets`                          | `TicketListQuery`（`scope=mine\|waiting\|all`、status、kind、roadmap、q、assignee、`sort=recent\|votes`）→ `TicketSummary[]` |
| GET / PATCH    | `/feedback/tickets/:no`                      | `TicketDetail` / `UpdateTicketInput` → `TicketDetail`；提交人只能 `{status:'closed'}`，其余字段限管理员                      |
| POST           | `/feedback/tickets/:no/messages`             | `CreateTicketMessageInput`（JSON 或 multipart，可带 `files`）→ 201 `TicketDetail`                                            |
| POST           | `/feedback/tickets/:no/read`                 | 标记已读 → `{ ok: true }`                                                                                                    |
| POST / DELETE  | `/feedback/tickets/:no/vote`                 | 建议 +1 / 取消 → `TicketVoteResponse { voteCount, voted }`                                                                   |
| GET            | `/feedback/tickets/:no/attachments/:id`      | 附件下载；诊断日志只给提交人和管理员（其他人 403）                                                                           |
| GET / POST     | `/changelog`                                 | 登录可读 `ChangelogEntry[]`（非管理员不含草稿） / 管理员 `CreateChangelogInput` → 201 `ChangelogEntry`                       |
| PATCH / DELETE | `/changelog/:id`                             | 管理员 `UpdateChangelogInput`（`publish:true` 发布草稿）→ `ChangelogEntry` / 204                                             |
| GET            | `/me/notifications`                          | `UserNotificationQuery` → `UserNotificationList { items, unread }`                                                           |
| POST           | `/me/notifications/read`                     | `MarkNotificationsReadInput`（`ids` 或全部）→ `UserNotificationList`                                                         |
| POST           | `/feedback/client-errors`                    | `ClientErrorInput` → 204；写入运维事件（source=web）                                                                         |
| GET            | `/admin/overview`                            | `AdminOverview`（服务器、磁盘、数据库、模型、agent 24h/7d 统计、计数）                                                       |
| GET / PATCH    | `/admin/users`、`/admin/users/:id`           | `AdminUserRow[]` / `AdminUpdateUserInput { isAdmin }` → `AdminUserRow`；撤销自己或 `ADMIN_EMAILS` 指定者 409                 |
| GET            | `/admin/projects`                            | `AdminProjectRow[]`                                                                                                          |
| GET / DELETE   | `/admin/ops-events`、`/admin/ops-events/:id` | `OpsEventListQuery` → `OpsEvent[]` / 204                                                                                     |
| POST           | `/admin/ops-events/:id/ticket`               | 转成工单（source=ops）→ 201 `TicketDetail`；已转过 409（`details.ticketNo`）                                                 |

- **可见性**：管理员看全部；普通用户看自己提交的工单和所有「建议」（idea 公开、可投票）。诊断上下文与日志只给提交人和管理员，其他人只拿到 `hiddenLogCount`。对话只有提交人与管理员能发，管理员一方统一显示为「研协支持」。
- **状态**：`open / doing / done / closed`；`scope=waiting` = 对方最后发言、等我回复。提交人在 done / closed 工单上回复会重开为 open。建议的路线图 `planned / building / shipped` 由管理员设置。
- **更新日志**：发布时关联工单（`ticketNos`）置为 done、关联建议路线图置为 shipped，并给提交人发站内通知。通知只在站内，不推外部渠道。
- **附件校验**：截图按文件头核对类型（png/jpeg/gif/webp），日志含 NUL 字节视为二进制；不符 415。非成员或无效 `projectId` 静默忽略。
- **管理员**：`ADMIN_EMAILS`（逗号分隔）在 Cookie 会话、登录、注册时自动提升为管理员，只提升不降级；`GET /auth/me` 的 `MeResponse.isAdmin` 恒返回。
- **运维事件**：服务端未捕获错误、agent 回合失败、前端上报按指纹合并（计数 + 首末时间），同一指纹进程内 60 秒节流；写入失败只记日志不影响业务。
- **限流**：client-errors（需登录）每用户 30 次/分钟；通知轮询 60 次/分钟；附件上传每用户 10 分钟 40 个。超出 429。

### 2.24 多模型与按量计费、KyrenPay 充值（`modules/billing`，2026-11-05）

契约在 `@srh/shared` 的 `billing.ts`。1 积分 = 0.001 美元零售价，全部是整数（bigint），账本里没有浮点。

| 方法 | 路径                     | 请求 → 响应                                                                                                      |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GET  | `/billing/me`            | `BillingOverview { enabled, exempt, balance, topupEnabled, packs, prices, recent }`（`recent` 为最近 50 条流水） |
| POST | `/billing/topup`         | `TopupInput { sku }` → `TopupCheckout { ref, url }`；未配 KyrenPay 503 `payment_unavailable`，未知 sku 422       |
| GET  | `/billing/orders/:ref`   | `PayOrderView`；只给下单本人（他人 404）。订单仍是 created 时向 KyrenPay 查收银台 → 订单，核对无误才入账         |
| POST | `/billing/kyren-webhook` | KyrenPay 回调，不登录，验签（见下）；成功 200 `{ received, duplicate }`，验签失败 400                            |
| POST | `/admin/credits`         | 管理员 `CreditAdjustInput { userId, delta, note? }` → `{ userId, balance }`                                      |

- **模型**：设了 `OPENROUTER_API_KEY` 就出现内置 provider `openrouter`，`ModelInfo.group` 为 `cn`（千问 / GLM / Kimi）或 `intl`（Claude / GPT / Gemini），选择器按组显示。请求头带 `HTTP-Referer` / `X-Title`，推理参数 `reasoning.effort`，并带 `usage.include` 拿真实成本。DeepSeek 直连不变、仍是默认。
- **计费范围**：只对平台 env provider（`deepseek`、`openrouter`）计费；项目自配 provider（`source:'project'`）不拦截、不扣费、不记账。
- **价格**：优先用上游返回的 `usage.cost`（美元），否则按兜底价表估算（未知模型按最贵一档）。扣费 = `ceil(成本美元 × BILLING_MARKUP × 1000)`，有 token 用量最少 1 积分。流式调用带 `stream_options.include_usage`。
- **谁付费**：触发的用户；后台 / 定时任务（报告、研究执行、看图、压缩上下文、项目文献处理等）扣项目创建者（`projects.created_by`）。
- **闸门**：`BILLING_ENABLED=true` 时余额 ≤ 0 拒绝调用，402 `insufficient_credits`「余额不足，请先充值」（前端全局提示带「去充值」）。单次调用可以把余额扣成小负数。管理员免扣费、不拦截，用量照记（delta 0）。`BILLING_ENABLED=false`（默认）时不拦截、不扣费，只记用量。
- **赠送**：每个账号一次性 `BILLING_SIGNUP_CREDITS`（默认 500），流水 ref `signup:<userId>`，首次读余额时发放。
- **账本**：每次余额变化与流水同一事务；流水 `ref` 唯一，重复写入自动忽略（`usage` / `topup:<ref>` / `refund:<refund_id>` / `adjust:<id>` / `signup:<userId>`）。
- **充值包**：`credits-5` 5 美元 → 5,000；`credits-10` 10 美元 → 10,500；`credits-30` 30 美元 → 33,000。每个包在 KyrenPay 懒创建一个商品（`kyren_products` 缓存）。成功页 `<PUBLIC_URL>/billing?ref=<ref>`。
- **验签**：`X-Kyren-Signature = 'sha256=' + hex(HMAC-SHA256(KYREN_WEBHOOK_SECRET, `${X-Kyren-Timestamp}.${rawBody}`))`，时间戳毫秒、偏差 > 5 分钟拒绝，原始请求体定长比较。
- **入账**：只处理 `order.paid`（以及 `order.refunded`、`order.closed`），按 `data.metadata.ref` 找订单；订单状态 created、金额（整数分）、币种、`product_id` 全部一致才在一个事务里置 paid 并入账，否则记 `review_note` 留人工复核。事件 id 去重（`kyren_events`），业务写入完成后才回 2xx。绝不凭成功页 URL 本身入账。
- **退款**：按退款金额占原价比例扣回积分（向上取整），流水 ref `refund:<refund_id>`，余额可以为负。
