<!--
文件：README.md（prompts 目录说明）
加载者：无（给维护者看，不送给模型）。
版本：v2.13（2026-11-01）
-->

# 研协 agent prompts

> 版本 v2.13（2026-11-01）。每次修改任一 prompt 文件，同步修改该文件头部注释里的版本号和日期，并在下方变更记录加一行。

这个目录是研协 agent 的“大脑”：所有角色的 system prompt 都从这里组装。正文一律中文，工具名、参数名、枚举值保持英文原样。

## 1. 文件

| 文件                 | 角色                        | 说明                                                                                                              |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `shared-protocol.md` | 所有常驻 agent              | 平台全貌、一个研协的声音、服务器是真相、wake 读法、信任等级、记忆、认领、审阅、跨方法证据规则、每轮以工具调用结束 |
| `coordinator.md`     | 协调者（role=coordinator）  | 分诊表、brief 写法、派活前冲突检查、转发卡片、进度汇报、卡住线程、组会汇报、计划审阅关口、记忆维护、交接          |
| `thread.md`          | 项目线程（role=thread）     | 第一轮、进度清单格式、认领操作顺序、研究操作与文献/计算实验/写作工作流、审阅关口、决策卡、回复节制、解决规则      |
| `personal.md`        | 个人工作区（role=personal） | 私有边界、何时建议转发给协调者、先问再碰共享对象                                                                  |
| `report.md`          | draft_report 生成器         | 一次性无工具生成；输入分节 Markdown 项目记录，输出含关键结果与证据的五节 Markdown 草稿                            |

## 2. 组装顺序（每一轮）

常驻 agent（coordinator / thread / personal）：

实际顺序（`runtime/context.ts` 的 buildSystemPrompt + `runtime/turn.ts` 的 executeTurn）：

```
system（一条消息，各块以空行分隔）:
  1. shared-protocol.md            （静态，可缓存）
  2. <角色>.md                     （静态，可缓存；只替换 project_name / thread_title / working_for / owner_name）
  3. <session-context nonce=…>     （服务器生成，见 2.1；含本轮工具清单和当前时间）
  4. <memory>                      （见 2.2，整块有 token 上限；含正式方案 / 团队依据 / 探索副本 / 本轮成员的个人工作记忆）
  5. <context-summary>             （agent_sessions.context_summary，非空时；≤ 3000 字）
  6. harness 段：<profile> → <skills> → <goal> → <mcp-servers>（各自有内容时才出现）
then（按时间顺序重放）:
  7. 摘要之后的历史 turn：每个 turn = <wake> 信封 → assistant / tool 往返，
     中间插入的 <system-note>（nudge：收尾 / 必须调用工具；goal_reminder：任务目标）原样重放
  8. 本轮 <wake reason=…> 信封（线程 / 个人会话末尾带 <thread-state />）
  9. 续跑轮（continue）开头再加一条 goal_reminder
轮内（每一步）:
  10. assistant / tool 往返；运行中到达的新唤醒在两步之间作为新的 <wake> 注入；
      第 MAX_ROUNDS-4 步插入收尾 nudge，每 8 步插入 goal_reminder
```

1、2 两块保持字节稳定以命中 DeepSeek 前缀缓存：会变的东西（成员、说明、工具清单、时间、记忆）都放到 3 之后。

### 2.0 上下文预算（`runtime/budget.ts`）

按估算 token 计（中日韩字符 ≈ 1 token/字，其他 ≈ 3.5 字符/token）。默认窗口 128K（`AGENT_CONTEXT_TOKENS`），预留 16K 给输出（`AGENT_OUTPUT_RESERVE_TOKENS`），剩下的 112K 是整条 prompt（system + 工具定义 + 历史 + 本轮）的上限：

