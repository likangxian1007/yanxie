import type { ParsedChecklist } from '@srh/shared';
import { tr } from '@/lib/i18n';

export interface PlanSummary {
  /** 步骤总数 */
  total: number;
  /** 已完成的步数 */
  done: number;
  /** 当前一步的序号（从 1 开始）；全部完成时为 null */
  current: number | null;
  /** 「第 3 步，共 7 步」/「7 步全部完成」 */
  label: string;
}

/** 计划的进度摘要：当前一步 = 第一个 ✱；没有 ✱ 时取第一个未完成的步骤。 */
export function summarizePlan(list: ParsedChecklist): PlanSummary {
  const total = list.lines.length;
  const done = list.lines.filter((l) => l.mark === 'done').length;
  let idx = list.lines.findIndex((l) => l.mark === 'active');
  if (idx === -1) idx = list.lines.findIndex((l) => l.mark !== 'done');
  const current = idx === -1 ? null : idx + 1;
  const label =
    total === 0
      ? tr('还没有步骤')
      : current === null
        ? tr('{total} 步全部完成', { total })
        : tr('第 {current} 步，共 {total} 步', { current, total });
  return { total, done, current, label };
}
