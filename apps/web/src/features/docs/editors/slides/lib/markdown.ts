import {
  inferSlideLayout,
  parseSlideDrafts,
  splitSlideColumns,
  SLIDE_DRAFT_LAYOUTS,
  type SlideDraft as SharedSlideDraft,
  type SlideDraftLayout,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 幻灯片 ⇄ Markdown。
 *
 * 解析（parseSlidesMarkdown）与服务端（create_document、AI action 'slides'、agent 写入）共用
 * @srh/shared 的 slides-collab.ts，规则写在那份文件顶部，要点：
 * - `---` 单独一行是分页符（Marp / Slidev），`#` / `##` 也开新页，混用不会多出空页；开头的 front-matter 去掉。
 * - `>` 行、非指令的 `<!-- … -->` 注释、`备注：` / `Note:` 开头的段落是演讲者备注。
 * - `<!-- layout: title|content|two-column|section -->` 显式指定版式；否则按内容推断（只有封面 / 只有一行副标题
 *   的页才是标题页）；两栏只认 `|||` / `::right::`，`---` 不再是两栏分隔符。
 * - 插入时 Markdown 表格变成表格元素、长正文缩小字号或拆成「（续）」页（见 model/index.ts 的 draftToSlides）。
 *
 * 导出（slidesToMarkdown）：每页 `## 标题`；版式与推断结果不同时写 `<!-- layout: x -->`；然后正文；
 * 备注每行加 `> `；页与页之间空一行。导出后再解析得到相同的页（往返稳定）。
 */

export type SlideLayout = SlideDraftLayout;
export type SlideDraft = SharedSlideDraft;

export const SLIDE_LAYOUTS: readonly SlideLayout[] = SLIDE_DRAFT_LAYOUTS;

export const SLIDE_LAYOUT_LABEL: Record<SlideLayout, string> = {
  title: tr('标题页'),
  content: tr('标题和正文'),
  'two-column': tr('两栏'),
  section: tr('章节页'),
};

export function isLayout(v: unknown): v is SlideLayout {
  return typeof v === 'string' && (SLIDE_LAYOUTS as readonly string[]).includes(v);
}

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a] ?? '').trim() === '') a += 1;
  while (b > a && (lines[b - 1] ?? '').trim() === '') b -= 1;
  return lines.slice(a, b);
}

/** 旧版（v1）页正文是否含两栏分隔行（v1 数据里 `---` 也是分栏） */
export function hasColumnSplit(body: string): boolean {
  return body.split('\n').some((l) => /^\s*(---|\|\|\||::right::)\s*$/u.test(l));
}

/** 旧版（v1）两栏页：按第一行 `---` / `|||` 切成左右两栏（没有分隔行时右栏为空） */
export function splitColumns(body: string): [string, string] {
  return splitSlideColumns(body, true);
}

/** 版式推断（与服务端同一套） */
export function inferLayout(index: number, body: string): SlideLayout {
  return inferSlideLayout(index, body);
}

export function parseSlidesMarkdown(markdown: string): SlideDraft[] {
  return parseSlideDrafts(markdown);
}

export function slidesToMarkdown(
  slides: ReadonlyArray<Omit<SlideDraft, 'layout'> & { layout: string }>,
): string {
  return slides
    .map((s, index) => {
      const out = [s.title.trim() ? `## ${s.title.trim()}` : '##'];
      const body = s.body.replace(/\r\n?/gu, '\n');
      if (
        isLayout(s.layout) &&
        s.layout !== inferLayout(index, trimBlankLines(body.split('\n')).join('\n'))
      ) {
        out.push(`<!-- layout: ${s.layout} -->`);
      }
      const bodyLines = trimBlankLines(body.split('\n'));
      if (bodyLines.length) out.push('', ...bodyLines);
      const notes = trimBlankLines(s.notes.replace(/\r\n?/gu, '\n').split('\n'));
      if (notes.length) out.push('', ...notes.map((n) => (n ? `> ${n}` : '>')));
      return out.join('\n');
    })
    .join('\n\n')
    .concat('\n');
}
