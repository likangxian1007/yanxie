import {
  BadgeCheck,
  FileText,
  Inbox,
  ListTodo,
  ListTree,
  MessagesSquare,
  Presentation,
  SquareKanban,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { tr } from '@/lib/i18n';

/**
 * 模块页顶部的“这是什么、怎么用”。键是 /p/:projectId 之后的第一段路径（协作台为空串），
 * 只在模块首页出现，详情页（更深的路径）不出现。
 */

export interface ModuleIntro {
  module: string;
  label: string;
  icon: LucideIcon;
  /** 一句话：这是什么 */
  what: string;
  /** 2–3 条：怎么用 */
  how: string[];
  /** 触屏设备上的「怎么用」（不讲键盘快捷键）；不写就和 how 一样 */
  touchHow?: string[];
  /** 帮助中心里对应的锚点 */
  anchor: string;
  /** 和页面内容同宽（Tailwind max-w 类） */
  width: string;
}

const FEED = 'max-w-(--feed-max)';

export const MODULE_INTROS: ModuleIntro[] = [
  {
    module: '',
    label: tr('协作台'),
    icon: MessagesSquare,
    what: tr('全组共用的对话流：你提需求，协调者把它拆成线程，分给 agent 并行去做。'),
    how: [
      tr('写清目标、数据和约束，例如「在 BraTS 上复现 MedSegDiff 的 Dice」'),
      tr('协调者回复计划后，线程卡片挂在原消息下面，点开看进度'),
      tr('只想和同学说的话打开「旁聊」，协调者读不到'),
    ],
    anchor: 'coordinator',
    width: FEED,
  },
  {
    module: 'workspace',
    label: tr('我的工作区'),
    icon: UserRound,
    what: tr('只属于你的私人会话，别人看不到，适合先把思路聊清楚。'),
    how: [
      tr('点「新建会话」，和个人 agent 查文献、写草稿、试想法'),
      tr('想让团队接手时，在会话顶部点「转给协调者」'),
      tr('没转之前，会话内容不会出现在协作台'),
    ],
    anchor: 'workspace',
    width: 'max-w-none',
  },
  {
    module: 'threads',
    label: tr('线程'),
    icon: ListTree,
    what: tr('协调者拆出来的每一项工作都是一个线程，由一个 agent 负责推进。'),
    how: [
      tr('状态点区分进行中、等你处理、待验收和已完成'),
      tr('点进线程看进度清单：✓ 已完成、✱ 进行中、○ 未开始'),
      tr('产出和改动列在线程里，常用的线程可以置顶到侧栏'),
    ],
    anchor: 'threads',
    width: FEED,
  },
  {
    module: 'docs',
    label: tr('文档'),
    icon: FileText,
    what: tr('课题组共用的文档、表格、幻灯片和 LaTeX 论文，成员和 agent 可以同时编辑。'),
    how: [
      tr('新建时选类型；LaTeX 论文可以在线编译预览'),
      tr('能看到谁正在看、谁在改哪一段'),
      tr('agent 改动前会先认领段落，和你的改动重叠时出现冲突预警'),
    ],
    anchor: 'docs',
    width: 'max-w-6xl',
  },
  {
    module: 'board',
    label: tr('看板'),
    icon: SquareKanban,
    what: tr('把工作拆成卡片按列推进，适合排期和分工。'),
    how: [tr('拖动卡片换列，进度一眼可见'), tr('卡片可以指派给成员或 agent，并关联线程与实验')],
    anchor: 'board',
    width: 'max-w-none',
  },
  {
    module: 'todos',
    label: tr('待办'),
    icon: ListTodo,
    what: tr('课题共享待办和你的个人待办放在一起，记下不值得开线程的小事。'),
    how: [
      tr('在顶部输入框直接添加，回车保存'),
      tr('输入时用 !! 标记优先级，用 @ 指派给成员或 agent'),
      tr('指派给 agent 的待办会唤醒它开始做'),
    ],
    anchor: 'todos',
    width: FEED,
  },
  {
    module: 'reviews',
    label: tr('审阅'),
    icon: BadgeCheck,
    what: tr('像 PR 一样请人看文档、研究空间和汇报：逐条评论，最后给 LGTM 或修改意见。'),
    how: [
      tr('在文档、研究空间或汇报页点「请求审阅」并选审阅人'),
      tr('审阅人打开后在「你的结论」里点 LGTM 或「要求修改」'),
      tr('结论会回到对应的线程，全部 LGTM 后状态变为已通过'),
    ],
    anchor: 'reviews',
    width: 'max-w-4xl',
  },
  {
    module: 'reports',
    label: tr('组会汇报'),
    icon: Presentation,
    what: tr('选一个时间段，协调者把这期间的线程、实验、审阅和文档改动整理成汇报草稿。'),
    how: [
      tr('点「生成汇报」，选本周或自定义时间段'),
      tr('在草稿上直接修改，定稿后可以存成协同文档或请导师审阅'),
    ],
    anchor: 'reports',
    width: FEED,
  },
  {
    module: 'inbox',
    label: tr('待我处理'),
    icon: Inbox,
    what: tr('需要你拍板的决策、请你审阅的内容、@你的消息和冲突预警都集中在这里。'),
    how: [
      tr('点一条直接跳到要处理的位置'),
      tr('处理完点对勾标为完成，键盘上按 E 也可以'),
      tr('完成的事项收在「已完成」里，需要时可以移回'),
    ],
    touchHow: [
      tr('点一条直接跳到要处理的位置'),
      tr('处理完点条目右下角的对勾标为完成'),
      tr('完成的事项收在「已完成」里，需要时可以移回'),
    ],
    anchor: 'inbox',
    width: FEED,
  },
];

const BY_MODULE = new Map(MODULE_INTROS.map((m) => [m.module, m]));

/** 按设备取「怎么用」：触屏上不讲键盘快捷键 */
export function introHow(intro: ModuleIntro, touch: boolean): string[] {
  return touch && intro.touchHow ? intro.touchHow : intro.how;
}

/**
 * 从路径找模块介绍：/p/:projectId → 协作台，/p/:projectId/docs → 文档；
 * 详情页（/p/:projectId/docs/xxx）和不认识的路径返回 null。
 */
export function introForPath(pathname: string): ModuleIntro | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'p' || !parts[1]) return null;
  if (parts.length > 3) return null;
  return BY_MODULE.get(parts[2] ?? '') ?? null;
}
