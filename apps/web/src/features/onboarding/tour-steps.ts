import type { ProjectRole } from '@srh/shared';
import { BASE } from '@/lib/base-path';
import type { TourVariant } from './storage';
import { tr } from '@/lib/i18n';

/**
 * 新手引导的步骤。目标元素一律用现有的 DOM 特征（侧栏链接的 href、输入框的 placeholder、
 * 顶栏按钮的 aria-label）去找，不在别的功能组件里加钩子。
 * 找不到或看不见（手机上侧栏在抽屉里、面板收起）时按顺序试 fallbacks，最后退回居中卡片 + hint。
 */

export interface TargetSpec {
  /** CSS 选择器；`{pid}` 会换成当前课题 id */
  selector: string;
  /** 高亮命中元素的某个祖先（例如输入框所在的整张卡片） */
  closest?: string;
}

export type StepIcon =
  | 'coordinator'
  | 'threads'
  | 'workspace'
  | 'docs'
  | 'reviews'
  | 'reports'
  | 'inbox'
  | 'search'
  | 'phone';

export interface TourStep {
  id: string;
  icon: StepIcon;
  title: string;
  /** 1–3 句 */
  body: string;
  targets: TargetSpec[];
  /** 目标不可见时退而高亮的元素（例如手机上的“打开导航”按钮） */
  fallbacks?: TargetSpec[];
  /** 没找到原目标时补一句“它在哪” */
  where?: string;
  /** 触屏设备（手机、平板）上换掉的文案：不讲键盘快捷键，改说点哪里 */
  touch?: Partial<Pick<TourStep, 'title' | 'body' | 'where'>>;
}

/** 按设备取这一步的文案：触屏上用 touch 里的说法 */
export function localizeStep(step: TourStep, touch: boolean): TourStep {
  return touch && step.touch ? { ...step, ...step.touch } : step;
}

const nav = (to: string): TargetSpec => ({
  selector: `nav[aria-label="${tr('主导航')}"] a[href="${BASE}/p/{pid}${to ? `/${to}` : ''}"]`,
});

/** 手机底部标签栏（协作台 · 线程 · 待我处理 · 审阅 · 更多）；桌面上它是 display:none，自然跳过 */
const tab = (to: string): TargetSpec => ({
  selector: `nav[aria-label="${tr('底部导航')}"] a[href="${BASE}/p/{pid}${to ? `/${to}` : ''}"]`,
});

const MORE: TargetSpec = {
  selector: `nav[aria-label="${tr('底部导航')}"] button[aria-label^="${tr('更多')}"]`,
};

const MENU: TargetSpec = { selector: `header button[aria-label="${tr('打开导航')}"]` };

const tabWhere = (label: string) => tr('在底部标签栏里点「{label}」。', { label });

const navWhere = (label: string) => tr('点底部的「更多」，再点「{label}」就能打开。', { label });

const COMPOSER: TargetSpec = {
  selector: `#main-content textarea[placeholder="${tr('向协调者描述需求…')}"]`,
  closest: 'form',
};

const SEARCH: TargetSpec = { selector: `header button[aria-label^="${tr('搜索与命令')}"]` };

/** 手机顶栏没有铃铛，待我处理在底部标签栏里 */
const TOUCH_INBOX_WHERE = tr('在底部标签栏里点「待我处理」，有新事项时会显示数字。');
const BELL: TargetSpec = { selector: `header button[aria-label^="${tr('待我处理')}"]` };

// ---------------------------------------------------------------- 成员

