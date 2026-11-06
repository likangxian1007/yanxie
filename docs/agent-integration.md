# 个人 Agent 接入研协

外部 Agent 可以用本人创建的 API 令牌调用 REST 或 MCP，将研协作为个人 workflow 的项目上下文、内容和执行后端。调用权限仍受令牌范围、项目成员角色及资源分享权限约束。项目归档、成员变更、令牌撤销或分享撤回后，应重新检查访问权限。

## 开始使用

管理员启用 `API_TOKENS_ENABLED` 和 `MCP_ENABLED` 后，在网页「设置 → 接入」创建令牌，选择只读或读写以及允许访问的项目。令牌只在创建时展示，交给客户端的密钥管理器；不要写入仓库、日志或消息。REST 使用 `Authorization: Bearer <令牌>`，MCP 地址为 `<站点地址>/api/v1/mcp`，使用同一请求头。请仅通过可信加密连接传输令牌。

示例需要 Node.js 22.12 或更高版本，不安装额外依赖。环境变量由使用者自行安全注入；脚本不会读取 `.env` 或打印令牌：

```bash
node apps/server/scripts/agent-workflow-example.mjs
# 如需选定项目，设置 SRH_PROJECT_ID；否则使用第一个可访问项目。
# 设置 SRH_URL 为站点根地址，SRH_TOKEN 为令牌。
```

默认只发现操作并读取项目；加 `--write` 会创建并完成一条示例待办。再加 `--message` 会在项目时间线发一条示例消息，设置 `agentVisible: false`，不唤醒站内 Agent。示例任务和消息会保留在项目中。

真实 dots 客户端尚未验证，接入前请用其 MCP 客户端配置确认协议兼容性；本说明和示例不会部署服务。

## 发现和调用操作

MCP 保留 `list_projects`、`get_project`、`get_timeline`、`get_thread`、`read_document`、`list_inbox`、`post_message`、`create_todo`、`mark_inbox_done` 九个兼容工具。四个通用工具可发现并调用开放的业务接口：

| 工具                 | 输入和结果                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `list_operations`    | 可按 `domain`、`keyword`、`effect` 过滤；返回 `operations` 和 `nextOffset`，用 `offset` 继续读取。 |
| `describe_operation` | 传 `operationId`，获取路径参数名、query/body schema、响应、权限和运行条件。                        |
| `read_operation`     | 调用读取操作。                                                                                     |
| `write_operation`    | 调用写入或执行操作；只对读写令牌可见。                                                             |

`operationId` 是 HTTP 方法与路径模板的组合，不包含 `/api/v1`，例如 `GET /projects/:projectId`。调用时分别传 `params`、`query`、`body`，需要安全重试时传 `idempotencyKey`；文件导入可用 `transfer`。成功结果为 `{status, data, replayed?, segmented?, continuation?}`。MCP 工具级错误设置 `isError`，通用工具的文本内容为 JSON：`{error:{code,message,details}}`；兼容工具另提供 `structuredContent.error`。客户端应按错误码处理权限、限流和冲突，勿只匹配提示文字。

例如，在初始化 MCP 客户端后，调用 `read_operation` 的参数如下：

```json
{ "operationId": "GET /projects/:projectId", "params": { "projectId": "prj_example" } }
```

REST 机器可读目录是 `GET /api/v1/integrations/operations`。目录的 `path` 给出对应 REST 地址；业务请求和分页规则以 `describe_operation` 为准。只读令牌的 MCP 目录不列出写入操作。凭证、成员权限、项目归档及人工审批等敏感操作需在网页完成。

## 重试、大结果和文件

创建内容、发送消息或启动执行等有副作用的操作，建议传唯一 `idempotencyKey`（8–128 位字母、数字、下划线或短横线）；重试同一操作时使用相同键和完全相同的参数。不同请求复用键会返回冲突。结果未知或仍在处理时，先检查目标状态，避免换键重复执行。REST 可使用 `Idempotency-Key` 请求头。REST 与 MCP 共用令牌的持久每日写入额度，`MCP_WRITE_PER_DAY` 默认 200；读取不消耗写入额度。

通用 MCP 操作结果超过 64 KiB 时，返回 `segmented: true` 和首段 base64 数据。按返回的 `nextOffset` 调用 `GET /integrations/results/:resultId/chunks`，逐段解码并按顺序拼接原始字节，再根据 `mimeType` 解析；默认每段 16 KiB。结果与令牌绑定，最长保留 15 分钟，也可能因缓存容量提前失效；续读仍检查当前权限。

文件可通过目录中的操作分块传输，最大 20 MiB。创建 `POST /integrations/transfers`，提供 `projectId`、目标 `path`、总字节数 `size` 和完整文件 `sha256`；依次调用 `PUT /integrations/transfers/:transferId/chunks`，每块最多 256 KiB，传字节 `offset` 和 `base64`。使用 `POST /integrations/transfers/:transferId/complete` 校验并发布，建议为发布传幂等键。相同偏移和字节的已上传块可重试；不一致时返回冲突。未完成的临时上传闲置 24 小时过期，服务重启后需重新上传。下载通过 `GET /projects/:projectId/files/:fileId/chunks` 循环读取 `nextOffset`，拼接后核对返回的大小与 SHA-256。每次访问均重新检查身份及项目权限。

文档或论文导入也可在通用操作的 `transfer` 中传 base64，或引用本人有权访问的项目文件 `fileId`；使用 `describe_operation` 查询该接口需要的格式。不要把未完成的传输视为已发布的项目文件。

## Notebook 和执行

通过 `GET /projects/:projectId/notebooks/:notebookId/contents` 读取当前 Notebook 内容。返回 `json` 是快照 JSON 的 UTF-16 字符串片段，以及 `contentHash`、`nextOffset`；续读必须携带首次返回的 `contentHash` 和 `offset`，直到 `nextOffset` 为 null，再拼接并解析 JSON。内容在续读期间变化时返回冲突，应从头读取。

`POST /projects/:projectId/notebooks/:notebookId/cells` 接收读取所得 `contentHash` 和 `operations` 数组。操作包括 `insert`（`type`、`source`、可选 `afterCellId`，`start` 表示开头）、`replace`（`cellId`、`source`）、`delete`（`cellId`）。哈希过期返回冲突，重新读取后由客户端决定如何合并；不会自动覆盖其他人的在线编辑。

用既有 `POST /projects/:projectId/notebooks/:notebookId/execute` 启动执行，使用 `/interrupt` 中断；通过 `GET /projects/:projectId/notebooks/:notebookId/execution` 分段读取内核状态、运行队列及单元格输出。执行是否可用取决于服务器内核配置。研究流程或站内 Agent 的运行也应保存返回的运行标识并查询状态、结果；需要人工确认时保持等待状态，通过结果的 `webUrl` 进入网页完成确认；客户端不能代签。

权限发生变化时，暂存的大结果整体失效；重新发现并读取即可。事件补拉请跟随 `continuation.afterSeq`（REST 为 `X-Next-Event-Seq`），不要因一页可见事件为空就判断历史已经读完。未完成上传每用户最多 8 个、声明总量 64 MiB；同路径并发发布返回一个成功和其余冲突，不能覆盖已有文件。
