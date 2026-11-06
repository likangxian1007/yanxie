import { isAgentAssignee, type Card } from '@srh/shared';

/**
 * 看板筛选：
 * - query：按标题搜索（不区分大小写）
 * - assignee：'' 全部 / 'me' 我的 / 'agents' 指派给 agent / 'none' 未指派 / 具体指派值（成员 id 或 agent:…）
 * - label：'' 全部 / 某个标签
 */
export interface CardFilter {
  query: string;
  assignee: string;
  label: string;
}

export const EMPTY_FILTER: CardFilter = { query: '', assignee: '', label: '' };

export function isFilterActive(f: CardFilter): boolean {
  return Boolean(f.query.trim() || f.assignee || f.label);
}

export function matchesCardFilter(card: Card, f: CardFilter, meId: string | null): boolean {
  const q = f.query.trim().toLowerCase();
  if (q && !card.title.toLowerCase().includes(q)) return false;
  if (f.label && !card.labels.includes(f.label)) return false;
  switch (f.assignee) {
    case '':
      return true;
    case 'me':
      return meId !== null && card.assigneeIds.includes(meId);
    case 'agents':
      return card.assigneeIds.some(isAgentAssignee);
    case 'none':
      return card.assigneeIds.length === 0;
    default:
      return card.assigneeIds.includes(f.assignee);
  }
}

export function filterCards(cards: readonly Card[], f: CardFilter, meId: string | null): Card[] {
  if (!isFilterActive(f)) return [...cards];
  return cards.filter((c) => matchesCardFilter(c, f, meId));
}

/** 看板上出现过的标签：用得多的在前，同样多按名字 */
export function collectLabels(cards: readonly Card[]): string[] {
  const count = new Map<string, number>();
  for (const card of cards) {
    for (const label of card.labels) count.set(label, (count.get(label) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([label]) => label);
}

/** 规整一个新标签：去空白、截到 20 字；空串返回 null */
export function normalizeLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/gu, ' ').slice(0, 20);
  return label || null;
}

export function hasAgentAssignee(card: Pick<Card, 'assigneeIds'>): boolean {
  return card.assigneeIds.some(isAgentAssignee);
}