const MEMBER_STEPS: TourStep[] = [
  {
    id: 'coordinator',
    icon: 'coordinator',
    title: tr('协作台：从一个需求开始'),
    body: tr(
      '整个课题共用一个协调者。在这里写清目标和约束，它会把需求拆成几个线程，分给 agent 并行去做。',
    ),
    targets: [COMPOSER, nav(''), tab('')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('协作台')),
  },
  {
    id: 'threads',
    icon: 'threads',
    title: tr('线程：每件事的进度和产出'),
    body: tr(
      '每个线程是一项具体工作。点进去能看到进度清单（✓ 已完成、✱ 进行中、○ 未开始），产出的文档、代码和图表也挂在这里。',
    ),
    targets: [nav('threads'), tab('threads')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('线程')),
  },
  {
    id: 'workspace',
    icon: 'workspace',
    title: tr('我的工作区：先自己想清楚'),
    body: tr('只属于你的私人会话，别人看不到。适合查文献、试思路，想让团队接手时一键转给协调者。'),
    targets: [nav('workspace')],
    fallbacks: [MORE, MENU],
    where: navWhere(tr('我的工作区')),
  },
  {
    id: 'docs',
    icon: 'docs',
    title: tr('文档：多人实时一起写'),
    body: tr(
      '富文本、表格、幻灯片和 LaTeX 论文都在这里，成员和 agent 可以同时编辑。agent 改动前会先认领段落，和你撞车时会出冲突预警。',
    ),
    targets: [nav('docs')],
    fallbacks: [MORE, MENU],
    where: navWhere(tr('文档')),
  },
  {
    id: 'reviews',
    icon: 'reviews',
    title: tr('审阅：请人把关'),
    body: tr(
      '文档、研究空间或计划写好后点「请求审阅」。审阅人逐条评论，最后给 LGTM 或要求修改，结论会回到原来的线程。',
    ),
    targets: [nav('reviews'), tab('reviews')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('审阅')),
  },
  {
    id: 'reports',
    icon: 'reports',
    title: tr('组会汇报：从上下文里生成'),
    body: tr(
      '选一个时间段，协调者会把这期间的线程、研究空间、审阅和文档改动整理成汇报草稿，你改完就能讲。',
    ),
    targets: [nav('reports')],
    fallbacks: [MORE, MENU],
    where: navWhere(tr('组会汇报')),
  },
  {
    id: 'inbox',
    icon: 'inbox',
    title: tr('待我处理'),
    body: tr(
      '需要你拍板的决策、请你审阅的内容、@你的消息和冲突预警都集中在这里，处理完就从列表里消失。',
    ),
    targets: [nav('inbox'), BELL, tab('inbox')],
    fallbacks: [MORE, MENU],
    where: tr('右上角的铃铛也能打开它。'),
    touch: { where: TOUCH_INBOX_WHERE },
  },
  {
    id: 'search',
    icon: 'search',
    title: tr('⌘K：随时搜索和跳转'),
    body: tr(
      '按 ⌘K（Windows 上是 Ctrl K）打开命令面板，可以搜线程、文档和成员，也能直接跳到任何页面。按 ? 打开帮助中心。',
    ),
    targets: [SEARCH],
    where: tr('在右上角的放大镜里。'),
    touch: {
      title: tr('搜索：随时找东西、跳页面'),
      body: tr(
        '点顶部的放大镜打开搜索，可以搜线程、文档和成员，也能直接跳到常用页面。用法说明在「更多」里的帮助中心。',
      ),
    },
  },
];

// ---------------------------------------------------------------- 导师

