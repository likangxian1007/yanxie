/**
 * 从汇报正文里抽出“下期计划”的条目，供前端“拆成待办”对话框预填。
 *
 * 认的小节标题：下期计划、下周计划、下阶段计划、下一步……、Next steps / Next step（任意级别标题，
 * 可带“5.”“四、”之类的编号）。
 * 小节范围到下一个同级或更高级标题为止；只取列表项（- * + 1. 1) 以及任务列表 [ ]），
 * 去掉 markdown 标记、开头的“@某人”、末尾的“（来源：…）”。
 */
const PLAN_HEADING =
  /^(?:[\d一二三四五六七八九十]+[.、)]?\s*)?(?:下期计划|下周计划|下阶段计划|下一步|next\s+steps?\b)/iu;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)、])\s+(?:\[[ xX]\]\s+)?(.*)$/u;
const MAX_ITEMS = 50;
const MAX_LEN = 200;

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1') // 链接
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1') // 引用式链接
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/gu, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?!\w)/gu, '$1$2')
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function cleanItem(raw: string): string {
  let text = stripInlineMarkdown(raw);
  // 开头的 @某人（可带冒号或空格），可连续多个：@张三 @李四：……
  text = text.replace(/^(?:@[^\s:：,，、]+[\s:：,，、]*)+/u, '');
  // 负责人写法（与前端 features/reports/lib/plan-items.ts 一致）：（负责人：X）/ 负责人X / 由X负责
  text = text
    .replace(/\s*[（(]\s*负责人?\s*[:：为是]?\s*[^\s，,。；;、：:（）()]{1,20}\s*[）)]/u, '')
    .replace(/[，,；;。\s]*负责人\s*[:：为是]?\s*[^\s，,。；;、：:（）()]{1,20}/u, '')
    .replace(/[，,；;。\s]*由\s*[^\s，,。；;、：:（）()]{1,20}\s*负责/u, '');
  // 来源注记：（来源：…）/(来源: …)，或从「来源为 / 来源：」起到结尾
  text = text.replace(/\s*[（(]\s*来源[^）)]*[）)]/gu, '');
  text = text.replace(/[，,；;。\s]*(?:数据)?来源(?:于|为|是|[:：])[\s\S]*$/u, '');
  text = text
    .replace(/^[\s:：\-–—，,]+/u, '')
    .replace(/[\s，,；;：:、]+$/u, '')
    .trim();
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
}

export function extractPlanItems(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const items: string[] = [];
  let level = 0; // 0 = 不在计划小节里
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = heading[1]?.length ?? 1;
      const title = stripInlineMarkdown(heading[2] ?? '');
      if (level > 0 && depth <= level) level = 0;
      if (level === 0 && PLAN_HEADING.test(title)) level = depth;
      continue;
    }
    if (level === 0) continue;
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const text = cleanItem(item[1] ?? '');
    if (!text || items.includes(text)) continue;
    items.push(text);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}
