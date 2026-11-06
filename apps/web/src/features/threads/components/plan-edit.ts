import { parseChecklist, type ChecklistMark } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 计划编辑的纯函数：状态清单原文 ⇄ 可编辑的草稿。
 * 原文格式同 agent 的 update_status：第 1 行目标，之后每行 ✓ / ✱ / ○ 开头。
 */

export interface PlanDraftStep {
  /** 只在编辑器里用的稳定 key */
  key: string;
  mark: ChecklistMark;
  text: string;
}

export interface PlanDraft {
  goal: string;
  steps: PlanDraftStep[];
}

/** 服务端上限（ThreadUpdateInput.statusText） */
export const PLAN_MAX_CHARS = 4000;

const MARK_CHAR: Record<ChecklistMark, string> = { done: '✓', active: '✱', todo: '○' };

/** 点一下切到下一个状态：未开始 → 进行中 → 已完成 → 未开始 */
export const NEXT_MARK: Record<ChecklistMark, ChecklistMark> = {
  todo: 'active',
  active: 'done',
  done: 'todo',
};

export const MARK_LABEL: Record<ChecklistMark, string> = {
  todo: tr('未开始'),
  active: tr('进行中'),
  done: tr('已完成'),
};

let seq = 0;
export function newStepKey(): string {
  seq += 1;
  return `s${seq}`;
}

export function draftFromText(text: string): PlanDraft {
  const list = parseChecklist(text);
  return {
    goal: list.title,
    steps: list.lines.map((l) => ({ key: newStepKey(), mark: l.mark, text: l.text })),
  };
}

/** 草稿 → 原文：去掉空步骤，单行化；目标为空时第 1 行留空（parseChecklist 照样能读）。 */
export function draftToText(draft: PlanDraft): string {
  const oneLine = (s: string) => s.replace(/\s*\n\s*/gu, ' ').trim();
  const rows = draft.steps
    .map((s) => ({ mark: s.mark, text: oneLine(s.text) }))
    .filter((s) => s.text)
    .map((s) => `${MARK_CHAR[s.mark]} ${s.text}`);
  return [oneLine(draft.goal), ...rows].join('\n');
}

export function moveStep(steps: PlanDraftStep[], index: number, delta: -1 | 1): PlanDraftStep[] {
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = steps.slice();
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

export function insertStep(steps: PlanDraftStep[], at: number): PlanDraftStep[] {
  const next = steps.slice();
  next.splice(Math.max(0, Math.min(at, steps.length)), 0, {
    key: newStepKey(),
    mark: 'todo',
    text: '',
  });
  return next;
}

export function removeStep(steps: PlanDraftStep[], index: number): PlanDraftStep[] {
  return steps.filter((_, i) => i !== index);
}

/** 两份原文是不是同一个计划（忽略空行和首尾空白、加粗高亮） */
export function samePlan(a: string, b: string): boolean {
  return draftToText(draftFromText(a)) === draftToText(draftFromText(b));
}
