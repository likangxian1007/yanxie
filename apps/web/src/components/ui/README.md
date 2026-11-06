# components/ui · 基础组件

全站共用的基础组件。规范见仓库根目录 [`STYLE.md`](../../../../../STYLE.md) §6；令牌见 [`styles/tokens.css`](../../styles/tokens.css)。

**规则：新的共享组件放在这里；只服务于某个功能的组件留在 `features/<x>/components/`。**
新增变体先改这里的组件，不要在页面里覆写样式。

约定：

- 一个组件一个文件，用 `forwardRef` 透传 ref，用 `cn()`（`@/lib/cn`）合并类名。
- 只用语义色类（`bg-surface`、`text-fg-muted`、`border-line` …），不写 `#hex` / Tailwind 默认色。
- 动效从 `@/lib/motion` 取（`useMotionPreset()` 已处理“减少动态效果”）。
- 图标用 `lucide-react`，UI 内 16px、导航 18px、空状态 20px，`strokeWidth={1.75}`。
- 从桶文件导入：`import { Button, EmptyState } from '@/components/ui'`。

| 组件            | 文件                | 说明                                                                                                 |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `Button`        | `Button.tsx`        | 变体 primary / secondary / ghost / subtle / danger；尺寸 sm 28 / md 32 / lg 40；`loading` 时宽度不变 |
| `IconButton`    | `IconButton.tsx`    | 方形 28/32/36，必填 `label`（aria-label + Tooltip），可带 `shortcut`                                 |
| `Input`         | `Input.tsx`         | 高 32（sm 28 / lg 40），focus accent 描边 + 3px ring；`error` 显示红字；`leading` / `trailing` 插槽  |
| `Textarea`      | `Textarea.tsx`      | 同 Input 外观；`autoGrow` 自动增高到 40vh                                                            |
| `Card`          | `Card.tsx`          | surface + 发丝描边 + rounded-lg；`interactive` 时 hover 上浮 1px + shadow-md                         |
| `Badge`         | `Badge.tsx`         | 高 20 药丸；`tone` 语义色或 `color` 色板序号；`animateKey` 计数变化时弹一下                          |
| `StatusDot`     | `StatusDot.tsx`     | 8px 线程状态点；working 呼吸光环，failed 轻抖一次；自带读屏文案                                      |
| `Avatar`        | `Avatar.tsx`        | 20/24/32/40；人类色板实心 + 首字；agent 渐变 + sparkle；协调者白色内描边                             |
| `AvatarStack`   | `AvatarStack.tsx`   | 重叠 -6px，悬停展开到 4px 并列出“正在看 / 正在编辑”                                                  |
| `Tooltip`       | `Tooltip.tsx`       | bg-fg 反色小浮层，400ms 延迟，渲染到 body，不被滚动容器裁切                                          |
| `Kbd`           | `Kbd.tsx`           | 键盘按键                                                                                             |
| `Skeleton`      | `Skeleton.tsx`      | bg-subtle + 扫光                                                                                     |
| `EmptyState`    | `EmptyState.tsx`    | 48px 图标圈 → H3 → 描述 → 主按钮；`framed` 页面级虚线框                                              |
| `Spinner`       | `Spinner.tsx`       | 旋转加载图标；传 `label` 时作为独立状态朗读                                                          |
| `AgentThinking` | `AgentThinking.tsx` | agent 渐变扫光文字 + 三点起伏                                                                        |
| `Separator`     | `Separator.tsx`     | 1px 发丝分隔线，横 / 竖                                                                              |

`field-styles.ts` 是 Input / Textarea（以及以后的 Select）共用的样式常量，不是组件。