| 块                  | 上限                                  | 超出时                                                                                                                                                                              |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<memory>`          | min(6000, 6% × prompt) token          | 方案各段按比例封顶（正式方案 30%、团队依据 20%、个人记忆 10%、探索副本 5%），正式方案截断并提示看页面；MEMORY.md 最多占一半且不超过剩余；其余文件按优先级放到预算用完，其余只列数量 |
| `<context-summary>` | 3000 字（压缩 prompt 里写的同一个数） | 截断                                                                                                                                                                                |
| 本轮 `<wake>`       | 15% × prompt                          | 截断，提示用 read_thread / read_message 读原文                                                                                                                                      |
| 历史                | prompt − system − 工具定义 − 本轮唤醒 | 压缩：旧 turn 并入摘要，按大小保留最近 0~2 个 turn                                                                                                                                  |
| 轮内工具往返        | 整条 prompt ≤ 上限                    | 较早的工具输出换成「[已省略较早的工具输出 N 字，需要时重新调用]」，最近 4 条原样保留                                                                                                |
| 单条工具结果        | 12000 字                              | 截断                                                                                                                                                                                |

压缩：转录超过一块（min(60K, 50% × prompt) token）时分块依次并入，每块都带上一块的摘要，不会静默丢掉中间的内容。压缩的模型调用失败时记日志，本轮只带放得下的最近几个 turn（不改库，下一轮再试压缩）。

report 生成器：`report.md`（system）→ 一条 user 消息，包含 `<project-records>` 包裹的分节 Markdown 项目记录。不加载 shared-protocol.md。

### 2.1 session-context 模板（服务器生成）

```
<session-context nonce="{{nonce}}">
项目：{{project_name}}
项目说明：{{instructions}}
成员：
{{members}}            每行：姓名（角色：owner/advisor/member/guest）
本次请求人：{{requester}}
当前线程：{{thread_title}}（为 {{working_for}}）      仅 thread
主人：{{owner_name}}                                   仅 personal
本轮可用的工具：{{tool_list}}
当前时间：{{now}}
</session-context nonce="{{nonce}}">
```

nonce 每个会话随机生成；正文中任何 `<` `>` 都要转义，确保只有这一块是真的。

### 2.2 memory 块

```
<memory>
{{memory}}             MEMORY.md
                       ## 正式方案：标题（vN）+ 说明 + 正文要点（超出截断，提示去「方案与依据」页面看全文）
                       ## 团队依据：status=active / needs_review 的条目，[类型] 标题（适用条件：…；依据方案 vN）+ 正文
                       ## 探索副本：status=active，每条前缀「探索中，非正式结论」，只给标题 / 建立者 / 分叉版本 / 说明
                       ## <成员>的个人工作记忆：只在有 actorUserId 且他仍是项目成员时出现，只取他本人的
                       然后每个选中文件：路径、description、type、version、前 4KB 正文