const ADVISOR_STEPS: TourStep[] = [
  {
    id: 'coordinator',
    icon: 'coordinator',
    title: tr('协作台：学生的计划都在这'),
    body: tr(
      '学生在这里向协调者提需求、讨论方案。往上翻就是整个课题的来龙去脉，你也可以直接在这里提意见。',
    ),
    targets: [nav(''), COMPOSER, tab('')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('协作台')),
  },
  {
    id: 'threads',
    icon: 'threads',
    title: tr('线程：做到哪一步了'),
    body: tr(
      '每个线程一项工作。状态点看整体，点进去的进度清单写着完成了什么、卡在哪里、产出了什么。',
    ),
    targets: [nav('threads'), tab('threads')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('线程')),
  },
  {
    id: 'inbox',
    icon: 'inbox',
    title: tr('待我处理：等你拍板的事'),
    body: tr(
      '学生请你审阅的内容、需要你做决定的问题、@你的消息都会出现在这里。平时只看这一页就不会漏。',
    ),
    targets: [nav('inbox'), BELL, tab('inbox')],
    fallbacks: [MORE, MENU],
    where: tr('右上角的铃铛也能打开它。'),
    touch: { where: TOUCH_INBOX_WHERE },
  },
  {
    id: 'reviews',
    icon: 'reviews',
    title: tr('审阅：给 LGTM 或要求修改'),
    body: tr(
      '打开一条审阅，在「你的结论」卡片里点 LGTM 表示通过，或点「要求修改」并写一句原因。结论会回到对应的线程里。',
    ),
    targets: [nav('reviews'), tab('reviews')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('审阅')),
  },
  {
    id: 'reports',
    icon: 'reports',
    title: tr('组会汇报'),
    body: tr(
      '组会前学生会在这里生成汇报，内容来自这段时间的线程、研究空间和审阅。你可以提前看，学生请你审阅时也能逐条评论。',
    ),
    targets: [nav('reports')],
    fallbacks: [MORE, MENU],
    where: navWhere(tr('组会汇报')),
  },
  {
    id: 'phone',
    icon: 'phone',
    title: tr('手机上也能看'),
    body: tr(
      '用手机浏览器打开同一个地址就行，不用装 App。底部标签栏切换页面，审阅和待我处理都能在手机上完成。',
    ),
    targets: [],
  },
];

// ---------------------------------------------------------------- 访客

const GUEST_STEPS: TourStep[] = [
  {
    id: 'coordinator',
    icon: 'coordinator',
    title: tr('协作台'),
    body: tr('课题的讨论和计划都在这里。你是访客，可以查看全部内容，但不能发言或编辑。'),
    targets: [nav(''), COMPOSER, tab('')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('协作台')),
  },
  {
    id: 'threads',
    icon: 'threads',
    title: tr('线程'),
    body: tr('每项工作的进度清单和产出都在线程里，点进去就能看到做到哪一步。'),
    targets: [nav('threads'), tab('threads')],
    fallbacks: [MORE, MENU],
    where: tabWhere(tr('线程')),
  },
  {
    id: 'docs',
    icon: 'docs',
    title: tr('文档与研究空间'),
    body: tr(
      '文档、研究空间记录和组会汇报都可以打开阅读。需要参与编辑时，请课题负责人把你的角色改成成员。',
    ),
    targets: [nav('docs')],
    fallbacks: [MORE, MENU],
    where: navWhere(tr('文档')),
  },
  {
    id: 'search',
    icon: 'search',
    title: tr('⌘K 搜索'),
    body: tr('按 ⌘K（Windows 上是 Ctrl K）可以搜线程、文档和成员。按 ? 打开帮助中心。'),
    targets: [SEARCH],
    where: tr('在右上角的放大镜里。'),
    touch: {
      title: tr('搜索'),
      body: tr('点顶部的放大镜，可以搜线程、文档和成员。用法说明在「更多」里的帮助中心。'),
    },
  },
];

export const TOUR_STEPS: Record<TourVariant, TourStep[]> = {
  member: MEMBER_STEPS,
  advisor: ADVISOR_STEPS,
  guest: GUEST_STEPS,
};

export const VARIANT_LABEL: Record<TourVariant, string> = {
  member: tr('成员版'),
  advisor: tr('导师版'),
  guest: tr('访客版'),
};

/** 角色 → 引导版本：负责人和成员看完整版，导师看精简的“看进展 + 拍板”版，访客看只读版。 */
export function tourVariantForRole(role: ProjectRole | null | undefined): TourVariant {
  if (role === 'advisor') return 'advisor';
  if (role === 'guest') return 'guest';
  return 'member';
}

export function stepsFor(variant: TourVariant): TourStep[] {
  return TOUR_STEPS[variant];
}

/** 把记录里的步数夹到有效范围 */
export function clampStep(variant: TourVariant, step: number): number {
  const n = TOUR_STEPS[variant].length;
  if (!Number.isFinite(step)) return 0;
  return Math.min(Math.max(0, Math.floor(step)), n - 1);
}
