/**
 * 从汇报正文里抽出“下期计划”的条目（拆成待办用）。与服务端 extractPlanItems 同语义：
 *
 * 1. 计划小节的标题：markdown 标题（`#`–`######`），或整行加粗（`**下周计划**`），
 *    去掉序号（“四、” “4.” “(4)”）与末尾冒号后，包含下列任一关键词（英文不区分大小写）：
 *    下期计划、下周计划、下阶段计划、下一阶段计划、下月计划、后续计划、下一步、下步计划、
 *    next steps、next step、next week、plans for next、todo next
 * 2. 小节范围：到下一个同级或更高级的 markdown 标题为止（加粗伪标题的小节到任意下一个标题或加粗伪标题为止）。
 * 3. 条目：小节里缩进最浅的一层列表项（`-` `*` `+` `1.` `1)`，可带任务框 `[ ]` / `[x]`）；
 *    更深的子项视为说明，不单独成条。
 * 4. 清洗：去掉加粗/斜体/行内代码记号与首尾空白；丢弃空条目；按出现顺序去重；
 *    每条最长 200 字，最多 50 条。多个计划小节的条目依次合并。
 */

// i18n-ignore-file 报告正文里的标题与人名是数据（AI 生成的中文），按原文匹配
const PLAN_KEYWORDS = [
  '下期计划',
  '下周计划',
  '下阶段计划',
  '下一阶段计划',
  '下月计划',
  '后续计划',
  '下一步',
  '下步计划',
  'next steps',
  'next step',
  'next week',
  'plans for next',
  'todo next',
];

export const MAX_PLAN_ITEMS = 50;
export const MAX_PLAN_TITLE = 200;

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:：]?\s*$/u;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/u;
const FENCE = /^\s*(```|~~~)/u;

function normalizeHeading(text: string): string {
  return text
    .replace(/[*_`]/gu, '')
    .replace(/^\s*(?:[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[、.．)]?|[(（]\d+[)）])\s*/u, '')
    .replace(/[:：]\s*$/u, '')
    .trim()
    .toLowerCase();
}

export function isPlanHeading(text: string): boolean {
  const t = normalizeHeading(text);
  return PLAN_KEYWORDS.some((k) => t.includes(k));
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1') // [文字](#id) → 文字
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1') // 引用式链接
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/__(.+?)__/gu, '$1')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/gu, '$1$2')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 一个计划条目：标题 + 正文里写到的负责人名字（没有为 null） */
export interface PlanItem {
  title: string;
  owner: string | null;
}

const NAME = '([^\\s，,。；;、：:（）()]{1,20})';
const OWNER_PATTERNS = [
  // （负责人：张三）/(负责: 张三)
  new RegExp(`\\s*[（(]\\s*负责人?\\s*[:：为是]?\\s*${NAME}\\s*[）)]`, 'u'),
  // 负责人小模 / 负责人：小模 / 负责人为小模
  new RegExp(`[，,；;。\\s]*负责人\\s*[:：为是]?\\s*${NAME}`, 'u'),
  // 由张三负责
  new RegExp(`[，,；;。\\s]*由\\s*${NAME}\\s*负责`, 'u'),
];

/**
 * 清洗一条计划：
 * - `[文字](#id)` 链接、加粗、代码等 markdown 记号只留文字
 * - 开头的 `@某人`、「负责人X」「（负责人：X）」「由X负责」→ 记为负责人，从标题里去掉
 * - 「来源为…」「（来源：…）」等来源注记整段去掉（它们是给人看的出处，不是待办内容）
 */
export function parsePlanItem(raw: string): PlanItem {
  let text = stripMarkdown(raw);
  let owner: string | null = null;

  const at = /^@([^\s:：,，、]+)[\s:：,，、]*/u.exec(text);
  if (at) {
    owner = at[1] ?? null;
    text = text.slice(at[0].length);
  }
  for (const re of OWNER_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    owner ??= m[1] ?? null;
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  }
  // 来源注记：括号里的整段，或从「来源」起到结尾
  text = text.replace(/\s*[（(]\s*来源[^）)]*[）)]/gu, '');
  text = text.replace(/[，,；;。\s]*(?:数据)?来源(?:于|为|是|[:：])[\s\S]*$/u, '');

  text = text
    .replace(/^[\s:：\-–—，,]+/u, '')
    .replace(/[\s，,；;：:、]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_PLAN_TITLE);
  return { title: text, owner };
}

function cleanItem(text: string): string {
  return parsePlanItem(text).title;
}

/**
 * 负责人名字 → 指派对象：先精确匹配名字，再匹配包含关系（「王导」↔「王导师」、「小模」↔「小模同学」）；
 * 只有唯一一个候选时才返回，拿不准就不预填。
 */
export function matchAssignee(
  owner: string | null,
  options: readonly { value: string; label: string }[],
): string | null {
  const name = owner?.trim().replace(/^@/u, '');
  if (!name) return null;
  const exact = options.filter((o) => o.label === name);
  if (exact.length === 1) return exact[0]?.value ?? null;
  const loose = options.filter((o) => o.label.includes(name) || name.includes(o.label));
  return loose.length === 1 ? (loose[0]?.value ?? null) : null;
}

/** 抽出计划条目并保留负责人（拆成待办对话框用） */
export function extractPlanEntries(markdown: string): PlanItem[] {
  const owners = new Map<string, string | null>();
  for (const line of markdown.split(/\r?\n/u)) {
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const parsed = parsePlanItem(item[2] ?? '');
    if (parsed.title && !owners.has(parsed.title)) owners.set(parsed.title, parsed.owner);
  }
  return extractPlanItems(markdown).map((title) => ({ title, owner: owners.get(title) ?? null }));
}

function indentWidth(s: string): number {
  return s.replace(/\t/gu, '    ').length;
}

export function extractPlanItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  const seen = new Set<string>();

  /** 当前小节：level = markdown 标题级别；伪标题记作 7（任何标题都会结束它） */
  let section: { level: number; items: { indent: number; text: string }[] } | null = null;
  let inFence = false;

  const flush = () => {
    if (!section) return;
    const minIndent = Math.min(...section.items.map((i) => i.indent));
    for (const item of section.items) {
      if (item.indent !== minIndent) continue;
      const text = cleanItem(item.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    section = null;
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(line);
    const bold = heading ? null : BOLD_LINE.exec(line);
    if (heading || bold) {
      const level = heading ? (heading[1]?.length ?? 1) : 7;
      const text = heading ? (heading[2] ?? '') : (bold?.[1] ?? '');
      if (section) {
        const ends = section.level === 7 || (heading !== null && level <= section.level);
        if (!ends) continue;
        flush();
      }
      if (!section && isPlanHeading(text)) section = { level, items: [] };
      continue;
    }

    if (!section) continue;
    const item = LIST_ITEM.exec(line);
    if (item) section.items.push({ indent: indentWidth(item[1] ?? ''), text: item[2] ?? '' });
  }
  flush();

  return out.slice(0, MAX_PLAN_ITEMS);
}