</memory>
```

整块不超过记忆预算（2.0）。`renderMemory(ctx, projectId, { budgetTokens, actorUserId })`：actorUserId = 本次请求人 → 个人会话主人 → 线程的 working_for_user_id，依次取第一个非空的；只用它挑个人工作记忆，没有就不注入任何人的个人记忆。方案各段有比例上限且只按实际用量扣，剩下的给 MEMORY.md 和记忆文件；放不下的条目只列“另有 N 条未展开”。agent 目前没有读方案 / 依据 / 个人记忆的工具，所以提示只指向「方案与依据」页面，不写工具名。

## 3. 模板变量

| 变量                                  | 用在                    | 含义                                                                                                                          |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `{{project_name}}`                    | 全部                    | 项目显示名（用户设定的文本，转义后插入）                                                                                      |
| `{{now}}`                             | report、session-context | 当前时间，ISO 8601 带时区，如 `2026-10-26T17:30:00+08:00`                                                                     |
| `{{tool_list}}`                       | session-context         | 本会话实际可用的工具名，逗号分隔。web_search / paper_search / fetch_url 只有启用联网时才出现；prompt 依赖这个列表判断能否联网 |
| `{{thread_title}}`                    | thread / personal       | 线程或个人会话标题                                                                                                            |
| `{{working_for}}`                     | thread                  | 线程为之工作的成员姓名（working_for_user_id 的显示名）                                                                        |
| `{{owner_name}}`                      | personal                | 个人工作区主人姓名                                                                                                            |
| `{{members}}`                         | session-context         | 成员列表，每行“姓名（角色）”                                                                                                  |
| `{{instructions}}`                    | session-context、report | 项目说明；report 中为请求人对汇报的要求（draft_report 的 instructions 参数，可为空）                                          |
| `{{requester}}`                       | session-context         | 本轮触发消息的作者                                                                                                            |
| `{{memory}}`                          | memory 块               | 见 2.2                                                                                                                        |
| `{{nonce}}`                           | session-context         | 随机串                                                                                                                        |
| `{{period_start}}` / `{{period_end}}` | report                  | 汇报时间段，`YYYY-MM-DD`                                                                                                      |

替换用简单的 `{{name}}` 字符串替换即可；未提供的变量替换为空串，不要把 `{{…}}` 原样留给模型。

## 4. 修改规则

1. **保持中文**。新增内容用中文写；工具名、参数名、枚举值（exclusive、doc_section、lgtm……）保持英文，和 `apps/server/src/agents/tools` 的定义完全一致。
2. **工具名同步**。增删或改名一个工具时，同时修改：本目录里所有提到它的文件、`{{tool_list}}` 的生成逻辑。prompt 里提到但未实现的工具，模型会去调用并失败。
3. **UI 术语固定**：协调者、线程、我的工作区、旁聊、项目记忆、认领、冲突预警、审阅、LGTM、实验记录、组会汇报、看板、待办、待我处理。与 STYLE.md 第 7 节一致，不要换同义词。
4. **共享规则只写一处**。对所有角色成立的规则放 shared-protocol.md，角色文件只写本角色特有的做法，引用时写“共享协议第 N 节”。改了节号要同步引用处。
5. **示例要真实**：例子里的回复必须本身符合规则（不带感叹号、不给时间估计、带链接）。坏例子要写明“错在哪”。
6. **改动后回归**：至少用分诊示例（coordinator.md 第 15 节）的 5 条消息、一个文献调研线程、一个认领冲突场景跑一遍，检查回执、清单格式、认领顺序。
7. 版本号：每次修改递增文件头部版本（v1 → v1.1 小改，v2 行为变化），并在下方记录。

## 5. 变更记录

- v1（2026-10-26）：首版。协议参照 Claude Projects 的协调者/线程机制，加入认领与冲突预警、计划审阅关口、组会汇报、个人工作区转发、科研诚信规则。
- v1.1（2026-10-26）：与 `apps/server/src/agents/tools` 的实现对齐（ARCHITECTURE.md §7.5 逐条确认）。shared-protocol：新增 reason `assignment`、`thread-activity`（`delivery="fyi"` 只为知情）与信封里的其他元素；memory_write 新文件 `base_version=0`；写入守卫覆盖 edit_document / update_experiment / update_card / 覆盖已有文件的 write_file，`replace_text` 需要整篇认领；web_search 只检索 arXiv。thread：补 `update_card`、`set_cells` / 幻灯片操作、assignment 处理。coordinator：转发卡片的实际结构（`<forward-card>`）、thread-activity 与 send_to_coordinator 备注的处理。
- v1.2（2026-10-26）：联网搜索。web_search 改为通用网页搜索（自托管 SearXNG），新增 paper_search（OpenAlex / Semantic Scholar / Crossref / arXiv），fetch_url 抽取正文并支持 PDF 与续读；shared-protocol 第 10 节第 6 条、thread 5.1 节随之更新。
- v2（2026-10-28）：跨方法研究记录。共享协议一次定义方法选择、来源版本与 AI 边界；线程采用 research_list/read/create/update/log/snapshot/excerpt/code/finding/export，旧计算实验能力保留为适用流程；协调者分诊、个人边界和五个示例保持。汇报改为证据导向，并标明覆盖限制。方法技能按任务加载，profile 不等同研究方法；工具参数以实际 schema 为准。
- v2.1（2026-10-28）：按研究工具最终契约补先认领后创建记录与来源的顺序；汇报输入说明与实际分节 Markdown 上下文一致，保留 AI 与成员的归属区分。
- v2.2（2026-10-28）：明确每条记录只绑定一种方法和模板版本，跨方法研究用记录间资源引用组合。
- v2.3（2026-10-28）：线程与汇报区分步骤完成报告和独立核验，保留报告者、来源和实体操作的证据边界。
- v2.4（2026-10-28）：协调者分诊示例在派出文献调研线程前，先向请求人说明 §3 的认领冲突及先处理 §2 的范围。

- v2.5（2026-10-28）：衔接个人／团队空间，研究对象只直接关联团队资料，禁止用快照或复制绕过个人权限；原件转个人后保留旧共享快照。

- v2.6（2026-10-28）：以选定研究内容和材料为上下文，新增 research_workspace，普通关系不触发执行，人工检查由成员确认；保留旧模板、认领、模型选择和证据边界。

- v2.7（2026-10-28）：研究空间成为唯一正常入口；AI 创建改用 research_workspace.workspace_create，模板与旧字段仅作历史兼容。常驻上下文及汇报不再引导模板选择，资料、摘录、编码和结论按任务使用。

- v2.8（2026-10-28）：研究空间追加混合草稿、协作表格、图表与具名数据流；要求完整结构化读取、实际计算和固定产物引用，保留人工确认与来源边界。

- v2.9（2026-10-30）：上下文与读图。`{{tool_list}}` / `{{now}}` 移出角色文件（coordinator / thread / personal 删掉对应两行，改为“见 session-context”），只在 session-context 里出现，1、2 两块字节稳定；§2 改写为实际组装顺序并新增 §2.0 上下文预算（memory / 摘要 / 唤醒上限、按整条 prompt 触发压缩、轮内省略较早工具输出、goal_reminder 随历史重放）。新增 view_image（所有角色）：共享协议 §3.1 说明图片附件、项目图片、notebook 输出图、论文图都用它看，mode=ocr 只是文字识别，要如实告诉成员；thread 精读步骤提到图表用 view_image。

- v2.10（2026-10-31）：方案与依据进入上下文。`<memory>` 新增正式方案（版本号 + 要点，超出截断并提示看页面）、团队依据（类型 + 适用条件，待复核单独标出）、探索副本（逐条标「探索中，非正式结论」）、本轮成员自己的个人工作记忆（不注入其他成员的）；共享协议 §4 说明各段的读法，§5 把这几段列为不可信数据。

- v2.11（2026-10-31）：矢量图可读。view_image 的论文引用支持 `/page`、`/region:x0,y0,x1,y1`，没有嵌入位图的页自动整页渲染（pdf.js + @napi-rs/canvas）；共享协议 §3.1 与 library_read 提示同步。

- v2.13（2026-11-01）：移除实验及云电脑工具；计算过程统一写入研究空间，Notebook 独立保留并核对真实输出，更新五条分诊示例及汇报来源说明。

## 6. 实现对照（运行时 `apps/server/src/agents/runtime`）

- 角色文件不再有 `{{now}}` / `{{tool_list}}`；真实时间和工具清单只放 session-context，保证 1、2 两块字节稳定、命中 DeepSeek 前缀缓存。
- `{{tool_list}}` = 本会话角色可用、且条件满足的工具名（协作端口未注册时文档/看板/待办/审阅/汇报类工具不出现；`AGENT_WEB=true`（或旧名 `AGENT_FETCH_URL=true`）时才有 web_search / paper_search / fetch_url，coordinator、线程、个人 agent 都有）。
- `<memory>`：MEMORY.md + 方案与依据各段（见 2.2）+ 最多 6 个文件（user/feedback 类优先，其次最近更新），各取前 4KB，整块不超过记忆预算。
- view_image 的引用格式：项目文件路径或 file id；`notebook:<notebookId>#cell<i>/out<j>`（0 起，notebook 输出摘要里给出）；`paper:<paperId>#p<页>[/img<k>|/page|/region:x0,y0,x1,y1]`（library_read 的图表行给出，默认取该页最大的嵌入位图；没有嵌入位图的页自动整页渲染；/page 整页渲染，/region 按 0~1 页面比例裁一块高分辨率渲染）；成员消息附件用 message_file_id。配置 `VISION_MODEL=<providerId>/<model>` 时交给视觉模型，否则 OCR（chi_sim+eng）。
- 线程消息里的成员原话由服务器从库里逐字取出、转义后放进 `<cited author="user">`；协调者只传 id（context_message_ids）。
- turn 没有任何对外可见的工具调用就想结束时，运行时插入一次 `<system-note>` 提醒；仍不调用则结束本轮。

### v2.13 · 2026-11-01

研究空间新增统一 AI 处理约定：新行动显式自动配置、旧行动不升级、仅组合既有工具、保留模型及具名输出约束、澄清与人工确认分开。专用规划提示位于 research/processing.ts，按真实共享 schema 输出内部方案；常驻会话不承担内部计算。
