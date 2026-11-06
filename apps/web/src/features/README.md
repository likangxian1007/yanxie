# features · 功能模块与归属

每个功能一个目录，**只通过自己的 `routes.tsx` 注册页面**（导出 `RouteObject[]`，路径相对 `/p/:projectId`，
每条路由带 `handle: { title: '中文标题' }`，顶栏面包屑和 `document.title` 会读它）。
[`app/router.tsx`](../app/router.tsx) 已经汇总了下表所有功能的路由——**功能线程不要改 router.tsx**，
新增页面只改自己目录下的 `routes.tsx`。

| 目录           | 功能                                                                | 路由                           | 归属         |
| -------------- | ------------------------------------------------------------------- | ------------------------------ | ------------ |
| `coordinator/` | 协作台（项目首页、共用协调者、时间线、Composer）                    | index                          | 前端线程     |
| `workspace/`   | 我的工作区（私人会话，转发给协调者）                                | `workspace`                    | 前端线程     |
| `threads/`     | 线程列表与详情、ThreadCard、ChecklistView                           | `threads`、`threads/:threadId` | 前端线程     |
| `inbox/`       | 待我处理                                                            | `inbox`                        | 前端线程     |
| `settings/`    | 设置（项目、成员、记忆、外观）                                      | `settings`                     | 前端线程     |
| `harness/`     | 斜杠指令、模型 / 强度 / profile 选择（无页面，`index.ts` 导出组件） | —                              | harness 线程 |
| `docs/`        | 协同文档                                                            | `docs`、`docs/:docId`          | 协作功能线程 |
| `board/`       | 看板                                                                | `board`                        | 协作功能线程 |
| `todos/`       | 待办                                                                | `todos`                        | 协作功能线程 |
| `reviews/`     | 审阅 / LGTM                                                         | `reviews`、`reviews/:reviewId` | 协作功能线程 |
| `reports/`     | 组会汇报                                                            | `reports`、`reports/:reportId` | 协作功能线程 |
| `plans/`       | 方案与依据：正式方案、探索副本、提案、团队依据、个人记忆            | `plans`                        | 协作功能线程 |

外壳与基础组件（`components/layout/`、`components/ui/`、`lib/`、`styles/`、`app/`）归 **前端线程**。

## 目录约定

```
features/<x>/
  routes.tsx        # 只导出 RouteObject[]（不在这里定义组件）
  pages/            # 路由页面组件
  components/       # 只在本功能里用的组件；跨功能复用的提升到 components/ui
  ...               # hooks、api、demo 数据等
```

- 页面骨架用 `components/layout/Page`（`Page` + `PageHeader`），还没实现的页面用 `PlaceholderPage`。
- 每个页面都要有空状态、加载状态、错误状态（中文文案，见 STYLE.md §7）。
- 跨功能 import 只允许引用别的功能明确导出的组件，避免循环依赖；拿不准就提升到 `components/`。

任务入口由 `tasks/` 组合看板与待办视图；研究资料由研究空间入口承载。实验与云电脑已移除，旧链接只显示退役说明。
