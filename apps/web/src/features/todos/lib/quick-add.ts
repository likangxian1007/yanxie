import type { TodoPriority } from '@srh/shared';

/**
 * 快速添加的输入解析：
 * - 优先级：`!!!` / `!紧急` / `!急` → 紧急；`!!` / `!高` → 高；`!低` → 低；`!普通` → 普通
 *   （英文 `!urgent` `!high` `!low` `!normal` 也认；全角感叹号同样有效）
 * - 指派：`@名字`，名字要与成员或 agent 的名称完全一致（取最长匹配）
 * 识别出的标记会从标题里去掉。
 */
export interface QuickAddResult {
  title: string;
  priority: TodoPriority | null;
  assigneeId: string | null;
}

const PRIORITY_WORDS: Record<string, TodoPriority> = {
  紧急: 'urgent',
  急: 'urgent',
  urgent: 'urgent',
  高: 'high',
  high: 'high',
  低: 'low',
  low: 'low',
  普通: 'normal',
  normal: 'normal',
};

const PRIORITY_TOKEN = /(^|\s)([!！]{1,3})(紧急|急|高|低|普通|urgent|high|low|normal)?(?=\s|$)/giu;

function bangPriority(bangs: number): TodoPriority | null {
  if (bangs >= 3) return 'urgent';
  if (bangs === 2) return 'high';
  return null;
}

/**
 * 从 @ 选择器里选好指派对象后，去掉输入框末尾正在输入的「@…」（例如「@」「@王」），
 * 否则它会原样留在标题里。只去掉最后一个、且在词首的 @ 标记。
 */
export function stripPendingMention(input: string): string {
  return input.replace(/(^|\s)[@＠][^\s@＠]*\s*$/u, '$1').trimEnd();
}

export function parseQuickAdd(
  input: string,
  assignees: readonly { value: string; label: string }[] = [],
): QuickAddResult {
  let text = ` ${input} `;
  let priority: TodoPriority | null = null;

  text = text.replace(PRIORITY_TOKEN, (match, lead: string, bangs: string, word?: string) => {
    const p = word ? PRIORITY_WORDS[word.toLowerCase()] : bangPriority(bangs.length);
    if (!p) return match;
    priority = p;
    return lead;
  });

  let assigneeId: string | null = null;
  const byLength = [...assignees]
    .filter((a) => a.label.trim())
    .sort((a, b) => b.label.length - a.label.length);
  for (const a of byLength) {
    const token = `@${a.label}`;
    const at = text.indexOf(token);
    if (at === -1) continue;
    const before = text[at - 1];
    const after = text[at + token.length];
    if (
      (before === undefined || /\s/u.test(before)) &&
      (after === undefined || /\s/u.test(after))
    ) {
      assigneeId = a.value;
      text = `${text.slice(0, at)}${text.slice(at + token.length)}`;
      break;
    }
  }

  return { title: text.replace(/\s+/gu, ' ').trim(), priority, assigneeId };
}
